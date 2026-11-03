const http = require("http");
const https = require("https");
const crypto = require("crypto");

/*
 * HTTP к терминалу с Digest-авторизацией (Basic на прошивках Hikvision выключен).
 *
 * Главное — не заблокировать admin. После 5 неверных паролей подряд терминал
 * запирает пользователя примерно на 30 минут, а агент переподключается сам и
 * без защиты выбрал бы лимит за секунды. Поэтому: не больше двух неверных
 * попыток (старый nonce + свежий), потом запросы к терминалу не идут
 * BLOCK_MS — до исправления пароля.
 */
const BLOCK_MS = 30 * 60 * 1000;

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

class BlockedError extends Error {
  constructor(message, until) {
    super(message);
    this.name = "BlockedError";
    this.until = until;
  }
}

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function parseChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header || ""))) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

// Самоподписанный сертификат терминала — это нормально (rejectUnauthorized: false).
function rawRequest(target, { method, path, headers, body, timeoutMs, stream }) {
  return new Promise((resolve, reject) => {
    const lib = target.https ? https : http;
    const req = lib.request(
      {
        host: target.host,
        port: target.port,
        method,
        path,
        headers,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        if (stream && res.statusCode === 200) {
          res.setTimeout(0);
          return resolve({ status: 200, headers: res.headers, stream: res });
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Терминал ${target.host} не ответил за ${timeoutMs} мс`)));
    req.on("error", (err) =>
      reject(
        err.code === "ECONNREFUSED" || err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH"
          ? new Error(`Терминал ${target.host}:${target.port} недоступен (${err.code}) — проверьте IP и сеть`)
          : err,
      ),
    );
    if (body) req.write(body);
    req.end();
  });
}

class DigestClient {
  constructor({ host, port = 80, https: useHttps = false, user, password, timeoutMs = 8000 }) {
    this.target = { host, port, https: useHttps };
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.challenge = null;
    this.nc = 0;
    this.blockedUntil = 0;
    this.blockReason = null;
  }

  authorization(method, uri) {
    const c = this.challenge;
    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, "0");
    const cnonce = crypto.randomBytes(8).toString("hex");
    const ha1 = md5(`${this.user}:${c.realm}:${this.password}`);
    const ha2 = md5(`${method}:${uri}`);
    const qop = (c.qop || "").split(",").map((s) => s.trim()).includes("auth") ? "auth" : null;
    const response = qop
      ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${c.nonce}:${ha2}`);
    let h = `Digest username="${this.user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", response="${response}"`;
    if (c.algorithm) h += `, algorithm=${c.algorithm}`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (c.opaque) h += `, opaque="${c.opaque}"`;
    return h;
  }

  block(ms, reason) {
    this.blockedUntil = Date.now() + ms;
    this.blockReason = reason;
  }

  send(method, uri, { body, contentType, timeoutMs, stream, accept }) {
    const headers = {};
    if (this.challenge) headers.Authorization = this.authorization(method, uri);
    if (accept) headers.Accept = accept;
    if (body != null) {
      headers["Content-Type"] = contentType || "application/xml";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    return rawRequest(this.target, {
      method,
      path: uri,
      headers,
      body,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      stream,
    });
  }

  // Терминал сам сообщил о блокировке — ждём столько, сколько он сказал.
  checkLocked(res) {
    const text = res.body ? res.body.toString("utf8") : "";
    if (!/lock/i.test(text)) return;
    const secs = Number((/unlockTime>?"?:?\s*"?(\d+)/i.exec(text) || [])[1]) || 1800;
    this.block(secs * 1000, `Пользователь заблокирован терминалом на ${Math.ceil(secs / 60)} мин`);
  }

  async request(method, uri, opts = {}) {
    if (Date.now() < this.blockedUntil)
      throw new BlockedError(this.blockReason || "Запросы к терминалу приостановлены", this.blockedUntil);
    let res = await this.send(method, uri, opts);
    if (res.status === 401) {
      const ch = parseChallenge(res.headers["www-authenticate"]);
      if (!ch.nonce || !/^digest/i.test(res.headers["www-authenticate"] || ""))
        throw new AuthError("Терминал не предложил Digest-авторизацию");
      this.challenge = ch;
      this.nc = 0;
      res = await this.send(method, uri, opts);
      if (res.status === 401) {
        this.checkLocked(res);
        if (Date.now() >= this.blockedUntil)
          this.block(BLOCK_MS, "Неверный логин или пароль терминала — запросы остановлены на 30 мин, чтобы терминал не заблокировал admin");
        throw new AuthError("Неверный логин или пароль терминала");
      }
    }
    return res;
  }
}

module.exports = { DigestClient, AuthError, BlockedError, parseChallenge, rawRequest };
