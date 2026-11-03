const os = require("os");
const { Terminal, FACE_PASS, DOOR_COMMANDS } = require("./isapi");
const { StreamSource, PushSource } = require("./sources");
const { AdiLink } = require("./adi");
const { Outbox } = require("./outbox");
const secret = require("./secret");
const { version } = require("../package.json");

/*
 * Агент: события терминала → решение → дверь; команды ADI → терминал.
 *
 * Режимы решения (config.decision.mode):
 *   adi      — терминал узнаёт лицо, ADI проверяет абонемент по своим правилам
 *              (те же, что при отметке визита), агент открывает дверь;
 *   terminal — терминал пускает сам по датам в нём, ADI засчитывает визит;
 *   local    — проверка на месте: открыть любому, кого узнал терминал.
 *
 * ADI может попросить только команды из COMMANDS — произвольный запрос к
 * терминалу через агента не пройдёт.
 */
const SEEN_MAX = 1000;

const COMMANDS = {
  deviceInfo: (t) => t.deviceInfo(),
  capabilities: (t) => t.capabilities(),
  door: (t, a) => t.doorCommand(a.cmd),
  userCount: (t) => t.userCount(),
  userGet: (t, a) => t.userGet(a.employeeNo),
  userUpsert: (t, a) => t.userUpsert(a),
  userDelete: (t, a) => t.userDelete(a.employeeNos ?? a.employeeNo),
  faceUpload: (t, a) => t.faceUpload(a.employeeNo, Buffer.from(String(a.imageBase64 || ""), "base64")),
  faceDelete: (t, a) => t.faceDelete(a.employeeNo),
  faceCapture: async (t, a) => ({
    imageBase64: (await t.faceCapture({ timeoutMs: a.timeoutMs })).toString("base64"),
  }),
};

class Agent {
  constructor(cfg, { log, outboxFile }) {
    this.cfg = cfg;
    this.log = log;
    this.decision = cfg.decision;
    this.terminals = new Map(
      cfg.terminals.map((t) => [t.id, new Terminal({ ...t, password: secret.reveal(t.password) })]),
    );
    if (!this.terminals.size) throw new Error("Терминал не настроен: выполните «adi-gate setup»");
    this.link = new AdiLink({
      url: cfg.adi.url,
      token: secret.reveal(cfg.adi.token),
      outbox: new Outbox(outboxFile, log),
      log,
      hello: {
        agent: { version, hostname: os.hostname(), platform: process.platform },
        decisionMode: this.decision.mode,
        terminals: cfg.terminals.map((t) => ({ id: t.id, host: t.host, door: t.door })),
      },
    });
    this.sources = [];
    this.seen = new Set();
    this.recent = new Map();
  }

  start() {
    const onEvent = (ev) =>
      this.onEvent(ev).catch((err) => this.log.error(`Событие терминала: ${err.message}`));
    if (this.cfg.events.mode === "push") {
      const src = new PushSource({ port: this.cfg.events.pushPort, terminals: this.cfg.terminals, log: this.log });
      src.on("event", onEvent);
      this.sources.push(src);
    } else {
      for (const t of this.terminals.values()) {
        const src = new StreamSource(t, this.log);
        src.on("event", onEvent);
        src.on("status", (s) => this.link.send({ type: "terminal.status", ...s }));
        this.sources.push(src);
      }
    }
    this.link.on("cmd", (msg) => this.onCommand(msg));
    for (const s of this.sources) s.start();
    this.link.start();
    this.log.info(
      `Агент ${version} запущен: режим «${this.decision.mode}», события «${this.cfg.events.mode}», терминалов ${this.terminals.size}`,
    );
  }

  stop() {
    for (const s of this.sources) s.stop();
    this.link.stop();
  }

  // Терминал повторяет событие при переподключении потока — второй раз не решаем.
  isDuplicate(ev) {
    if (ev.serialNo == null) return false;
    const key = `${ev.terminalId}:${ev.serialNo}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value);
    return false;
  }

  // Человек стоит перед камерой — терминал узнаёт его по нескольку раз.
  isRepeat(ev) {
    const key = `${ev.terminalId}:${ev.employeeNo}`;
    const now = Date.now();
    const last = this.recent.get(key);
    this.recent.set(key, now);
    if (this.recent.size > SEEN_MAX) this.recent.delete(this.recent.keys().next().value);
    return last != null && now - last < this.decision.repeatSeconds * 1000;
  }

  async onEvent(ev) {
    this.log.debug("Событие", ev);
    if (ev.major !== 5 || !ev.employeeNo) return; // не проход человека
    if (this.isDuplicate(ev) || this.isRepeat(ev)) return;

    const person = {
      terminalId: ev.terminalId,
      employeeNo: ev.employeeNo,
      name: ev.name,
      minor: ev.minor,
      serialNo: ev.serialNo,
      time: ev.time,
    };
    const mode = this.decision.mode;

    if (mode === "terminal") {
      this.link.report({ kind: ev.minor === FACE_PASS ? "access.passed" : "access.refused", ...person });
      return;
    }
    if (mode === "local") {
      const opened = await this.open(ev, "проверка на месте");
      this.link.report({ kind: "access.local", ...person, opened });
      return;
    }

    let decision;
    try {
      decision = await this.link.request({ type: "access.request", ...person }, this.decision.timeoutMs);
    } catch (err) {
      if (this.decision.offline === "allow") {
        const opened = await this.open(ev, `без ADI: ${err.message}`);
        this.link.report({ kind: "access.offline", ...person, opened });
      } else {
        this.log.warn(`${who(ev)}: не пустили — ${err.message}`);
        this.link.report({ kind: "access.offline_denied", ...person, reason: err.message });
      }
      return;
    }

    if (!decision.allow) {
      this.log.info(`${who(ev)}: отказ — ${decision.reason || "без причины"}`);
      return;
    }
    const opened = await this.open(ev, decision.reason || "ADI разрешил");
    this.link.report({ kind: "access.opened", decisionId: decision.id, ...person, opened });
  }

  async open(ev, why) {
    const t = this.terminals.get(ev.terminalId);
    try {
      await t.doorCommand("open");
      this.log.info(`${who(ev)}: открыто (${why})`);
      return true;
    } catch (err) {
      this.log.error(`${who(ev)}: дверь не открылась — ${err.message}`);
      return false;
    }
  }

  async onCommand(msg) {
    const handler = COMMANDS[msg.cmd];
    if (!handler) return this.link.reply(msg.id, { ok: false, error: { code: "unknown_command", message: `Нет команды ${msg.cmd}` } });
    const t = msg.terminalId ? this.terminals.get(msg.terminalId) : this.terminals.values().next().value;
    if (!t) return this.link.reply(msg.id, { ok: false, error: { code: "unknown_terminal", message: `Нет терминала ${msg.terminalId}` } });
    try {
      const data = await handler(t, msg.args || {});
      this.log.info(`Команда ADI «${msg.cmd}» на ${t.id}: выполнено`);
      this.link.reply(msg.id, { ok: true, data });
    } catch (err) {
      this.log.warn(`Команда ADI «${msg.cmd}» на ${t.id}: ${err.message}`);
      this.link.reply(msg.id, { ok: false, error: { code: err.subStatusCode || err.name, message: err.message } });
    }
  }
}

const who = (ev) => `${ev.name || "?"} (${ev.employeeNo}) у ${ev.terminalId}`;

module.exports = { Agent, COMMANDS, DOOR_COMMANDS };
