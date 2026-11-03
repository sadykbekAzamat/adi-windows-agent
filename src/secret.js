const { execFileSync } = require("child_process");

/*
 * Пароль терминала и токен ADI в config.json.
 *
 * Windows — DPAPI в области LocalMachine: расшифровать может только этот
 * компьютер (и служба SYSTEM, и администратор), скопированный файл на другом
 * компьютере бесполезен. Данные идут в PowerShell через stdin, а не в
 * командной строке — их не видно в списке процессов.
 *
 * Mac / Linux (разработка, мини-ПК) — base64 в файле с правами 600: защиту
 * даёт права на файл, не шифрование.
 *
 * { "$secret": "dpapi:…" } | { "$secret": "plain:…" }. Строка вместо объекта —
 * значение, вписанное руками, берётся как есть.
 */
function ps(script, input) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", windowsHide: true },
  ).trim();
}

const READ_B64 = "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());";

function protect(plain) {
  if (plain == null || plain === "") return null;
  const b64 = Buffer.from(String(plain), "utf8").toString("base64");
  if (process.platform === "win32") {
    const out = ps(
      `Add-Type -AssemblyName System.Security;${READ_B64}` +
        "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'LocalMachine'))",
      b64,
    );
    return { $secret: `dpapi:${out}` };
  }
  return { $secret: `plain:${b64}` };
}

function reveal(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  const s = value.$secret;
  if (typeof s !== "string") return null;
  const i = s.indexOf(":");
  const kind = s.slice(0, i);
  const data = s.slice(i + 1);
  if (kind === "plain") return Buffer.from(data, "base64").toString("utf8");
  if (kind === "dpapi") {
    if (process.platform !== "win32")
      throw new Error("Пароль зашифрован на Windows — здесь его не расшифровать, выполните setup заново");
    const out = ps(
      `Add-Type -AssemblyName System.Security;${READ_B64}` +
        "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'LocalMachine'))",
      data,
    );
    return Buffer.from(out, "base64").toString("utf8");
  }
  throw new Error("Неизвестный формат секрета в настройках");
}

module.exports = { protect, reveal };
