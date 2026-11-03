const { EventEmitter } = require("events");

/*
 * multipart от терминала: поток событий (alertStream, multipart/mixed),
 * события push (multipart/form-data), ответ снимка лица (XML + JPEG).
 *
 * Часть с Content-Length читаем ровно по длине (в JPEG может встретиться что
 * угодно), без него — до следующего разделителя.
 */
const MAX_BUFFER = 20 * 1024 * 1024;

function boundaryOf(contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || "");
  return m ? m[1].trim() : null;
}

function parseHeaders(text) {
  const out = {};
  for (const line of text.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const name = /name="([^"]*)"/i.exec(out["content-disposition"] || "");
  if (name) out.name = name[1];
  return out;
}

class MultipartStream extends EventEmitter {
  constructor(boundary) {
    super();
    this.delim = Buffer.from(`--${boundary}`);
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_BUFFER) {
      this.buf = Buffer.alloc(0);
      this.emit("error", new Error("Слишком большой фрагмент потока — сброшен"));
      return;
    }
    this.parse();
  }

  parse() {
    for (;;) {
      const start = this.buf.indexOf(this.delim);
      if (start < 0) {
        // Держим хвост: разделитель мог прийти разрезанным.
        if (this.buf.length > this.delim.length) this.buf = this.buf.subarray(this.buf.length - this.delim.length);
        return;
      }
      const after = start + this.delim.length;
      if (this.buf.length < after + 2) return;
      if (this.buf[after] === 0x2d && this.buf[after + 1] === 0x2d) {
        this.buf = this.buf.subarray(after + 2); // «--boundary--» — конец
        continue;
      }
      const headEnd = this.buf.indexOf("\r\n\r\n", after);
      if (headEnd < 0) return;
      const headers = parseHeaders(this.buf.subarray(after, headEnd).toString("latin1"));
      const bodyStart = headEnd + 4;
      const len = parseInt(headers["content-length"], 10);
      let bodyEnd;
      if (Number.isFinite(len) && len >= 0) {
        if (this.buf.length < bodyStart + len) return;
        bodyEnd = bodyStart + len;
      } else {
        const next = this.buf.indexOf(this.delim, bodyStart);
        if (next < 0) return;
        bodyEnd = next;
        while (bodyEnd > bodyStart && (this.buf[bodyEnd - 1] === 0x0a || this.buf[bodyEnd - 1] === 0x0d)) bodyEnd -= 1;
      }
      const body = Buffer.from(this.buf.subarray(bodyStart, bodyEnd));
      this.buf = this.buf.subarray(bodyEnd);
      this.emit("part", { headers, body });
    }
  }
}

// Весь ответ целиком (push, снимок лица).
function parseAll(buffer, boundary) {
  const parts = [];
  const s = new MultipartStream(boundary);
  s.on("part", (p) => parts.push(p));
  s.on("error", () => {});
  s.push(Buffer.concat([buffer, Buffer.from(`\r\n--${boundary}--`)]));
  return parts;
}

// Собрать multipart/form-data для загрузки (фото лица).
function build(parts) {
  const boundary = `----adi${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += `\r\nContent-Type: ${p.contentType}\r\nContent-Length: ${Buffer.byteLength(p.body)}\r\n\r\n`;
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

module.exports = { MultipartStream, parseAll, build, boundaryOf };
