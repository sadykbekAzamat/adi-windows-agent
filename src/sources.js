const http = require("http");
const { EventEmitter } = require("events");
const { MultipartStream, parseAll, boundaryOf } = require("./multipart");
const { normalizeEvent } = require("./isapi");
const { AuthError, BlockedError } = require("./http");

/*
 * Откуда агент берёт события проходов.
 *
 * StreamSource (по умолчанию) — агент сам держит открытым поток событий
 * терминала (alertStream). На терминале ничего не настраивается, входящие
 * порты на компьютере не нужны, и события подлинные: соединение агент
 * открыл сам, с паролем.
 *
 * PushSource — терминал отправляет события на этот компьютер (httpHosts).
 * Принимаем только с IP терминалов: иначе любой в Wi-Fi клуба мог бы
 * отправить «пришёл такой-то», и ADI открыл бы ему турникет.
 */
const IDLE_MS = 90 * 1000;

class StreamSource extends EventEmitter {
  constructor(terminal, log) {
    super();
    this.terminal = terminal;
    this.log = log;
    this.stopped = true;
    this.current = null;
    this.wake = null;
  }

  start() {
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    this.current?.destroy();
    this.wake?.();
  }

  // Пауза между попытками, которую stop() прерывает сразу.
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  async loop() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const { stream, boundary } = await this.terminal.openAlertStream();
        backoff = 1000;
        this.log.info(`Терминал ${this.terminal.id}: поток событий подключён`);
        this.emit("status", { terminalId: this.terminal.id, online: true });
        await this.consume(stream, boundary);
        if (!this.stopped) this.log.warn(`Терминал ${this.terminal.id}: поток событий прервался`);
      } catch (err) {
        this.emit("status", { terminalId: this.terminal.id, online: false, error: err.message });
        if (err instanceof AuthError || err instanceof BlockedError) {
          // Неверный пароль: ждём, пока клиент снимет блокировку, — не долбим терминал.
          this.log.error(`Терминал ${this.terminal.id}: ${err.message}`);
          const wait = Math.max(60000, (this.terminal.client.blockedUntil || 0) - Date.now());
          await this.sleep(wait);
          continue;
        }
        this.log.warn(`Терминал ${this.terminal.id}: ${err.message}`);
      }
      if (this.stopped) break;
      await this.sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  consume(stream, boundary) {
    return new Promise((resolve) => {
      this.current = stream;
      const mp = new MultipartStream(boundary);
      mp.on("part", (p) => {
        const ev = normalizeEvent(p.body.toString("utf8"), this.terminal.id);
        if (ev) this.emit("event", ev);
      });
      mp.on("error", (err) => this.log.warn(`Поток событий: ${err.message}`));
      // Терминал шлёт heartbeat; тишина дольше IDLE_MS — соединение мёртвое.
      let idle;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => stream.destroy(new Error("нет данных от терминала")), IDLE_MS);
      };
      touch();
      stream.on("data", (c) => {
        touch();
        mp.push(c);
      });
      const done = () => {
        clearTimeout(idle);
        this.current = null;
        resolve();
      };
      stream.on("end", done);
      stream.on("close", done);
      stream.on("error", done);
    });
  }
}

class PushSource extends EventEmitter {
  constructor({ port, terminals, log }) {
    super();
    this.port = port;
    this.byIp = new Map(terminals.map((t) => [t.host, t.id]));
    this.log = log;
    this.server = null;
    this.warned = new Set();
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("error", (err) => this.log.error(`Приём событий на порту ${this.port}: ${err.message}`));
    this.server.listen(this.port, "0.0.0.0", () =>
      this.log.info(`Приём событий от терминала на порту ${this.port}`),
    );
  }

  stop() {
    this.server?.close();
  }

  handle(req, res) {
    const ip = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const terminalId = this.byIp.get(ip);
    if (!terminalId) {
      if (!this.warned.has(ip)) {
        this.warned.add(ip);
        this.log.warn(`Событие с чужого адреса ${ip} — отклонено`);
      }
      res.writeHead(403);
      res.end();
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"statusCode":1,"statusString":"OK"}');
      const body = Buffer.concat(chunks);
      const boundary = boundaryOf(req.headers["content-type"]);
      const payloads = boundary
        ? parseAll(body, boundary)
            .filter((p) => !(p.body[0] === 0xff && p.body[1] === 0xd8))
            .map((p) => p.body.toString("utf8"))
        : [body.toString("utf8")];
      for (const text of payloads) {
        const ev = normalizeEvent(text, terminalId);
        if (ev) this.emit("event", ev);
      }
    });
  }
}

module.exports = { StreamSource, PushSource };
