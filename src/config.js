const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * Настройки агента — один JSON-файл.
 *   Windows:        C:\ProgramData\ADI\gate-agent\config.json
 *   Mac / Linux:    ~/.adi-gate-agent/config.json
 *   ADI_GATE_HOME — переопределить папку (тесты, второй экземпляр).
 *
 * Пароль терминала и токен ADI лежат в нём защищёнными (см. secret.js).
 */
function homeDir() {
  if (process.env.ADI_GATE_HOME) return process.env.ADI_GATE_HOME;
  if (process.platform === "win32")
    return path.join(process.env.ProgramData || "C:\\ProgramData", "ADI", "gate-agent");
  return path.join(os.homedir(), ".adi-gate-agent");
}

function paths() {
  const home = homeDir();
  return {
    home,
    config: path.join(home, "config.json"),
    logs: path.join(home, "logs"),
    outbox: path.join(home, "outbox.jsonl"),
    lock: path.join(home, "agent.lock"),
  };
}

const DEFAULTS = {
  adi: {
    // Адрес подключения агента к ADI (gate-service).
    url: "wss://api.adi-app.kz/api/gate/agent",
    token: null,
  },
  // [{ id, host, port, https, user, password, door }]
  terminals: [],
  events: {
    // stream — агент сам держит поток событий терминала (ничего на терминале не
    // настраивает, входящие порты не нужны); push — терминал шлёт события на
    // этот компьютер (нужен открытый порт pushPort).
    mode: "stream",
    pushPort: 7660,
  },
  decision: {
    // adi      — терминал узнаёт, решает ADI, агент открывает дверь;
    // terminal — терминал пускает сам, ADI только засчитывает визиты;
    // local    — проверка на месте: открыть любому, кого узнал терминал.
    mode: "adi",
    timeoutMs: 2500,
    // Нет связи с ADI в режиме adi: deny — не пускать, allow — пустить узнанного.
    offline: "deny",
    // Человек стоит перед камерой — терминал узнаёт его снова и снова.
    repeatSeconds: 5,
  },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {}))
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  return out;
}

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(paths().config, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`Не прочитать настройки ${paths().config}: ${err.message}`);
  }
  return merge(DEFAULTS, raw);
}

// Атомарно: сбой посреди записи не оставит половину файла.
function save(cfg) {
  const { home, config } = paths();
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${config}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, config);
}

function terminalOf(cfg, id) {
  if (!cfg.terminals.length) throw new Error("Терминал не настроен: выполните «adi-gate setup»");
  if (!id) return cfg.terminals[0];
  const t = cfg.terminals.find((x) => x.id === id);
  if (!t) throw new Error(`Нет терминала «${id}». Есть: ${cfg.terminals.map((x) => x.id).join(", ")}`);
  return t;
}

module.exports = { paths, load, save, terminalOf, DEFAULTS };
