const fs = require("fs");
const readline = require("readline");

// --key value / --flag → { key: value, flag: true }, остальное — позиционные.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

/*
 * Вопросы в консоли — через одну readline на весь процесс. Отдельная readline
 * на каждый вопрос на Windows ломала следующий: после close() ввод пароля
 * терялся, и setup завершался молча. Пароль — та же readline с заглушённым
 * выводом (звёздочки).
 */
let rl = null;

function prompts() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(130);
  });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (!rl.muted) return write(s);
    if (/[\r\n]/.test(s)) return write("\n");
    if (s.length === 1) return write("*");
  };
  return rl;
}

function ask(question, def) {
  return new Promise((resolve) => {
    prompts().question(def ? `${question} [${def}]: ` : `${question}: `, (a) => resolve(a.trim() || def || ""));
  });
}

function askHidden(question) {
  if (!process.stdin.isTTY) return ask(question);
  const r = prompts();
  return new Promise((resolve) => {
    r.question(`${question}: `, (a) => {
      r.muted = false;
      resolve(a);
    });
    r.muted = true;
  });
}

// Закрыть консольный ввод, иначе процесс не завершится.
function closePrompts() {
  rl?.close();
  rl = null;
}

// Один агент на компьютер: два открывали бы дверь дважды и делили поток событий.
function acquireLock(file) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  };
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`Агент уже запущен (PID ${pid})`);
    fs.writeFileSync(file, String(process.pid));
  }
  process.on("exit", () => {
    try {
      if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* уже нет */
    }
  });
}

module.exports = { parseArgs, ask, askHidden, closePrompts, acquireLock };
