# ADI Gate Agent — агент турникета

Маленькая фоновая программа на компьютере в клубе. Связывает терминал распознавания лиц Hikvision в сети клуба с ADI:

```
Терминал ──событие «пришёл такой-то»──▶ Агент ──интернет──▶ ADI
Терминал ◀────────── «открыть» ──────── Агент ◀── «пускать» ── ADI
```

- Агент сам подключается к ADI. Белый IP, проброс портов и открытые входящие порты не нужны.
- Пароль терминала хранится только на этом компьютере. На Windows он зашифрован средствами системы (DPAPI) и бесполезен на другом компьютере.
- Без окон: работает как задача Windows, запускается вместе с компьютером и сам перезапускается при сбое.
- Node.js 22+, без внешних зависимостей.

План проекта: [docs/hikvision-face-terminal.md](../docs/hikvision-face-terminal.md).

---

## Установка на Windows

1. Установить **Node.js 22 LTS** с [nodejs.org](https://nodejs.org).
2. Скопировать папку `gate-agent` на компьютер, например на рабочий стол.
3. Открыть **PowerShell от имени администратора** в этой папке и выполнить:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```
4. В том же окне настроить терминал. Будет одна пробная попытка входа:
   ```powershell
   & "C:\Program Files\ADI Gate Agent\adi-gate.cmd" setup
   ```
   Спросит IP терминала, логин и пароль. Пароль не показывается и хранится зашифрованным.
5. Проверить: `adi-gate check`, `adi-gate door open`.
6. Привязать к компании ADI: `adi-gate pair <код>`. Код выдаёт кабинет ADI: «Турникеты» → «Подключить компьютер», действует 15 минут.
7. Запустить: `Start-ScheduledTask -TaskName "ADI Gate Agent"`.

**Где что лежит**

- Агент — `C:\Program Files\ADI Gate Agent`.
- Настройки — `C:\ProgramData\ADI\gate-agent\config.json`. Доступ — только у администраторов и SYSTEM.
- Журнал — `C:\ProgramData\ADI\gate-agent\logs\agent-ГГГГ-ММ-ДД.log`, хранится 14 дней.
- События, ещё не доставленные в ADI, — `outbox.jsonl` в той же папке.

**Смотреть журнал вживую:**

```powershell
Get-Content "C:\ProgramData\ADI\gate-agent\logs\agent-$(Get-Date -Format yyyy-MM-dd).log" -Wait -Encoding UTF8
```

**Обновить агент:** скачать новую версию (GitHub → Code → Download ZIP), распаковать и в PowerShell от администратора снова выполнить `scripts\install.ps1` из новой папки. Скрипт остановит агент, заменит файлы и запустит снова. Настройки и пароль сохраняются.

**Перезапустить** после изменения настроек:

```powershell
Stop-ScheduledTask -TaskName "ADI Gate Agent"; Start-ScheduledTask -TaskName "ADI Gate Agent"
```

**Удалить:** `powershell -ExecutionPolicy Bypass -File "C:\Program Files\ADI Gate Agent\scripts\uninstall.ps1"`. С ключом `-Purge` удалятся ещё настройки и журнал.

Отключите сон компьютера: во сне агент не работает.

```
powercfg /change standby-timeout-ac 0
```

---

## Команды

`adi-gate help` — полный список. Главное на месте:

| Команда | Что делает |
|---|---|
| `setup` | IP, логин и пароль терминала. Одна пробная попытка: при неверном пароле больше не пробует |
| `check` | Модель, прошивка, возможности (удалённая проверка, снимок лица), сколько людей в терминале |
| `door open` / `door close` | Открыть или закрыть турникет. Ещё есть `alwaysOpen`, `alwaysClose`, `resume` |
| `events` | Показывать события проходов вживую. Подойдите к терминалу — увидите `employeeNo`, `major` и `minor` |
| `users export люди.json` | Все люди терминала: номер, имя, срок, есть ли лицо. Для сверки с клиентами ADI |
| `user add <id> --name "Имя" --to 2026-11-30` | Добавить человека со сроком |
| `user get <id>` / `user del <id>` | Найти или удалить человека |
| `face capture face.jpg` | Снять лицо камерой терминала |
| `face upload <id> face.jpg` | Загрузить фото человеку. JPEG до 200 КБ |
| `mode adi\|terminal\|local` | Кто решает, пускать ли (ниже) |
| `push show` / `push set --ip <IP ПК> --yes` | Куда терминал отправляет события; включить отправку на этот ПК |
| `status` | Настройки без паролей |
| `run` | Работа. Это запускает задача Windows |

**Защита от блокировки admin.** После 5 неверных паролей терминал блокирует admin примерно на 30 минут. Агент после первой ошибки пароля прекращает запросы к терминалу на 30 минут, вместо того чтобы переподключаться.

---

## Режимы

**Кто решает, пускать ли** — `decision.mode`:

| Режим | Как работает | Когда |
|---|---|---|
| `adi` (по умолчанию) | Терминал узнаёт лицо → агент спрашивает ADI → ADI проверяет абонемент по своим правилам → агент открывает дверь | Основной |
| `terminal` | Терминал пускает сам по сроку, загруженному в него; ADI только засчитывает визит | Если не получится, чтобы терминал узнавал и не открывал сам |
| `local` | Агент открывает любому, кого узнал терминал | Проверка на месте без ADI |

**Нет связи с ADI** в режиме `adi` — `decision.offline`:

- `deny` (по умолчанию) — не пускать;
- `allow` — пустить узнанного.

В обоих случаях событие ложится в очередь и уходит в ADI, когда связь вернётся.

Ещё два параметра:

- `decision.timeoutMs` (2500) — сколько ждать ответа ADI.
- `decision.repeatSeconds` (5) — человек стоит перед камерой, и терминал узнаёт его снова. Повтор за это время игнорируется.

**Откуда события** — `events.mode`:

- `stream` (по умолчанию) — агент сам держит поток событий терминала (`alertStream`). На терминале ничего не меняется, входящие порты не нужны, события подлинные: соединение с паролем открыл сам агент.
- `push` — терминал сам отправляет события на ПК, порт `events.pushPort` (7660). Агент принимает события только с IP терминалов: иначе кто угодно в Wi‑Fi клуба мог бы прислать «пришёл такой-то». Брандмауэр — `install.ps1 -PushFromIp <IP терминала>`.

---

## Терминал DS-K1T671M (V3.2.30)

Проверено в клубе 30.10.2026:

- **Дверь — только XML:** `<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>`. На JSON терминал отвечает `MessageParametersLack`.
- Люди и лица — в JSON (`?format=json`).
- Дверь одна. Второе реле — тревожный выход, он выключен.
- Удалённой проверки (`remoteCheck`) в возможностях нет. Поэтому решение ADI исполняется командой `open` от агента.

**Ещё не проверено на устройстве**, проверить командами `events` и `face capture`:

- формат событий прохода;
- в каком виде приходит снимок лица (`CaptureFaceData`).

---

## Протокол с ADI

JSON-сообщения по WebSocket `adi.url` (по умолчанию `wss://api.adi-app.kz/api/gate/agent`). Это задание для `gate-service`.

**Агент → ADI**

| Сообщение | Когда |
|---|---|
| `{type:"hello", token, agent:{version,hostname,platform}, decisionMode, terminals:[{id,host,door}]}` | Сразу после подключения |
| `{type:"access.request", id, terminalId, employeeNo, name, minor, serialNo, time}` | Терминал узнал человека, режим `adi`. Ждёт `access.decision` за `timeoutMs` |
| `{type:"event", id, at, kind, …}` | Событие, которое ADI обязан получить. Хранится в очереди до `ack` |
| `{type:"cmd.result", id, ok, data \| error:{code,message}}` | Ответ на команду |
| `{type:"terminal.status", terminalId, online, error?}` | Поток событий терминала подключился или упал |
| `{type:"ping"}` | Каждые 20 с. Нет ответа 60 с — переподключение |

Значения `kind` у `event`:

- `access.opened` — ADI разрешил, `opened` показывает, открылась ли дверь;
- `access.offline` — пустили без ADI;
- `access.offline_denied` — не пустили без ADI;
- `access.passed` и `access.refused` — режим `terminal`;
- `access.local` — режим `local`.

**ADI → агент**

| Сообщение | Ответ на |
|---|---|
| `{type:"welcome", agentId}` | `hello` с верным токеном. После него агент отправляет очередь |
| `{type:"error", code:"unauthorized"}` | Неверный токен. Агент повторит не раньше чем через 10 минут |
| `{type:"access.decision", id, allow, reason?}` | `access.request` |
| `{type:"ack", id}` | `event`: удалить из очереди |
| `{type:"cmd", id, cmd, terminalId?, args}` | Команда терминалу |
| `{type:"pong"}` | `ping` |

**Команды** (`cmd`). Другие агент не выполнит: произвольный запрос к терминалу через ADI невозможен.

| Команда | Аргументы |
|---|---|
| `deviceInfo` | — |
| `userList` | — → `[{employeeNo, name, validFrom, validTo, faces, cards}]` |
| `capabilities` | — |
| `door` | `{cmd}` |
| `userCount` | — |
| `userGet` | `{employeeNo}` |
| `userUpsert` | `{employeeNo, name, validFrom, validTo, planTemplate?}` |
| `userDelete` | `{employeeNos}` |
| `faceUpload` | `{employeeNo, imageBase64}` |
| `faceDelete` | `{employeeNo}` |
| `faceCapture` | `{timeoutMs?}` → `{imageBase64}` |

`employeeNo` — номер человека в терминале (до 32 символов). У людей, внесённых в терминал до ADI, номера свои (например, `135`). Поэтому ADI хранит соответствие «номер в терминале → клиент ADI» и не считает `employeeNo` id пользователя. Новым людям ADI даёт номер сам.

**Привязка:** `POST {base}/api/gate/agent/pair` с телом `{code, hostname, version}` → `{token, wsUrl?, companyName?}`.

---

## Разработка

```bash
cd gate-agent
npm install        # только ws — для имитатора ADI в тестах
npm test           # имитатор терминала DS-K1T671M + имитатор ADI
ADI_GATE_HOME=/tmp/agent node src/index.js help
```

`ADI_GATE_DEBUG=1` — подробный журнал: каждое событие терминала.
