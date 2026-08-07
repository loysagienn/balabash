# balabash-v2

Тредовая версия balabash: система — множество параллельных ранов над одним
append-only логом событий в Postgres; каждый ран владеет тредом — контекстом
и границей видимости. Строится с нуля по дизайн-доку «Balabash v2 —
архитектура» (Notion); v1 работает рядом как есть, пока v2 не заменит её
фактически.

## Состояние

Этап 3 из 6 (§14 дизайн-дока): дочерние треды. Поверх ядра (этап 1: конверт
с осью тредов, append API с одним хопом/redirect'ом/каскадом, синхронная
проекция `threads`, консьюмеры) и главного треда end-to-end (этап 2:
TG-адаптер, координатор на OpenAI Responses с append-only prompt cache)
теперь есть: каталог динамических агентов (`agents/*.ts`, нативный import с
валидацией), спавн из координатора, Claude Agent SDK harness с in-process
MCP-мостом, агент `discussion`, форум-топики как поверхность дочерних тредов
(создание/закрытие с summary), `/cancel`, notification-уровни, builtin-тулы
`list_threads`/`get_thread`. Дальше — этап 4: интеграции (внешние MCP,
секреты, OAuth, auth-агент).

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
