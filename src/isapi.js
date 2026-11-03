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

module.exports = { Terminal, IsapiError, normalizeEvent, FACE_PASS, FACE_FAIL, DOOR_COMMANDS };
