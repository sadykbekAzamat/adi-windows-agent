const fs = require("fs");
const path = require("path");

/*
 * Журнал агента: в консоль и в файл по дням (logs/agent-ГГГГ-ММ-ДД.log),
 * хранится 14 дней. Пароли и токены сюда не пишем — их не передают в log.
 */
const KEEP_DAYS = 14;
let dir = null;

// Местное время — журнал читают в клубе.
const stamp = () => new Date().toLocaleString("sv-SE");
const day = () => stamp().slice(0, 10);

function init(logDir) {
  dir = logDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (/^agent-.*\.log$/.test(f) && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    dir = null; // без файла — только консоль
  }
}

function write(level, msg, extra) {
  const line = `${stamp()} ${level.padEnd(5)} ${msg}${extra !== undefined ? ` ${JSON.stringify(extra)}` : ""}`;
  (level === "ERROR" || level === "WARN" ? console.error : console.log)(line);
  if (!dir) return;
  try {
    fs.appendFileSync(path.join(dir, `agent-${day()}.log`), `${line}\n`);
  } catch {
    /* диск полон или нет прав — консоль всё равно есть */
  }
}

module.exports = {
  init,
  info: (m, e) => write("INFO", m, e),
  warn: (m, e) => write("WARN", m, e),
  error: (m, e) => write("ERROR", m, e),
  debug: (m, e) => process.env.ADI_GATE_DEBUG && write("DEBUG", m, e),
};
