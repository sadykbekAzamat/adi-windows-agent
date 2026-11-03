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

function ask(question, def) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(def ? `${question} [${def}]: ` : `${question}: `, (a) => {
      rl.close();
      resolve(a.trim() || def || "");
    });
  });
}

// Пароль со звёздочками. Без терминала (перенаправлен ввод) — читаем строку.
function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
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

module.exports = { parseArgs, ask, askHidden, acquireLock };
