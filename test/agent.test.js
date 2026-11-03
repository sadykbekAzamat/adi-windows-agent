const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createFakeTerminal } = require("./fake-terminal");
const { createFakeAdi } = require("./fake-adi");
const { Terminal } = require("../src/isapi");
const { AuthError, BlockedError, digestChallenge, CHALLENGE_TTL_MS } = require("../src/http");
const { Agent } = require("../src/agent");
const { DEFAULTS } = require("../src/config");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(20);
  }
  return false;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adi-gate-"));

function makeAgent({ termPort, adiPort, decision = {}, events = {}, token = "good-token", password = "secret" }) {
  const dir = tmp();
  const cfg = {
    ...DEFAULTS,
    adi: { url: `ws://127.0.0.1:${adiPort}`, token },
    terminals: [{ id: "entrance", host: "127.0.0.1", port: termPort, user: "admin", password, door: 1 }],
    events: { ...DEFAULTS.events, ...events },
    decision: { ...DEFAULTS.decision, timeoutMs: 400, repeatSeconds: 1, ...decision },
  };
  return { agent: new Agent(cfg, { log: quiet, outboxFile: path.join(dir, "outbox.jsonl") }), dir };
}

test("терминал: Digest, сведения, возможности", async () => {
  const term = createFakeTerminal();
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret" });
    const info = await t.deviceInfo();
    assert.equal(info.model, "DS-K1T671M");
    assert.equal(info.firmware, "V3.2.30");
    const caps = await t.capabilities();
    assert.equal(caps.captureFace, true);
    assert.equal(caps.remoteCheck, false);
    await t.deviceInfo();
    assert.equal(term.state.authFailures, 0);
  } finally {
    await term.close();
  }
});

test("неверный пароль: не больше одной неудачной попытки, потом запросы не идут", async () => {
  const term = createFakeTerminal();
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "wrong" });
    await assert.rejects(() => t.deviceInfo(), AuthError);
    const sent = term.state.requests.length;
    await assert.rejects(() => t.deviceInfo(), BlockedError);
    await assert.rejects(() => t.doorCommand("open"), BlockedError);
    assert.equal(term.state.requests.length, sent, "заблокированный клиент не ходит в терминал");
    assert.ok(term.state.authFailures <= 2, `неудачных попыток ${term.state.authFailures}`);
  } finally {
    await term.close();
  }
});

test("старый nonce: терминал отверг его без нового вызова — агент берёт свежий, пароль не «неверный»", async () => {
  const term = createFakeTerminal({ strictNonce: true });
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret" });
    await t.deviceInfo();
    // Nonce протух (или был от другого соединения — поток событий).
    term.expireNonces();
    await t.doorCommand("open");
    assert.deepEqual(term.state.opens, ["open"]);
    assert.equal(term.state.staleNonces, 1);
    // Сохранённый nonce давно не использовался — сразу за новым, без отказа.
    t.client.challengeAt -= CHALLENGE_TTL_MS + 1000;
    term.expireNonces();
    await t.doorCommand("open");
    assert.equal(term.state.opens.length, 2);
    assert.equal(term.state.staleNonces, 1);
    assert.equal(term.state.authFailures, 0);
    assert.equal(t.client.blockedUntil, 0, "клиент не заблокирован");
  } finally {
    await term.close();
  }
});

test("WWW-Authenticate: Digest находится и рядом с Basic", () => {
  assert.equal(digestChallenge('Digest qop="auth", realm="R", nonce="n1", stale="FALSE"').nonce, "n1");
  const both = digestChallenge('Basic realm="B", Digest qop="auth", realm="R", nonce="n2"');
  assert.equal(both.nonce, "n2");
  assert.equal(both.realm, "R");
  assert.equal(digestChallenge('Digest realm="R", nonce="n3", Basic realm="B"').realm, "R");
  assert.equal(digestChallenge('Basic realm="B"'), null);
  assert.equal(digestChallenge(undefined), null);
});

test("дверь: команда уходит XML (как принимает V3.2.30), лишние команды запрещены", async () => {
  const term = createFakeTerminal();
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret" });
    await t.doorCommand("open");
    await t.doorCommand("close");
    assert.deepEqual(term.state.opens, ["open", "close"]);
    await assert.rejects(() => t.doorCommand("reboot"));
    const t2 = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret", door: 2 });
    await assert.rejects(() => t2.doorCommand("open"), /invalidID/);
  } finally {
    await term.close();
  }
});

test("новый человек из ADI и срок доступа: занятый номер не перезаписывается, Modify меняет только срок", async () => {
  const term = createFakeTerminal();
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret" });
    // Человек, заведённый в меню терминала, со своим расписанием.
    term.state.users.set("A1001", { employeeNo: "A1001", name: "Старый", userType: "normal", doorRight: "1", RightPlan: [{ doorNo: 1, planTemplateNo: "3" }], Valid: { enable: false } });
    await assert.rejects(() => t.userAdd({ employeeNo: "A1001", name: "Новый", valid: "closed" }), (e) => e.subStatusCode === "employeeNoAlreadyExist");
    assert.equal(term.state.users.get("A1001").name, "Старый", "чужая запись не перезаписана");

    await t.userAdd({ employeeNo: "A1002", name: "Иванов Иван", valid: "open|2026-11-01T00:00:00|2026-12-01T23:59:59" });
    assert.deepEqual(term.state.users.get("A1002").Valid, { enable: true, beginTime: "2026-11-01T00:00:00", endTime: "2026-12-01T23:59:59", timeType: "local" });

    const r = await t.userSetValid([
      { employeeNo: "A1001", valid: "closed" },
      { employeeNo: "A1002", valid: "free" },
      { employeeNo: "404", valid: "closed" },
      { employeeNo: "A1002", valid: "open|2026-12-01T00:00:00|2026-11-01T00:00:00" },
    ]);
    assert.deepEqual(r.map((x) => x.ok), [true, true, false, false]);
    assert.equal(r[2].code, "notFound");
    const old = term.state.users.get("A1001");
    assert.equal(old.name, "Старый");
    assert.equal(old.RightPlan[0].planTemplateNo, "3", "расписание не тронуто");
    assert.equal(old.Valid.endTime, "2020-01-01T00:00:01");
    assert.equal(term.state.users.get("A1002").Valid.enable, false);
  } finally {
    await term.close();
  }
});

test("люди и лица: добавить, найти, заменить фото, снять фото, удалить", async () => {
  const term = createFakeTerminal();
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret" });
    await t.userUpsert({ employeeNo: "u1", name: "Айгерим Б", validFrom: "2026-11-01", validTo: "2026-11-30" });
    const u = term.state.users.get("u1");
    assert.equal(u.Valid.beginTime, "2026-11-01T00:00:00");
    assert.equal(u.Valid.endTime, "2026-11-30T00:00:00");
    assert.equal((await t.userCount()).users, 1);
    await t.faceUpload("u1", term.JPEG);
    await t.faceUpload("u1", term.JPEG); // уже есть — заменяется, а не ошибка
    assert.equal((await t.userGet("u1")).faces, 1);
    const shot = await t.faceCapture();
    assert.ok(shot.equals(term.JPEG), "снимок — тот JPEG, что отдал терминал");
    await t.userDelete(["u1"]);
    assert.equal(await t.userGet("u1"), null);
    await assert.rejects(() => t.faceUpload("u1", Buffer.from("not jpeg")), /JPEG/);
    await assert.rejects(() => t.faceUpload("u1", Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(210 * 1024)])), /200 КБ/);
    await assert.rejects(() => t.userUpsert({ employeeNo: "bad id!", name: "x" }), /employeeNo/);
  } finally {
    await term.close();
  }
});

test("режим adi: лицо → ADI решает → дверь; отказ — дверь закрыта; дубли и повторы отсекаются", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi({ decide: (m) => (m.employeeNo === "ok" ? { allow: true } : { allow: false, reason: "Абонемент заморожен" }) });
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const { agent } = makeAgent({ termPort, adiPort });
  try {
    agent.start();
    assert.ok(await until(() => term.state.streams.size === 1 && adi.state.hellos.length === 1));
    assert.ok(await until(() => agent.link.ready));

    term.emit({ employeeNo: "ok", name: "Клиент", serialNo: 1 });
    assert.ok(await until(() => term.state.opens.length === 1), "разрешённому открыли");
    assert.equal(adi.state.requests[0].employeeNo, "ok");
    assert.ok(await until(() => adi.state.events.some((e) => e.kind === "access.opened" && e.opened === true)));

    term.emit({ employeeNo: "frozen", serialNo: 2 });
    assert.ok(await until(() => adi.state.requests.length === 2));
    await sleep(150);
    assert.equal(term.state.opens.length, 1, "замороженному не открыли");

    term.emit({ employeeNo: "ok", serialNo: 1 }); // то же событие повторно
    term.emit({ employeeNo: "ok", serialNo: 3 }); // тот же человек через мгновение
    await sleep(300);
    assert.equal(adi.state.requests.length, 2, "дубль и повтор не ушли в ADI");

    term.heartbeat();
    term.emit(JSON.stringify({ eventType: "AccessControllerEvent", AccessControllerEvent: { majorEventType: 5, subEventType: 76, serialNo: 9 } }));
    await sleep(150);
    assert.equal(adi.state.requests.length, 2, "heartbeat и незнакомое лицо не спрашивают ADI");
  } finally {
    agent.stop();
    await adi.close();
    await term.close();
  }
});

test("нет связи с ADI: deny — не пускаем и копим события; ADI вернулся — очередь доставлена", async () => {
  const term = createFakeTerminal();
  const termPort = await term.listen();
  const adi = createFakeAdi();
  const adiPort = await adi.listen();
  await adi.close(); // ADI «упал»
  const { agent, dir } = makeAgent({ termPort, adiPort, decision: { offline: "deny" } });
  try {
    agent.start();
    assert.ok(await until(() => term.state.streams.size === 1));
    term.emit({ employeeNo: "u1", serialNo: 11 });
    await sleep(200);
    assert.equal(term.state.opens.length, 0);
    const queued = fs.readFileSync(path.join(dir, "outbox.jsonl"), "utf8");
    assert.match(queued, /access\.offline_denied/);

    // ADI снова доступен на том же порту.
    const adi2 = createFakeAdi();
    const http2 = require("ws");
    const wss = new http2.WebSocketServer({ port: adiPort, host: "127.0.0.1" });
    const got = [];
    wss.on("connection", (ws) =>
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === "hello") ws.send('{"type":"welcome"}');
        if (m.type === "event") {
          got.push(m);
          ws.send(JSON.stringify({ type: "ack", id: m.id }));
        }
      }),
    );
    assert.ok(await until(() => got.some((e) => e.kind === "access.offline_denied"), 8000), "очередь доставлена после восстановления");
    assert.ok(await until(() => fs.readFileSync(path.join(dir, "outbox.jsonl"), "utf8").trim() === ""), "подтверждённое удалено из очереди");
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    void adi2;
  } finally {
    agent.stop();
    await term.close();
  }
});

test("ADI не ответил вовремя, offline=allow — пускаем узнанного и сообщаем потом", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi();
  adi.delayMs = 1000; // дольше timeoutMs (400)
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const { agent } = makeAgent({ termPort, adiPort, decision: { offline: "allow" } });
  try {
    agent.start();
    assert.ok(await until(() => term.state.streams.size === 1 && agent.link.ready));
    term.emit({ employeeNo: "u1", serialNo: 21 });
    assert.ok(await until(() => term.state.opens.length === 1), "открыто без ответа ADI");
    assert.ok(await until(() => adi.state.events.some((e) => e.kind === "access.offline" && e.opened)));
  } finally {
    agent.stop();
    await adi.close();
    await term.close();
  }
});

test("режимы terminal и local", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi();
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const a1 = makeAgent({ termPort, adiPort, decision: { mode: "terminal" } }).agent;
  try {
    a1.start();
    assert.ok(await until(() => term.state.streams.size === 1 && a1.link.ready));
    term.emit({ employeeNo: "u1", serialNo: 31, minor: 75 });
    assert.ok(await until(() => adi.state.events.some((e) => e.kind === "access.passed" && e.employeeNo === "u1")));
    assert.equal(term.state.opens.length, 0, "в режиме terminal агент дверь не трогает");
    assert.equal(adi.state.requests.length, 0);
  } finally {
    a1.stop();
  }
  await until(() => term.state.streams.size === 0);
  const a2 = makeAgent({ termPort, adiPort, decision: { mode: "local" } }).agent;
  try {
    a2.start();
    assert.ok(await until(() => term.state.streams.size === 1));
    term.emit({ employeeNo: "u2", serialNo: 32 });
    assert.ok(await until(() => term.state.opens.length === 1), "local — открыл сам");
  } finally {
    a2.stop();
    await adi.close();
    await term.close();
  }
});

test("команды из ADI: разрешённые выполняются, неизвестные — нет", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi();
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const { agent } = makeAgent({ termPort, adiPort });
  try {
    agent.start();
    assert.ok(await until(() => agent.link.ready));
    const c1 = adi.command("door", { cmd: "open" });
    const c2 = adi.command("userUpsert", { employeeNo: "u5", name: "Пятый", validTo: "2026-12-31" });
    const c3 = adi.command("faceUpload", { employeeNo: "u5", imageBase64: term.JPEG.toString("base64") });
    const c4 = adi.command("faceCapture");
    const c5 = adi.command("rawIsapi", { path: "/ISAPI/System/factoryReset" });
    assert.ok(await until(() => [c1, c2, c3, c4, c5].every((id) => adi.state.results.has(id))));
    assert.equal(adi.state.results.get(c1).ok, true);
    assert.deepEqual(term.state.opens, ["open"]);
    assert.equal(term.state.users.get("u5").Valid.endTime, "2026-12-31T00:00:00");
    assert.equal(adi.state.results.get(c3).ok, true);
    assert.ok(Buffer.from(adi.state.results.get(c4).data.imageBase64, "base64").equals(term.JPEG));
    assert.equal(adi.state.results.get(c5).ok, false);
    assert.equal(adi.state.results.get(c5).error.code, "unknown_command");
  } finally {
    agent.stop();
    await adi.close();
    await term.close();
  }
});

test("поток событий оборвался — агент переподключается и снова видит проходы", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi();
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const { agent } = makeAgent({ termPort, adiPort });
  try {
    agent.start();
    assert.ok(await until(() => term.state.streams.size === 1 && agent.link.ready));
    term.dropStreams();
    assert.ok(await until(() => term.state.streams.size === 0));
    assert.ok(await until(() => term.state.streams.size === 1, 5000), "переподключился");
    term.emit({ employeeNo: "u7", serialNo: 41 });
    assert.ok(await until(() => term.state.opens.length === 1));
  } finally {
    agent.stop();
    await adi.close();
    await term.close();
  }
});

test("неверный токен ADI: агент не долбит сервер", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi();
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const { agent } = makeAgent({ termPort, adiPort, token: "stolen" });
  try {
    agent.start();
    assert.ok(await until(() => adi.state.hellos.length === 1));
    await sleep(1500);
    assert.equal(adi.state.hellos.length, 1, "повтор не раньше чем через 10 минут");
    assert.equal(agent.link.ready, false);
  } finally {
    agent.stop();
    await adi.close();
    await term.close();
  }
});

test("push: событие принимается только с IP терминала", async () => {
  const term = createFakeTerminal();
  const adi = createFakeAdi();
  const [termPort, adiPort] = [await term.listen(), await adi.listen()];
  const pushPort = 17000 + Math.floor(Math.random() * 1000);
  const { agent } = makeAgent({ termPort, adiPort, events: { mode: "push", pushPort } });
  const post = (body) =>
    new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: pushPort, method: "POST", path: "/event", headers: { "Content-Type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end(body);
    });
  try {
    agent.start();
    assert.ok(await until(() => agent.link.ready));
    await sleep(100);
    assert.equal(await post(term.eventJson({ employeeNo: "u8", serialNo: 51 })), 200);
    assert.ok(await until(() => term.state.opens.length === 1), "событие с IP терминала (127.0.0.1) — открыто");
  } finally {
    agent.stop();
  }
  // Тот же агент, но терминал «на другом адресе» — локальный POST чужой.
  const other = makeAgent({ termPort, adiPort, events: { mode: "push", pushPort: pushPort + 1 } });
  other.agent.cfg.terminals[0].host = "192.168.0.90";
  other.agent.terminals.get("entrance").host = "192.168.0.90";
  try {
    other.agent.start();
    await sleep(100);
    const port2 = pushPort + 1;
    const code = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: port2, method: "POST", path: "/event" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end(term.eventJson({ employeeNo: "hacker", serialNo: 52 }));
    });
    assert.equal(code, 403);
    await sleep(150);
    assert.equal(term.state.opens.length, 1, "чужому не открыли");
  } finally {
    other.agent.stop();
    await adi.close();
    await term.close();
  }
});

test("выгрузка всех людей терминала постранично (по 30)", async () => {
  const term = createFakeTerminal();
  const port = await term.listen();
  try {
    const t = new Terminal({ id: "e", host: "127.0.0.1", port, user: "admin", password: "secret" });
    for (let i = 1; i <= 71; i += 1) await t.userUpsert({ employeeNo: String(i), name: `Клиент ${i}` });
    await t.faceUpload("7", term.JPEG);
    const pages = [];
    const list = await t.userList({ onPage: (n, total) => pages.push([n, total]) });
    assert.equal(list.length, 71);
    assert.equal(new Set(list.map((u) => u.employeeNo)).size, 71, "без повторов");
    assert.deepEqual(pages, [[30, 71], [60, 71], [71, 71]]);
    assert.equal(list.find((u) => u.employeeNo === "7").faces, 1);
    assert.equal(list.find((u) => u.employeeNo === "8").faces, 0);
  } finally {
    await term.close();
  }
});

test("журнал: новый файл начинается с BOM (иначе PowerShell 5.1 покажет кракозябры)", () => {
  const dir = tmp();
  const log = require("../src/log");
  const origLog = console.log;
  console.log = () => {};
  try {
    log.init(dir);
    log.info("Проверка русского текста");
    log.info("вторая строка");
  } finally {
    console.log = origLog;
  }
  const file = fs.readdirSync(dir).find((f) => f.startsWith("agent-"));
  const buf = fs.readFileSync(path.join(dir, file));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = buf.toString("utf8");
  assert.equal(text.split("\ufeff").length, 2, "BOM только один раз");
  assert.match(text, /Проверка русского текста/);
  log.init(null);
});
