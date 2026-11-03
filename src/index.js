#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const config = require("./config");
const secret = require("./secret");
const log = require("./log");
const { Terminal, DOOR_COMMANDS } = require("./isapi");
const { AuthError, BlockedError } = require("./http");
const { MultipartStream } = require("./multipart");
const { normalizeEvent } = require("./isapi");
const { parseArgs, ask, askHidden, closePrompts, acquireLock } = require("./cli-util");
const { version } = require("../package.json");

const HELP = `ADI Gate Agent ${version} — агент турникета

Настройка
  setup [--host IP --port 80 --user admin --id entrance --door 1]
                       терминал: адрес, логин, пароль (один пробный запрос)
  pair <код> [--url https://api.adi-app.kz]
                       привязать к компании ADI (код — в кабинете «Турникеты»)
  mode <adi|terminal|local> [--offline deny|allow]
                       кто решает, пускать ли (см. README)
  status               настройки без паролей

Проверка на месте
  check                модель, прошивка, возможности, сколько людей
  door <${DOOR_COMMANDS.join("|")}>
  events [--raw]       показывать события проходов (Ctrl+C — выход)
  users export [файл.json]  все люди терминала: номер, имя, срок, есть ли лицо
  user add <employeeNo> --name "Имя" [--from 2026-11-01] [--to 2026-11-30]
  user get <employeeNo> | user del <employeeNo>
  face upload <employeeNo> <фото.jpg> | face capture <куда.jpg> | face del <employeeNo>
  push show            куда терминал сейчас отправляет события
  push set --ip IP-этого-ПК [--id 2] --yes
                       включить отправку событий на этот компьютер

Работа
  run                  запустить агент (служба запускает именно это)

Флаг --terminal <id> — выбрать терминал, если их несколько.`;

function terminalFrom(cfg, args) {
  const t = config.terminalOf(cfg, args.terminal);
  return new Terminal({ ...t, password: secret.reveal(t.password) });
}

function explain(err) {
  if (err instanceof AuthError)
    return `${err.message}. Новых попыток агент не делает: после 5 ошибок терминал блокирует admin на ~30 минут.`;
  if (err instanceof BlockedError) return err.message;
  return err.message;
}

async function setup(args) {
  const cfg = config.load();
  const prev = cfg.terminals.find((t) => t.id === (args.id || "entrance")) || {};
  // Пароль из stdin — значит, вопросов не задаём: stdin занят паролем.
  const quiet = Boolean(args["password-stdin"]);
  const host = args.host || (quiet ? prev.host : await ask("IP терминала", prev.host));
  if (!host || (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && !/^[\w.-]+$/.test(host)))
    throw new Error("Неверный адрес терминала (--host)");
  const port = Number(args.port || prev.port || 80);
  const user = args.user || (quiet ? prev.user || "admin" : await ask("Логин", prev.user || "admin"));
  const password = args["password-stdin"]
    ? fs.readFileSync(0, "utf8").trim()
    : await askHidden("Пароль терминала (не показывается)");
  if (!password) throw new Error("Пароль пустой");
  const entry = {
    id: args.id || prev.id || "entrance",
    host,
    port,
    https: Boolean(args.https) || false,
    user,
    door: Number(args.door || prev.door || 1),
  };

  const t = new Terminal({ ...entry, password });
  console.log("Проверяю подключение (одна попытка)…");
  const info = await t.deviceInfo();
  const caps = await t.capabilities().catch(() => null);
  entry.password = secret.protect(password);
  cfg.terminals = [...cfg.terminals.filter((x) => x.id !== entry.id), entry];
  config.save(cfg);
  console.log(`Готово: ${info.model}, прошивка ${info.firmware} (${info.firmwareDate}), S/N ${info.serialNumber}`);
  if (caps) printCaps(caps);
  console.log(`Настройки: ${config.paths().config}`);
}

function printCaps(c) {
  const yn = (v) => (v ? "да" : "нет");
  console.log(`  открыть дверь командой: ${yn(c.remoteControlDoor)}`);
  console.log(`  удалённая проверка (терминал спрашивает «пускать?»): ${yn(c.remoteCheck)}`);
  console.log(`  снимок лица по команде: ${yn(c.captureFace)}`);
  console.log(`  люди и лица: ${yn(c.userInfo && c.faceLib)}`);
}

async function pair(args) {
  const code = args._[1];
  if (!code) throw new Error("Укажите код из кабинета: adi-gate pair <код>");
  const cfg = config.load();
  const base = (args.url || "https://api.adi-app.kz").replace(/\/$/, "");
  const res = await fetch(`${base}/api/gate/agent/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(code).trim(), hostname: os.hostname(), version }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(body.message || `ADI отказал (HTTP ${res.status})`);
  cfg.adi.token = secret.protect(body.token);
  if (body.wsUrl) cfg.adi.url = body.wsUrl;
  config.save(cfg);
  console.log(`Привязано${body.companyName ? ` к «${body.companyName}»` : ""}. Перезапустите агент.`);
}

function setMode(args) {
  const mode = args._[1];
  if (!["adi", "terminal", "local"].includes(mode)) throw new Error("Режим: adi, terminal или local");
  const cfg = config.load();
  cfg.decision.mode = mode;
  if (args.offline) {
    if (!["deny", "allow"].includes(args.offline)) throw new Error("--offline deny или allow");
    cfg.decision.offline = args.offline;
  }
  config.save(cfg);
  console.log(`Режим: ${mode}${mode === "adi" ? `, без связи с ADI: ${cfg.decision.offline}` : ""}. Перезапустите агент.`);
}

function status() {
  const cfg = config.load();
  const masked = {
    ...cfg,
    adi: { ...cfg.adi, token: cfg.adi.token ? "задан" : "нет — выполните pair" },
    terminals: cfg.terminals.map((t) => ({ ...t, password: t.password ? "задан" : "нет" })),
  };
  console.log(JSON.stringify(masked, null, 2));
  console.log(`Папка агента: ${config.paths().home}`);
}

async function check(args) {
  const t = terminalFrom(config.load(), args);
  const info = await t.deviceInfo();
  console.log(`${info.model}, прошивка ${info.firmware} (${info.firmwareDate}), S/N ${info.serialNumber}`);
  printCaps(await t.capabilities());
  const n = await t.userCount().catch((e) => ({ error: e.message }));
  console.log(`  людей в терминале: ${n.users ?? n.error}`);
}

async function events(args) {
  const t = terminalFrom(config.load(), args);
  console.log("Жду события… (Ctrl+C — выход). Подойдите к терминалу.");
  const { stream, boundary } = await t.openAlertStream();
  const mp = new MultipartStream(boundary);
  mp.on("part", (p) => {
    const text = p.body.toString("utf8");
    if (args.raw) console.log(text);
    const ev = normalizeEvent(text, t.id);
    if (ev)
      console.log(
        `${ev.time || ""} major=${ev.major} minor=${ev.minor} employeeNo=${ev.employeeNo || "—"} ${ev.name || ""} serial=${ev.serialNo}`,
      );
  });
  stream.on("data", (c) => mp.push(c));
  await new Promise((r) => stream.on("close", r));
  console.log("Поток закрыт терминалом.");
}

async function user(args) {
  const [, sub, employeeNo] = args._;
  const t = terminalFrom(config.load(), args);
  if (sub === "add") {
    console.log(await t.userUpsert({ employeeNo, name: args.name, validFrom: args.from, validTo: args.to, planTemplate: args.plan }));
  } else if (sub === "get") console.log(await t.userGet(employeeNo));
  else if (sub === "del") console.log(await t.userDelete([employeeNo]));
  else if (sub === "count") console.log(await t.userCount());
  else throw new Error("user add|get|del|count");
}

// Все люди из терминала в JSON — для сверки с клиентами ADI.
async function users(args) {
  if (args._[1] !== "export") throw new Error("users export <файл.json>");
  const file = args._[2] || "terminal-users.json";
  const t = terminalFrom(config.load(), args);
  const list = await t.userList({
    onPage: (n, total) => process.stdout.write(`\rПрочитано ${n}${total ? ` из ${total}` : ""}…`),
  });
  process.stdout.write("\n");
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  const withFace = list.filter((u) => u.faces > 0).length;
  console.log(`Сохранено ${list.length} человек (с лицом: ${withFace}) → ${file}`);
}

async function face(args) {
  const [, sub, a1, a2] = args._;
  const t = terminalFrom(config.load(), args);
  if (sub === "upload") console.log(await t.faceUpload(a1, fs.readFileSync(a2)));
  else if (sub === "del") console.log(await t.faceDelete(a1));
  else if (sub === "capture") {
    console.log("Смотрите в камеру терминала…");
    const jpeg = await t.faceCapture();
    fs.writeFileSync(a1 || "face.jpg", jpeg);
    console.log(`Сохранено: ${a1 || "face.jpg"} (${Math.round(jpeg.length / 1024)} КБ)`);
  } else throw new Error("face upload|capture|del");
}

async function push(args) {
  const t = terminalFrom(config.load(), args);
  const hosts = await t.httpHosts();
  if (args._[1] === "show" || !args._[1]) {
    console.log(hosts.length ? hosts : "Адресов нет");
    return;
  }
  if (args._[1] !== "set") throw new Error("push show|set");
  const cfg = config.load();
  if (!args.ip) throw new Error("Укажите --ip — адрес этого компьютера в сети клуба");
  // Занятый чужой адрес не перезаписываем без явного --id.
  const free = hosts.find((h) => !h.ip && !h.host) || null;
  const id = args.id || free?.id;
  if (!id) throw new Error(`Свободного слота нет: ${JSON.stringify(hosts)}. Укажите --id явно, если слот можно занять.`);
  const taken = hosts.find((h) => h.id === String(id) && (h.ip || h.host));
  if (taken) console.log(`Слот ${id} сейчас занят: ${JSON.stringify(taken)}`);
  if (!args.yes) throw new Error("Добавьте --yes, чтобы изменить настройку терминала");
  await t.setHttpHost({ id, ip: args.ip, port: cfg.events.pushPort });
  cfg.events.mode = "push";
  config.save(cfg);
  console.log(`Терминал будет слать события на ${args.ip}:${cfg.events.pushPort} (слот ${id}). Режим событий: push.`);
}

// Служба запускает «run»: он держит рабочий процесс и перезапускает его при сбое.
function run() {
  const p = config.paths();
  fs.mkdirSync(p.home, { recursive: true });
  log.init(p.logs);
  acquireLock(p.lock);
  let child = null;
  let stopping = false;
  let backoff = 1000;
  const startChild = () => {
    const t0 = Date.now();
    // ipc — чтобы рабочий процесс узнал о смерти главного (см. worker).
    child = spawn(process.execPath, [__filename, "worker"], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    child.on("exit", (code, sig) => {
      child = null;
      if (stopping) return process.exit(0);
      if (Date.now() - t0 > 60000) backoff = 1000;
      log.warn(`Рабочий процесс завершился (${sig || code}) — перезапуск через ${backoff / 1000} с`);
      setTimeout(startChild, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
  };
  const stop = () => {
    stopping = true;
    if (child) child.kill();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, stop);
  startChild();
}

function worker() {
  const p = config.paths();
  log.init(p.logs);
  process.on("uncaughtException", (err) => {
    log.error(`Сбой: ${err.stack || err.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => log.error(`Сбой: ${err?.stack || err}`));
  // Терминал ещё не настроен (служба запущена до setup) — ждём, а не падаем:
  // иначе главный процесс перезапускал бы нас в цикле без объяснений.
  const cfg = config.load();
  if (!cfg.terminals.length) {
    log.warn("Терминал не настроен — жду «adi-gate setup», проверю снова через 30 с");
    setTimeout(() => process.exit(0), 30000);
    process.on("disconnect", () => process.exit(0));
    return;
  }
  const { Agent } = require("./agent");
  const agent = new Agent(cfg, { log, outboxFile: p.outbox });
  agent.start();
  // Главный процесс убит (Windows снимает задачу жёстко) — уходим вслед, иначе
  // после перезапуска работали бы два агента и дверь открывалась бы дважды.
  process.on("disconnect", () => {
    log.warn("Главный процесс агента остановлен — завершаюсь");
    agent.stop();
    process.exit(0);
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"])
    process.on(sig, () => {
      agent.stop();
      process.exit(0);
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const table = { setup, pair, mode: setMode, status, check, events, user, users, face, push };
  if (cmd === "run") return run();
  if (cmd === "worker") return worker();
  if (!cmd || cmd === "help" || args.help) return console.log(HELP);
  if (cmd === "version") return console.log(version);
  if (cmd === "door") {
    const c = args._[1];
    const t = terminalFrom(config.load(), args);
    await t.doorCommand(c);
    return console.log(`Дверь: ${c} — OK`);
  }
  const fn = table[cmd];
  if (!fn) throw new Error(`Нет команды «${cmd}». adi-gate help — список`);
  await fn(args);
}

if (require.main === module)
  main()
    .then(() => closePrompts())
    .catch((err) => {
      closePrompts();
      // Ошибка рабочего процесса службы — в журнал: консоли у службы нет.
      if (process.argv[2] === "worker") log.error(`Рабочий процесс не запустился: ${explain(err)}`);
      console.error(`Ошибка: ${explain(err)}`);
      process.exit(1);
    });

module.exports = { main };
