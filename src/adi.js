const crypto = require("crypto");
const { EventEmitter } = require("events");

/*
 * Связь агента с ADI — WebSocket, который открывает сам агент (входящие
 * порты и белый IP клубу не нужны). Протокол — в README, раздел «Протокол».
 *
 *  → hello {token, agent, terminals}   ← welcome | error{code:"unauthorized"}
 *  → access.request {id, …}            ← access.decision {id, allow, reason}
 *  ← cmd {id, cmd, terminalId, args}   → cmd.result {id, ok, data | error}
 *  → event {id, …} (из очереди)        ← ack {id}
 *  → ping                              ← pong
 */
const PING_MS = 20000;
const DEAD_MS = 60000;
const UNAUTHORIZED_RETRY_MS = 10 * 60 * 1000;

class OfflineError extends Error {
  constructor(message = "Нет связи с ADI") {
    super(message);
    this.name = "OfflineError";
  }
}

class AdiLink extends EventEmitter {
  constructor({ url, token, hello, outbox, log }) {
    super();
    this.url = url;
    this.token = token;
    this.hello = hello;
    this.outbox = outbox;
    this.log = log;
    this.ws = null;
    this.ready = false;
    this.stopped = true;
    this.pending = new Map();
    this.backoff = 1000;
    this.timer = null;
  }

  start() {
    this.stopped = false;
    if (!this.token) {
      this.log.warn("Агент не привязан к компании ADI — выполните «adi-gate pair <код>». Работаем без ADI.");
      return;
    }
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pinger);
    this.ws?.close();
  }

  connect() {
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.log.error(`ADI: неверный адрес ${this.url}: ${err.message}`);
      return;
    }
    this.ws = ws;
    this.ready = false;
    this.unauthorized = false;
    this.lastSeen = Date.now();

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", token: this.token, ...this.hello }));
    };
    ws.onmessage = (m) => {
      this.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("utf8"));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    // Неудачное подключение: WebSocket в Node присылает только error, без
    // close. Поэтому потерю связи обрабатываем по любому из них — один раз.
    let lost = false;
    const onLost = () => {
      if (lost) return;
      lost = true;
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
      const wasReady = this.ready;
      this.ready = false;
      clearInterval(this.pinger);
      for (const [, p] of this.pending) p.reject(new OfflineError());
      this.pending.clear();
      if (wasReady) this.log.warn("ADI: соединение потеряно");
      this.emit("offline");
      if (this.stopped) return;
      const delay = this.unauthorized ? UNAUTHORIZED_RETRY_MS : this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = onLost;
    ws.onclose = onLost;

    clearInterval(this.pinger);
    this.pinger = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (Date.now() - this.lastSeen > DEAD_MS) return ws.close();
      ws.send('{"type":"ping"}');
    }, PING_MS);
  }

  onMessage(msg) {
    switch (msg.type) {
      case "welcome":
        this.ready = true;
        this.backoff = 1000;
        this.log.info("ADI: подключено");
        this.emit("ready", msg);
        for (const item of this.outbox.all()) this.send({ ...item, type: "event" });
        break;
      case "error":
        if (msg.code === "unauthorized") {
          this.unauthorized = true;
          this.log.error("ADI: токен агента не принят — привяжите агент заново («adi-gate pair <код>»)");
        } else this.log.warn(`ADI: ${msg.message || msg.code}`);
        if (msg.code === "unauthorized") this.ws?.close();
        break;
      case "access.decision": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        break;
      }
      case "ack":
        this.outbox.remove(msg.id);
        break;
      case "cmd":
        this.emit("cmd", msg);
        break;
      default:
        break;
    }
  }

  send(obj) {
    if (!this.ready || this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  // Запрос с ответом (решение по проходу). Нет связи — сразу OfflineError.
  request(obj, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = obj.id || crypto.randomUUID();
      if (!this.send({ ...obj, id })) return reject(new OfflineError());
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new OfflineError(`ADI не ответил за ${timeoutMs} мс`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  // Событие, которое ADI обязан получить: сначала в очередь, потом отправка.
  report(event) {
    const item = { id: crypto.randomUUID(), at: new Date().toISOString(), ...event };
    this.outbox.add(item);
    this.send({ ...item, type: "event" });
    return item.id;
  }

  reply(id, result) {
    this.send({ type: "cmd.result", id, ...result });
  }
}

module.exports = { AdiLink, OfflineError };
