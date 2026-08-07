# balabash-v2

Тредовая версия balabash: система — множество параллельных ранов над одним
append-only логом событий в Postgres; каждый ран владеет тредом — контекстом
и границей видимости. Строится с нуля по дизайн-доку «Balabash v2 —
архитектура» (Notion); v1 работает рядом как есть, пока v2 не заменит её
фактически.

## Состояние

Этап 4 из 6 (§14 дизайн-дока): интеграции. Поверх ядра (этап 1), главного
треда end-to-end (этап 2) и дочерних тредов (этап 3) теперь есть: менеджер
tool-серверов — локальные in-process серверы `tools/*.ts` (current_datetime,
download_file, files, gmail, web_fetch) и внешние MCP из `mcp-servers/*.json`
(stdio | http), `${secret:NAME}`-секреты с pending до провижининга,
комплектация бандлов (`tools: 'all' | имена`, consent-серверы только по
явному имени); web-поверхность (Koa) с одноразовыми формами секретов и
OAuth-клиентов и OAuth-флоу (`/connect/<server>` → `/oauth/callback`,
discovery + DCR + PKCE, refresh, per-user клиенты); auth-агент в своём треде
с consent-сервером `auth`; reauth-детектор (протухший токен → auth-тред +
notification). Санированные события `connection.*` / `secrets.provisioned` /
`oauth_client.provisioned` адресуются треду-инициатору, redirect в главный
тред при его смерти. Дальше — этап 5: саморасширение (request_capability,
hot-reload).

## Запуск

```bash
cp .env.example .env   # заполнить
npm install
npx prisma migrate deploy
npm run dev            # или: npm run stand (watch), npm start (prod)
```

Node.js 24 или новее.

`npm run rebuild-threads` — пересборка проекции `threads` из лога
(на остановленном процессе).
