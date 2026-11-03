const http = require("http");
const crypto = require("crypto");

/*
 * Имитатор DS-K1T671M (прошивка V3.2.30) — по ответам настоящего терминала
 * в клубе 30.10.2026: Digest MD5 qop=auth, дверь только XML (JSON →
 * MessageParametersLack), люди и лица в JSON, поток событий multipart/mixed.
 */
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const REALM = "DS-K1T671M";
const ok = '<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver10/XMLSchema"><statusCode>1</statusCode><statusString>OK</statusString><subStatusCode>ok</subStatusCode></ResponseStatus>';
const xmlErr = (code, sub) =>
  `<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver10/XMLSchema"><statusCode>${code}</statusCode><statusString>Invalid Content</statusString><subStatusCode>${sub}</subStatusCode><errorMsg>${sub}</errorMsg></ResponseStatus>`;
const jsonOk = JSON.stringify({ statusCode: 1, statusString: "OK", subStatusCode: "ok" });
const jsonErr = (sub) => JSON.stringify({ statusCode: 6, statusString: "Invalid Content", subStatusCode: sub, errorMsg: sub });
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000), Buffer.from([0xff, 0xd9])]);

function createFakeTerminal({ user = "admin", password = "secret" } = {}) {
  const state = {
    opens: [],
    users: new Map(),
    faces: new Map(),
    authFailures: 0,
    requests: [],
    streams: new Set(),
    httpHosts: [{ id: "1" }, { id: "2" }],
    serial: 100,
  };

  function authorized(req) {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Digest ")) return false;
    const p = {};
    for (const m of h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]] = m[2] ?? m[3];
    const ha1 = md5(`${p.username}:${REALM}:${password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expect = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    if (p.username === user && p.response === expect) return true;
    state.authFailures += 1;
    return false;
  }

  const send = (res, status, body, type = "application/xml") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      state.requests.push(`${req.method} ${req.url}`);
      if (!authorized(req)) {
        res.writeHead(401, {
          "WWW-Authenticate": `Digest qop="auth", realm="${REALM}", nonce="${crypto.randomBytes(8).toString("hex")}", stale="FALSE"`,
          "Content-Type": "application/xml",
        });
        return res.end(xmlErr(4, "unauthorized"));
      }
      route(req, res, body);
    });
  });

  function route(req, res, body) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const text = body.toString("utf8");

    if (req.method === "GET" && p === "/ISAPI/System/deviceInfo")
      return send(res, 200, "<DeviceInfo><deviceName>Access Controller</deviceName><model>DS-K1T671M</model><serialNumber>FAKE123</serialNumber><macAddress>AC:B9:2F:DE:E1:A3</macAddress><firmwareVersion>V3.2.30</firmwareVersion><firmwareReleasedDate>build 211229</firmwareReleasedDate></DeviceInfo>");
    if (req.method === "GET" && p === "/ISAPI/AccessControl/capabilities")
      return send(res, 200, "<AccessControl><isSupportRemoteControlDoor>true</isSupportRemoteControlDoor><isSupportUserInfo>true</isSupportUserInfo><isSupportFDLib>true</isSupportFDLib><isSupportCaptureFace>true</isSupportCaptureFace><isSupportAcsEvent>true</isSupportAcsEvent></AccessControl>");

    if (req.method === "PUT" && p === "/ISAPI/AccessControl/RemoteControl/door/1") {
      const cmd = /<cmd>([^<]+)<\/cmd>/.exec(text);
      if (!cmd) return send(res, 200, xmlErr(6, "MessageParametersLack"));
      state.opens.push(cmd[1]);
      return send(res, 200, ok);
    }
    if (req.method === "PUT" && p.startsWith("/ISAPI/AccessControl/RemoteControl/door/"))
      return send(res, 200, xmlErr(4, "invalidID"));

    if (req.method === "PUT" && p === "/ISAPI/AccessControl/UserInfo/SetUp") {
      const u = JSON.parse(text).UserInfo;
      state.users.set(u.employeeNo, u);
      return send(res, 200, jsonOk, "application/json");
    }
    if (req.method === "PUT" && p === "/ISAPI/AccessControl/UserInfo/Delete") {
      for (const e of JSON.parse(text).UserInfoDelCond.EmployeeNoList) {
        state.users.delete(e.employeeNo);
        state.faces.delete(e.employeeNo);
      }
      return send(res, 200, jsonOk, "application/json");
    }
    if (req.method === "GET" && p === "/ISAPI/AccessControl/UserInfo/Count")
      return send(res, 200, JSON.stringify({ UserInfoCount: { userNumber: state.users.size } }), "application/json");
    if (req.method === "POST" && p === "/ISAPI/AccessControl/UserInfo/Search") {
      const no = JSON.parse(text).UserInfoSearchCond.EmployeeNoList[0].employeeNo;
      const u = state.users.get(no);
      return send(res, 200, JSON.stringify({ UserInfoSearch: { responseStatusStrg: "OK", numOfMatches: u ? 1 : 0, UserInfo: u ? [{ ...u, numOfFace: state.faces.has(no) ? 1 : 0 }] : [] } }), "application/json");
    }
    if (req.method === "POST" && p === "/ISAPI/Intelligent/FDLib/FaceDataRecord") {
      const meta = JSON.parse(/\{[^}]*"FPID"[^}]*\}/.exec(text)[0]);
      const i = body.indexOf(Buffer.from([0xff, 0xd8]));
      if (i < 0) return send(res, 200, jsonErr("badJpeg"), "application/json");
      if (state.faces.has(meta.FPID)) return send(res, 200, jsonErr("deviceUserAlreadyExistFace"), "application/json");
      state.faces.set(meta.FPID, true);
      return send(res, 200, jsonOk, "application/json");
    }
    if (req.method === "PUT" && p === "/ISAPI/Intelligent/FDLib/FDSearch/Delete") {
      for (const f of JSON.parse(text).FPID) state.faces.delete(f.value);
      return send(res, 200, jsonOk, "application/json");
    }
    if (req.method === "POST" && p === "/ISAPI/AccessControl/CaptureFaceData") {
      const b = "captureBoundary";
      res.writeHead(200, { "Content-Type": `multipart/mixed; boundary=${b}` });
      const xml = Buffer.from("<CaptureFaceData><captureProgress>100</captureProgress></CaptureFaceData>");
      res.write(`--${b}\r\nContent-Type: application/xml\r\nContent-Length: ${xml.length}\r\n\r\n`);
      res.write(xml);
      res.write(`\r\n--${b}\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`);
      res.write(JPEG);
      return res.end(`\r\n--${b}--\r\n`);
    }
    if (req.method === "GET" && p === "/ISAPI/Event/notification/alertStream") {
      res.writeHead(200, { "Content-Type": "multipart/mixed; boundary=boundary" });
      res.write("\r\n");
      state.streams.add(res);
      res.on("close", () => state.streams.delete(res));
      return;
    }
    if (req.method === "GET" && p === "/ISAPI/Event/notification/httpHosts") {
      const items = state.httpHosts
        .map((h) => `<HttpHostNotification><id>${h.id}</id>${h.ip ? `<ipAddress>${h.ip}</ipAddress><portNo>${h.port}</portNo>` : ""}</HttpHostNotification>`)
        .join("");
      return send(res, 200, `<HttpHostNotificationList>${items}</HttpHostNotificationList>`);
    }
    if (req.method === "PUT" && p.startsWith("/ISAPI/Event/notification/httpHosts/")) {
      const id = p.split("/").pop();
      const h = state.httpHosts.find((x) => x.id === id);
      h.ip = /<ipAddress>([^<]+)/.exec(text)[1];
      h.port = Number(/<portNo>([^<]+)/.exec(text)[1]);
      return send(res, 200, ok);
    }
    send(res, 404, xmlErr(4, "notSupport"));
  }

  // Событие прохода — как шлёт терминал: JSON-часть с Content-Length.
  function eventJson({ employeeNo, name = "Тест", minor = 75, serialNo } = {}) {
    return JSON.stringify({
      ipAddress: "192.168.0.90",
      dateTime: "2026-11-02T10:00:00+05:00",
      activePostCount: 1,
      eventType: "AccessControllerEvent",
      eventState: "active",
      eventDescription: "Access Controller Event",
      AccessControllerEvent: {
        deviceName: "Access Controller",
        majorEventType: 5,
        subEventType: minor,
        name,
        cardReaderNo: 1,
        employeeNoString: employeeNo,
        serialNo: serialNo ?? (state.serial += 1),
        userType: "normal",
        currentVerifyMode: "face",
      },
    });
  }

  function emit(ev) {
    const j = Buffer.from(typeof ev === "string" ? ev : eventJson(ev));
    for (const s of state.streams) {
      s.write(`--boundary\r\nContent-Type: application/json; charset="UTF-8"\r\nContent-Length: ${j.length}\r\n\r\n`);
      // Режем пополам — как приходит по сети кусками.
      s.write(j.subarray(0, 10));
      s.write(Buffer.concat([j.subarray(10), Buffer.from("\r\n")]));
    }
    return state.streams.size;
  }

  function heartbeat() {
    emit(JSON.stringify({ ipAddress: "192.168.0.90", eventType: "heartBeat", eventState: "active" }));
  }

  function dropStreams() {
    for (const s of state.streams) s.destroy();
  }

  return {
    state,
    emit,
    eventJson,
    heartbeat,
    dropStreams,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () => {
      dropStreams();
      return new Promise((r) => server.close(r));
    },
    JPEG,
  };
}

module.exports = { createFakeTerminal };
