const crypto = require("crypto");
const { DigestClient } = require("./http");
const { parseAll, boundaryOf, build } = require("./multipart");

/*
 * Терминал Hikvision по ISAPI. Только то, что нужно турникету: сведения,
 * дверь, люди, лица, снимок лица, события.
 *
 * Форматы — как принимает DS-K1T671M (прошивка V3.2.30, проверено в клубе
 * 30.10.2026): дверь — только XML (на JSON отвечает MessageParametersLack),
 * люди и лица — JSON (?format=json).
 */
const NS = 'xmlns="http://www.isapi.org/ver20/XMLSchema"';
const DOOR_COMMANDS = ["open", "close", "alwaysOpen", "alwaysClose", "resume"];
const FACE_MAX_BYTES = 200 * 1024;
const EMPLOYEE_RE = /^[A-Za-z0-9_-]{1,32}$/;

class IsapiError extends Error {
  constructor(message, { status, subStatusCode } = {}) {
    super(message);
    this.name = "IsapiError";
    this.status = status;
    this.subStatusCode = subStatusCode || null;
  }
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml || "");
  return m ? m[1] : null;
};
const num = (v) => (v == null || v === "" ? null : Number(v));

// Ответ терминала: ResponseStatus (XML или JSON) или документ с данными.
function statusOf(res) {
  const text = res.body ? res.body.toString("utf8") : "";
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      return { statusCode: num(j.statusCode), sub: j.subStatusCode || null, msg: j.errorMsg || j.statusString || null, json: j, text };
    } catch {
      /* не JSON — как текст */
    }
  }
  return { statusCode: num(tag(t, "statusCode")), sub: tag(t, "subStatusCode"), msg: tag(t, "errorMsg") || tag(t, "statusString"), text };
}

function ensureOk(res, what) {
  const s = statusOf(res);
  const bad = res.status >= 400 || (s.statusCode != null && s.statusCode !== 1 && s.statusCode !== 0);
  if (bad)
    throw new IsapiError(`${what}: ${s.sub || s.msg || `HTTP ${res.status}`}`, {
      status: res.status,
      subStatusCode: s.sub,
    });
  return s;
}

// Время терминала — местное, «ГГГГ-ММ-ДДTчч:мм:сс».
function localTime(v, fallback) {
  if (!v) return fallback;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00`;
  throw new Error(`Время «${s}»: нужен формат ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTчч:мм:сс`);
}

/*
 * Срок доступа человека в терминале — состояние, которое держит ADI:
 *   open|с|по — пускать с … по … (местное время терминала);
 *   closed    — не пускать: окно в прошлом, терминал узнаёт лицо и пишет
 *               «срок истёк»;
 *   free      — без срока, как было в терминале до ADI.
 */
const LOCAL_RE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}";
const OPEN_RE = new RegExp(`^open\\|(${LOCAL_RE})\\|(${LOCAL_RE})$`);
function validOf(state) {
  const s = String(state || "");
  if (s === "closed") return { enable: true, beginTime: "2020-01-01T00:00:00", endTime: "2020-01-01T00:00:01", timeType: "local" };
  if (s === "free") return { enable: false, beginTime: "2020-01-01T00:00:00", endTime: "2037-12-31T23:59:59", timeType: "local" };
  const m = OPEN_RE.exec(s);
  if (!m || m[1] > m[2]) throw new Error(`Срок «${s}»: нужно closed, free или open|с|по`);
  return { enable: true, beginTime: m[1], endTime: m[2], timeType: "local" };
}

/*
 * Расписание входа (часы абонемента): days = { mon: [[с, по]], … } — минуты от
 * полуночи, «по» включительно (до 13:00 — значит до 13:00:59), до 8 отрезков в
 * день. Пустой день — вход закрыт.
 */
const WEEK = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const two = (n) => String(n).padStart(2, "0");
const clock = (min, end) => `${two(Math.floor(min / 60))}:${two(min % 60)}:${end ? "59" : "00"}`;
function weekPlanOf(days) {
  const out = [];
  for (const [key, week] of Object.entries(WEEK)) {
    const segs = Array.isArray(days?.[key]) ? days[key] : [];
    if (segs.length > 8) throw new Error(`Расписание: в ${week} больше 8 отрезков`);
    for (const seg of segs) {
      const [s, e] = seg || [];
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 1439 || s > e)
        throw new Error(`Расписание: неверный отрезок ${JSON.stringify(seg)}`);
    }
    for (let id = 1; id <= 8; id += 1) {
      const seg = segs[id - 1];
      out.push({
        week,
        id,
        enable: Boolean(seg),
        TimeSegment: seg
          ? { beginTime: clock(seg[0]), endTime: clock(seg[1], true) }
          : { beginTime: "00:00:00", endTime: "00:00:00" },
      });
    }
  }
  return out;
}

function checkEmployeeNo(v) {
  const s = String(v ?? "");
  if (!EMPLOYEE_RE.test(s)) throw new Error("employeeNo: латиница, цифры, _ и -, до 32 символов");
  return s;
}

class Terminal {
  constructor({ id, host, port = 80, https = false, user = "admin", password, door = 1, timeoutMs }) {
    this.id = id;
    this.host = host;
    this.door = door;
    this.client = new DigestClient({ host, port, https, user, password, timeoutMs });
  }

  req(method, uri, opts) {
    return this.client.request(method, uri, opts);
  }

  async deviceInfo() {
    const res = await this.req("GET", "/ISAPI/System/deviceInfo");
    ensureOk(res, "Сведения об устройстве");
    const x = res.body.toString("utf8");
    return {
      model: tag(x, "model"),
      serialNumber: tag(x, "serialNumber"),
      firmware: tag(x, "firmwareVersion"),
      firmwareDate: tag(x, "firmwareReleasedDate"),
      name: tag(x, "deviceName"),
      mac: tag(x, "macAddress"),
    };
  }

  async capabilities() {
    const res = await this.req("GET", "/ISAPI/AccessControl/capabilities");
    ensureOk(res, "Возможности");
    const x = res.body.toString("utf8");
    const yes = (name) => new RegExp(`<${name}>true</${name}>`).test(x);
    return {
      remoteControlDoor: yes("isSupportRemoteControlDoor"),
      remoteCheck: yes("isSupportRemoteCheck"),
      captureFace: yes("isSupportCaptureFace"),
      userInfo: yes("isSupportUserInfo"),
      faceLib: yes("isSupportFDLib"),
      acsEvent: yes("isSupportAcsEvent"),
    };
  }

  async doorCommand(cmd) {
    if (!DOOR_COMMANDS.includes(cmd)) throw new Error(`Команда двери: ${DOOR_COMMANDS.join(", ")}`);
    const res = await this.req("PUT", `/ISAPI/AccessControl/RemoteControl/door/${this.door}`, {
      body: `<RemoteControlDoor><cmd>${cmd}</cmd></RemoteControlDoor>`,
      contentType: "application/xml",
    });
    ensureOk(res, `Дверь (${cmd})`);
    return { ok: true };
  }

  async userCount() {
    const res = await this.req("GET", "/ISAPI/AccessControl/UserInfo/Count?format=json");
    const s = ensureOk(res, "Количество людей");
    return { users: num(s.json?.UserInfoCount?.userNumber) };
  }

  /*
   * Добавить или изменить человека (SetUp — upsert). employeeNo — наш id
   * пользователя. Срок validFrom..validTo — по датам абонемента: без связи с
   * ADI терминал сам не пустит того, у кого срок вышел.
   */
  async userUpsert({ employeeNo, name, validFrom, validTo, planTemplate = "1" }) {
    const UserInfo = {
      employeeNo: checkEmployeeNo(employeeNo),
      // Экран терминала узкий, а лимит имени у прошивок разный — 32 символа надёжно.
      name: String(name || "").trim().slice(0, 32) || String(employeeNo),
      userType: "normal",
      Valid: {
        enable: true,
        beginTime: localTime(validFrom, "2000-01-01T00:00:00"),
        endTime: localTime(validTo, "2037-12-31T23:59:59"),
        timeType: "local",
      },
      doorRight: String(this.door),
      RightPlan: [{ doorNo: this.door, planTemplateNo: String(planTemplate) }],
    };
    const res = await this.req("PUT", "/ISAPI/AccessControl/UserInfo/SetUp?format=json", {
      body: JSON.stringify({ UserInfo }),
      contentType: "application/json",
    });
    ensureOk(res, "Человек");
    return { ok: true, employeeNo: UserInfo.employeeNo };
  }

  /*
   * Новый человек из ADI. Record, а не SetUp: если номер уже занят (человека
   * завели в меню терминала), терминал откажет employeeNoAlreadyExist, а не
   * перезапишет чужую запись. ADI тогда берёт следующий номер.
   */
  async userAdd({ employeeNo, name, valid, plan = "1" }) {
    const UserInfo = {
      employeeNo: checkEmployeeNo(employeeNo),
      name: String(name || "").trim().slice(0, 32) || String(employeeNo),
      userType: "normal",
      Valid: validOf(valid),
      doorRight: String(this.door),
      RightPlan: [{ doorNo: this.door, planTemplateNo: String(plan) }],
    };
    const res = await this.req("POST", "/ISAPI/AccessControl/UserInfo/Record?format=json", {
      body: JSON.stringify({ UserInfo }),
      contentType: "application/json",
    });
    ensureOk(res, "Новый человек");
    return { ok: true, employeeNo: UserInfo.employeeNo };
  }

  /*
   * Поменять срок доступа и, если передан plan, расписание (номер шаблона).
   * Имя и остальное не трогаем: Modify меняет переданные поля, а имя и тип
   * берём из самой записи (без них прошивки отвечают «не хватает параметров»).
   * items: [{ employeeNo, valid, plan? }] → [{ employeeNo, ok, prevPlan?, error? }]
   */
  async userSetValid(items) {
    const list = (Array.isArray(items) ? items : []).slice(0, 50);
    const out = [];
    for (const it of list) {
      try {
        const employeeNo = checkEmployeeNo(it.employeeNo);
        const Valid = validOf(it.valid);
        const u = await this.userRecord(employeeNo);
        if (!u) {
          out.push({ employeeNo, ok: false, code: "notFound", error: "Нет на терминале" });
          continue;
        }
        const UserInfo = { employeeNo, name: u.name || employeeNo, userType: u.userType || "normal", Valid };
        if (u.doorRight) UserInfo.doorRight = u.doorRight;
        if (Array.isArray(u.RightPlan)) UserInfo.RightPlan = u.RightPlan;
        const prev = (u.RightPlan || []).find((r) => Number(r.doorNo) === Number(this.door));
        if (it.plan != null) {
          if (!/^\d{1,3}$/.test(String(it.plan))) throw new Error(`Расписание «${it.plan}»: нужен номер шаблона`);
          UserInfo.doorRight = String(this.door);
          UserInfo.RightPlan = [{ doorNo: this.door, planTemplateNo: String(it.plan) }];
        }
        const res = await this.req("PUT", "/ISAPI/AccessControl/UserInfo/Modify?format=json", {
          body: JSON.stringify({ UserInfo }),
          contentType: "application/json",
        });
        ensureOk(res, "Срок доступа");
        out.push({ employeeNo, ok: true, prevPlan: prev?.planTemplateNo != null ? String(prev.planTemplateNo) : null });
      } catch (err) {
        // Блокировка входа или нет связи — дальше по списку идти бессмысленно.
        if (err.name === "BlockedError" || err.name === "AuthError" || !(err instanceof IsapiError || /Срок|Расписание|employeeNo/.test(err.message)))
          throw err;
        out.push({ employeeNo: String(it.employeeNo), ok: false, code: err.subStatusCode || null, error: err.message });
      }
    }
    return out;
  }

  /*
   * Завести расписание: недельный план N и шаблон прав N с именем «ADI-…».
   * Шаблон, который завёл клуб (включён и имя не «ADI…»), не перезаписываем —
   * ошибка с кодом occupied, ADI возьмёт следующий номер.
   */
  async planSet({ no, name, days }) {
    const n = Number(no);
    if (!Number.isInteger(n) || n < 2 || n > 255) throw new Error("Номер расписания: от 2 до 255");
    const title = String(name || "");
    if (!/^ADI/.test(title)) throw new Error("Имя расписания должно начинаться с ADI");
    const WeekPlanCfg = weekPlanOf(days);
    const cur = await this.req("GET", `/ISAPI/AccessControl/UserRightPlanTemplate/${n}?format=json`);
    const t = cur.status === 200 ? statusOf(cur).json?.UserRightPlanTemplate : null;
    if (t && t.enable && t.templateName && !/^ADI/.test(t.templateName))
      throw new IsapiError(`Шаблон ${n} в терминале занят («${t.templateName}»)`, { subStatusCode: "occupied" });
    ensureOk(
      await this.req("PUT", `/ISAPI/AccessControl/UserRightWeekPlanCfg/${n}?format=json`, {
        body: JSON.stringify({ UserRightWeekPlanCfg: { enable: true, WeekPlanCfg } }),
        contentType: "application/json",
      }),
      "Недельный план",
    );
    ensureOk(
      await this.req("PUT", `/ISAPI/AccessControl/UserRightPlanTemplate/${n}?format=json`, {
        body: JSON.stringify({
          UserRightPlanTemplate: { enable: true, templateName: title.slice(0, 32), weekPlanNo: n, holidayGroupNo: "" },
        }),
        contentType: "application/json",
      }),
      "Шаблон расписания",
    );
    return { ok: true, no: n };
  }

  async userRecord(employeeNo) {
    const res = await this.req("POST", "/ISAPI/AccessControl/UserInfo/Search?format=json", {
      body: JSON.stringify({
        UserInfoSearchCond: {
          searchID: crypto.randomUUID(),
          searchResultPosition: 0,
          maxResults: 1,
          EmployeeNoList: [{ employeeNo: checkEmployeeNo(employeeNo) }],
        },
      }),
      contentType: "application/json",
    });
    const s = ensureOk(res, "Поиск человека");
    return s.json?.UserInfoSearch?.UserInfo?.[0] || null;
  }

  async userGet(employeeNo) {
    const res = await this.req("POST", "/ISAPI/AccessControl/UserInfo/Search?format=json", {
      body: JSON.stringify({
        UserInfoSearchCond: {
          searchID: crypto.randomUUID(),
          searchResultPosition: 0,
          maxResults: 1,
          EmployeeNoList: [{ employeeNo: checkEmployeeNo(employeeNo) }],
        },
      }),
      contentType: "application/json",
    });
    const s = ensureOk(res, "Поиск человека");
    const u = s.json?.UserInfoSearch?.UserInfo?.[0];
    if (!u) return null;
    return {
      employeeNo: u.employeeNo,
      name: u.name,
      validFrom: u.Valid?.beginTime || null,
      validTo: u.Valid?.endTime || null,
      faces: num(u.numOfFace),
    };
  }

  /*
   * Все люди терминала — постранично по 30 (больше терминал не отдаёт), с
   * одним searchID на весь обход. Нужно, чтобы связать уже внесённых в
   * терминал людей (у них свои номера) с клиентами ADI.
   */
  async userList({ onPage } = {}) {
    const searchID = crypto.randomUUID();
    const out = [];
    for (let pos = 0; ; ) {
      const res = await this.req("POST", "/ISAPI/AccessControl/UserInfo/Search?format=json", {
        body: JSON.stringify({ UserInfoSearchCond: { searchID, searchResultPosition: pos, maxResults: 30 } }),
        contentType: "application/json",
      });
      const s = ensureOk(res, "Список людей");
      const r = s.json?.UserInfoSearch || {};
      const page = Array.isArray(r.UserInfo) ? r.UserInfo : [];
      for (const u of page)
        out.push({
          employeeNo: String(u.employeeNo),
          name: u.name || "",
          userType: u.userType || null,
          validFrom: u.Valid?.beginTime || null,
          validTo: u.Valid?.endTime || null,
          validEnabled: u.Valid?.enable ?? null,
          faces: num(u.numOfFace),
          cards: num(u.numOfCard),
        });
      onPage?.(out.length, num(r.totalMatches));
      if (!page.length || r.responseStatusStrg !== "MORE") break;
      pos += page.length;
    }
    return out;
  }

  // По 30 за раз — столько принимает терминал.
  async userDelete(employeeNos) {
    const list = [...new Set((Array.isArray(employeeNos) ? employeeNos : [employeeNos]).map(checkEmployeeNo))];
    for (let i = 0; i < list.length; i += 30) {
      const res = await this.req("PUT", "/ISAPI/AccessControl/UserInfo/Delete?format=json", {
        body: JSON.stringify({
          UserInfoDelCond: { EmployeeNoList: list.slice(i, i + 30).map((employeeNo) => ({ employeeNo })) },
        }),
        contentType: "application/json",
      });
      ensureOk(res, "Удаление людей");
    }
    return { deleted: list.length };
  }

  /*
   * Фото лица человека: JPEG до 200 КБ, одно лицо анфас. Уменьшает и
   * проверяет фото ADI — агент только передаёт. Если лицо уже есть —
   * удаляем старое и загружаем заново.
   */
  async faceUpload(employeeNo, jpeg) {
    const id = checkEmployeeNo(employeeNo);
    if (!Buffer.isBuffer(jpeg) || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Фото должно быть JPEG");
    if (jpeg.length > FACE_MAX_BYTES)
      throw new Error(`Фото ${Math.round(jpeg.length / 1024)} КБ — терминал принимает до 200 КБ`);
    const send = () => {
      const { body, contentType } = build([
        {
          name: "FaceDataRecord",
          contentType: "application/json",
          body: JSON.stringify({ faceLibType: "blackFD", FDID: "1", FPID: id }),
        },
        { name: "FaceImage", filename: "face.jpg", contentType: "image/jpeg", body: jpeg },
      ]);
      return this.req("POST", "/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json", { body, contentType });
    };
    try {
      ensureOk(await send(), "Фото лица");
    } catch (err) {
      if (!(err instanceof IsapiError) || !/exist/i.test(err.subStatusCode || err.message)) throw err;
      await this.faceDelete(id);
      ensureOk(await send(), "Фото лица");
    }
    return { ok: true };
  }

  async faceDelete(employeeNo) {
    const res = await this.req(
      "PUT",
      "/ISAPI/Intelligent/FDLib/FDSearch/Delete?format=json&FDID=1&faceLibType=blackFD",
      { body: JSON.stringify({ FPID: [{ value: checkEmployeeNo(employeeNo) }] }), contentType: "application/json" },
    );
    ensureOk(res, "Удаление фото");
    return { ok: true };
  }

  /*
   * Снять лицо камерой терминала: терминал включает съёмку, человек смотрит в
   * камеру, приходит JPEG. Ответ бывает multipart (XML + картинка) или XML со
   * ссылкой на картинку; если съёмка не закончена — ждём по Progress.
   * TODO на месте: проверить, какой из вариантов отдаёт V3.2.30.
   */
  async faceCapture({ timeoutMs = 30000 } = {}) {
    const res = await this.req("POST", "/ISAPI/AccessControl/CaptureFaceData", {
      body: `<CaptureFaceDataCond version="2.0" ${NS}><captureInfrared>false</captureInfrared><dataType>binary</dataType></CaptureFaceDataCond>`,
      contentType: "application/xml",
      timeoutMs,
    });
    const boundary = boundaryOf(res.headers["content-type"]);
    if (res.status === 200 && boundary) {
      const parts = parseAll(res.body, boundary);
      const img = parts.find((p) => p.body[0] === 0xff && p.body[1] === 0xd8);
      if (img) return img.body;
      const xml = parts.map((p) => p.body.toString("utf8")).join("");
      return this.captureFollowUp(xml, timeoutMs);
    }
    if (res.status === 200 && res.body[0] === 0xff && res.body[1] === 0xd8) return res.body;
    ensureOk(res, "Снимок лица");
    return this.captureFollowUp(res.body.toString("utf8"), timeoutMs);
  }

  async captureFollowUp(xml, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let doc = xml;
    for (;;) {
      const url = tag(doc, "faceDataUrl");
      if (url) return this.download(url);
      const progress = num(tag(doc, "captureProgress"));
      if (progress == null || Date.now() > deadline)
        throw new IsapiError("Снимок лица не получен — человек не посмотрел в камеру или терминал не поддерживает съёмку");
      await new Promise((r) => setTimeout(r, 1000));
      const res = await this.req("GET", "/ISAPI/AccessControl/CaptureFaceData/Progress");
      ensureOk(res, "Ход съёмки");
      doc = res.body.toString("utf8");
    }
  }

  async download(url) {
    const u = new URL(url, `http://${this.host}`);
    const res = await this.req("GET", u.pathname + u.search);
    if (res.status !== 200 || res.body[0] !== 0xff || res.body[1] !== 0xd8)
      throw new IsapiError("Снимок лица не скачался", { status: res.status });
    return res.body;
  }

  // Поток событий: держит соединение, события идут частями multipart/mixed.
  async openAlertStream() {
    const res = await this.req("GET", "/ISAPI/Event/notification/alertStream", {
      stream: true,
      timeoutMs: 15000,
      accept: "multipart/mixed",
    });
    if (!res.stream) ensureOk(res, "Поток событий");
    const boundary = boundaryOf(res.headers["content-type"]);
    if (!boundary) {
      res.stream?.destroy();
      throw new IsapiError("Терминал отдал поток событий не в multipart — нужен режим push");
    }
    return { stream: res.stream, boundary };
  }

  // Куда терминал отправляет события (у этой модели — 2 адреса).
  async httpHosts() {
    const res = await this.req("GET", "/ISAPI/Event/notification/httpHosts");
    ensureOk(res, "Адреса событий");
    const x = res.body.toString("utf8");
    return [...x.matchAll(/<HttpHostNotification[^>]*>([\s\S]*?)<\/HttpHostNotification>/g)].map((m) => ({
      id: tag(m[1], "id"),
      url: tag(m[1], "url"),
      protocol: tag(m[1], "protocolType"),
      ip: tag(m[1], "ipAddress"),
      host: tag(m[1], "hostName"),
      port: num(tag(m[1], "portNo")),
    }));
  }

  async setHttpHost({ id, ip, port, path = "/event" }) {
    const body =
      `<HttpHostNotification version="2.0" ${NS}><id>${id}</id><url>${path}</url>` +
      "<protocolType>HTTP</protocolType><parameterFormatType>JSON</parameterFormatType>" +
      `<addressingFormatType>ipaddress</addressingFormatType><ipAddress>${ip}</ipAddress><portNo>${port}</portNo>` +
      "<httpAuthenticationMethod>none</httpAuthenticationMethod></HttpHostNotification>";
    const res = await this.req("PUT", `/ISAPI/Event/notification/httpHosts/${id}`, {
      body,
      contentType: "application/xml",
    });
    ensureOk(res, "Адрес событий");
    return { ok: true };
  }
}

/*
 * Событие терминала → { terminalId, major, minor, employeeNo, … } или null.
 * Нас интересуют только события контроля доступа; heartBeat и прочее — мимо.
 *   major 5 / minor 75 (0x4b) — лицо узнано, проход разрешён терминалом;
 *   major 5 / minor 76 (0x4c) — лицо не узнано.
 */
const FACE_PASS = 75;
const FACE_FAIL = 76;

function normalizeEvent(payload, terminalId) {
  const t = String(payload || "").trim();
  let e;
  if (t.startsWith("{")) {
    let j;
    try {
      j = JSON.parse(t);
    } catch {
      return null;
    }
    const a = j.AccessControllerEvent || {};
    e = {
      eventType: j.eventType,
      time: j.dateTime || null,
      major: num(a.majorEventType),
      minor: num(a.subEventType),
      employeeNo: a.employeeNoString || (a.employeeNo != null ? String(a.employeeNo) : null),
      name: a.name || null,
      serialNo: num(a.serialNo),
      verifyMode: a.currentVerifyMode || null,
    };
  } else if (t.startsWith("<")) {
    e = {
      eventType: tag(t, "eventType"),
      time: tag(t, "dateTime"),
      major: num(tag(t, "majorEventType")),
      minor: num(tag(t, "subEventType")),
      employeeNo: tag(t, "employeeNoString") || tag(t, "employeeNo"),
      name: tag(t, "name"),
      serialNo: num(tag(t, "serialNo")),
      verifyMode: tag(t, "currentVerifyMode"),
    };
  } else return null;
  if (e.eventType !== "AccessControllerEvent") return null;
  return { terminalId, ...e, employeeNo: e.employeeNo || null };
}

module.exports = { Terminal, IsapiError, normalizeEvent, validOf, FACE_PASS, FACE_FAIL, DOOR_COMMANDS };
