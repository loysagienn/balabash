# Moving an installation to the capability catalog

This file is for the operator and the agents of an installation that still runs a
revision from before pull request #12 ("Agent tools: the capability catalog…").
It holds everything needed to move such an installation: what changes, what the
installation has to rewrite by hand, the two maintenance windows with their
commands, the checks, the way back, and what the first installation ran into.

The file is temporary. It goes away together with the migrator and the reading
of the former formats, once every installation has moved.

## Which revision to move to

Move to a revision of `main` that contains `scripts/migrate-agent-tools.ts`.
Such a revision reads both the former and the new form of the journal, so the
app works at every point of the move.

- Known good: tag `agent-tools-compatible-71437a0` — the code the first
  installation moved on. The merge commit `97def31` on `main` has the same tree.
- If your checkout of `main` no longer has `scripts/migrate-agent-tools.ts`,
  check out the tag, do the whole move there, and update to `main` afterwards.
  A later revision cannot read a database that was not moved.

## What changes for an installation

| Before | After |
|---|---|
| Tools are flat names from tool servers; each harness gets its own list | One tree of nodes and capabilities; an agent opens a vertex with `describe` and calls a capability by its full name |
| `data/tools/<name>.ts` — an in-process MCP server, `export start(ctx)` | `data/nodes/<name>.ts` — a written catalog node, `export const define`. **`data/tools/` is no longer read** |
| `data/mcp-servers/<name>.json` with `enabledTools`, `toolOverrides`; agents name the servers they get | Same directory; `recipients` and `description` in the config; a config with `enabledTools` or `toolOverrides` is rejected |
| `data/remote-agents/<name>.ts` | Same file; the passport also declares `recipients`, `modes`, `defaultMode` |
| Task kinds `note`, `command`, `code`; a code task is `data/workspace/<id>/tasks/<slug>.ts` with `run(ctx)` | Task kinds `note`, `program`; a program is JavaScript kept in the task's row. **Task body files are no longer read** |
| Runs of command tasks in `job_runs` | Every run of a program in `schedule_runs` |
| `tool.call.completed` carries the MCP `result`; `tool.call.failed` carries an error string | `tool.call.completed` carries `value`; `tool.call.failed` carries `{ kind, message, details? }` |

Database: two additive Prisma migrations (`20261120090000_scheduled_programs`,
`20261120150000_event_task_author`). Moving the existing rows is a separate
offline script, `npm run migrate-agent-tools`, in two modes — nothing in the
app's boot runs it.

Gone without a replacement: `get_current_datetime` (the time is in the prompt;
a program uses `new Date()`), the bundled Qase server config and its package,
the `scheduler` agent, the `force` option of a restart. The repository's own
Notion and Perplexity are built-in nodes now (`notion`, `web_perplexity`), not
server configs.

## The order of the move

1. **Preparation**, the app running on the old revision: inventory, rewrite the
   installation's own extensions, translate code tasks, rehearse on a copy of
   the database.
2. **Window 1**, the app stopped: backup, new code, schema, the installation's
   new extension files, the task registry (`--mode tasks`), start.
3. **Between the windows**: the app runs the new code over a mixed journal.
   Check it.
4. **Window 2**, the app stopped: fresh dump, the journal (`--mode journal`),
   start.

The two windows may be days apart. On the first installation window 1 took
about ten minutes of downtime and window 2 about three.

While the app is stopped its agents are unavailable. The windows are run by the
operator in a terminal, or by an external terminal agent such as Claude Code —
see "What the first installation ran into" before handing it the commands.

## Preparation

Do all of this in a second checkout of the new revision (`git worktree add`),
not in the working copy the app runs from.

### 1. Inventory

List what the installation has of its own:

```bash
ls data/tools data/mcp-servers data/remote-agents data/nodes 2>/dev/null
find data/workspace -mindepth 2 -maxdepth 2 -type d -name tasks -exec ls -la {} \;
psql "$DSN" -c "SELECT workspace_id, slug, kind, cron, at IS NOT NULL AS one_shot FROM scheduled_tasks ORDER BY 1, 2"
```

Every file in `data/tools/` and every task of kind `code` needs a hand-written
replacement. Tasks of kind `command` and `note` need nothing.

### 2. `data/tools/<name>.ts` → `data/nodes/<name>.ts`

The former module started an MCP server on loopback and registered tools on it.
The new module returns a description of a node; the platform does the rest.

| Former module | Written node |
|---|---|
| `export async function start(ctx)` returning `ctx.serveMcp(createMcpServer)` | `export const define: DefineInstallationNode = catalog => ({ … })`, synchronous |
| `server.registerTool(name, { description, inputSchema }, handler)` | `capability({ name, summary, description, input, output, run })` |
| Tool name chosen freely, e.g. `foo_report` | Full name = file name + path + capability name joined by `_`: file `foo.ts`, capability `report` → `foo_report` |
| Agents that get the server are named in their passports | `recipients: ['general', …]` in the node — agent names or access profiles (`agents/access.ts`). Empty or absent: scheduled programs only |
| `return ctx.toStructuredResult(data)` | `return data` — a value of the `output` type |
| `return ctx.toErrorResult(error)`, `throw new ctx.ToolError(…)` | `throw new CapabilityError(kind, message, details?)`; any other exception becomes `internal` |
| `ctx.callerWorkspaceId(extra)` | `ctx.caller.workspaceId` (also `threadId`, `agentName`) in `run(input, ctx)` |
| `ctx.filesApi.ingest({ body, workspaceId, … })` | `files.ingest(ctx, { body, originalFilename, contentType, sizeBytes })` → a `FileRef` |
| `ctx.filesApi.open(fileId)` | `files.open(ctx, fileId)` — a file of the caller's workspace |
| `ctx.filesApi.getDownloadUrl` | Not given to a node; return a `FileRef` and let the caller use `get_file_url` |
| Secrets and OAuth handled by the module | `connection` on the node; the platform holds the tokens and secrets and hands a ready authority to `run` |

`define` receives `{ z, node, capability, namedType, CapabilityError,
accountAuthority, secretAuthority, Account, FileId, FileRef, JsonObject,
JsonValue, files }`. Use these, not your own imports of the repository: import
the contract as a type only. Packages from `node_modules` and helper `.ts`
files in a subdirectory are fine.

An example that passes the loader and the catalog build of this revision:

```ts
import type { DefineInstallationNode } from '../../src/tree/authored-nodes.ts';

export const define: DefineInstallationNode = ({ capability, z, CapabilityError, secretAuthority, FileRef, files }) => ({
  summary: 'Weather of the forecast provider: current conditions and chart images',
  recipients: ['general'],
  connection: {
    type: 'secret',
    service: 'weather',
    summary: 'Forecasts of the weather provider on the installation API key',
    secrets: ['WEATHER_API_KEY'],
  },
  children: [
    capability({
      name: 'current',
      summary: 'Get the current conditions of a city',
      description: 'Return the temperature and the wind of the city now. An unknown city is a not_found error.',
      input: z.strictObject({
        city: z.string().describe('The name of the city in English.'),
        units: z.enum(['metric', 'imperial']).optional().describe('Default: metric.'),
      }),
      output: z.strictObject({
        temperature: z.number(),
        windSpeed: z.number(),
        observedAt: z.string().nullable().describe('ISO 8601; null when the provider gave no time.'),
      }),
      async run({ city, units }, ctx) {
        const key = secretAuthority(ctx).secrets.WEATHER_API_KEY;
        const response = await fetch(`https://weather.example/v1/current?city=${encodeURIComponent(city)}&units=${units ?? 'metric'}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: ctx.signal ?? undefined,
        });
        if (response.status === 404) throw new CapabilityError('not_found', `No city "${city}".`);
        if (response.status === 401) throw new CapabilityError('auth_required', 'The provider refused the API key of the installation.');
        if (!response.ok) throw new CapabilityError('external_error', `The provider answered HTTP ${response.status}.`);
        const body = await response.json() as { temp: number; wind: number; time?: string };
        return { temperature: body.temp, windSpeed: body.wind, observedAt: body.time ?? null };
      },
    }),
    capability({
      name: 'chart',
      summary: 'Draw the forecast chart of a city as an image file',
      description: 'Store a PNG chart of the next days in the caller\'s workspace and return its reference.',
      input: z.strictObject({ city: z.string() }),
      output: FileRef,
      async run({ city }, ctx) {
        const png = Buffer.from(city);
        return files.ingest(ctx, { body: png, originalFilename: 'chart.png', contentType: 'image/png', sizeBytes: png.length });
      },
    }),
  ],
});
```

Connections (`src/catalog/definition.ts`, type `Connection`):

- `type: 'secret'` — the installation is connected once; `secrets` names the
  values the operator enters in Connections. In `run`:
  `secretAuthority(ctx).secrets.NAME`.
- `type: 'account'` — each user connects an account by OAuth; `oauth` carries
  `url`, `clientRegistration` (`'dynamic'` or `'manual'`), optional `scope`,
  `authorizationParams`, `identityProbe`; a manual client needs `setup` text.
  The platform adds an `account` field to the input of every capability below.
  In `run`: `await accountAuthority(ctx).accessToken()`; pass the refused token
  as the argument to get a newer one after a 401.
- `service` is the key the accounts, the OAuth client and the secrets are
  stored under. Keep the key the former extension used, so that what is already
  connected stays connected — and confirm it in Connections after the start.

The error kinds are a closed set: `invalid_input`, `unknown_capability`,
`not_found`, `conflict`, `auth_required`, `external_error`, `unavailable`
(no answer came; the outcome is unknown), `internal`.

The catalog build checks every node. A violation skips that one file; the
System screen shows the file name and the reason under `nodes`. The rules that
former tool code most often breaks:

- names are snake_case segments; `mcp__balabash__` plus the full name must fit
  64 characters, so the full name has at most 49;
- `input` is `z.strictObject(…)`; every nested object is strict; field names
  are camelCase;
- no `null` in an input — an optional field is left out; in an output every key
  is always present — use `.nullable()`, never `.optional()`;
- no value of any form: verbatim JSON is typed `JsonValue` or `JsonObject`;
  `kind: "file"` is reserved for `FileRef`;
- a paged list takes `limit` and `cursor` and returns `nextCursor` — all three;
- a capability has a `summary` of one sentence without a final period and a
  `description`; a node summary names no capabilities;
- texts carry no examples ("e.g.", "for example", "Example"); a capability
  named in a text stands in backticks and exists; a named type has a
  description;
- a full name or a service key must not collide with a repository vertex,
  another node or a configured server.

An integration that is not worth carrying over is simply not rewritten: delete
its file, and remove its rows by hand if it stored any (`connections`,
`oauth_clients` under its service key). The migrator does not touch them.

### 3. `data/mcp-servers/<name>.json`

- Remove `enabledTools` and `toolOverrides` — a config with either is rejected.
  Look at what the provider exposes before removing a filter: every tool of the
  server becomes a capability.
- Add `recipients` (agent names or access profiles). Without it no agent gets
  the node; scheduled programs still do.
- Add `description`: its first sentence, up to 175 characters, is what tells an
  agent when to open the node.
- The file name is the node's name and must match `[a-z][a-z0-9_]*`. A name
  that already belongs to a catalog vertex or a service is rejected — delete
  configs that repeat the built-in `notion` and Perplexity.
- A tool's capability name is the tool's own name in snake_case: camelCase is
  split, every character other than a letter, a digit or `_` becomes `_`, the
  result is lower-cased. Its full name is `<file name>_<that name>`.
- stdio: each discovery and each call starts its own process and closes it. A
  server that needs state between calls does not fit. Qase is not bundled any
  more: an installation that uses it adds its own config and package.
- The full format, OAuth (`"auth": "user"`) and claude.ai connectors
  (`"transport": "claude-connector"`) are in `SETUP.md`, "Extension points of
  an installation".

Failures show on the System screen under `mcp-servers`.

### 4. `data/remote-agents/<name>.ts`

Add to the declaration the driver's module returns:

- `recipients` — the agents or access profiles that may start this kind. With
  none, the driver still serves existing threads, but nothing can start a new
  one;
- `modes` (for example `['user', 'headless']`) and `defaultMode`. A passport
  without both mode fields supports both modes and defaults to `user`.

### 5. Scheduled tasks

`--mode tasks` turns every task of kind `command` or `code` into a program.

**Command tasks are translated by the migrator.** The program calls
`workspace_run_command` with the task's command, `cwd` and timeout, prints the
output to the run's console and returns `null` — or, for a task with
`report_on_success`, `{ output: <last 1000 characters of stdout> }`. Nothing to
prepare.

**Code tasks you translate yourself.** For each one put the program body into
`<programs dir>/<workspaceId>/<slug>.js` and pass the directory with
`--programs`. A code task without a translation aborts the whole transaction.
One exception: the bundled `gmail-new-mail` task is recognised by the digest of
its unmodified file and replaced automatically, with its memory seeded from the
last five deliveries. If your copy of that file was edited, it is a code task
like any other.

What a program is (`src/schedule/AGENTS.md`, `src/catalog/program-process.ts`):

- JavaScript, not TypeScript: the body of an async function. In scope are
  `call(name, input)`, `describe(name)`, `console` and the language's own
  globals (`Date`, `JSON`, `Math`, `Promise`…). There is no `require`, no
  `import`, no `process`, no `fetch`, no timers, no database client.
- A failed `call` throws an error with `kind`, `message`, `details`.
- It runs as the task, in the workspace's main thread, with the whole tree of
  the workspace except `end_thread` and `view_file`. Default limit 600 s, at
  most 5 hours. Up to 8 calls of one run are in flight at a time.
- Calls made inside a scheduled program leave no `tool.call.*` events. What the
  operator should see of a run goes to `console.log` — the run keeps the last
  16 KiB.

| Former `run(ctx)` | Program |
|---|---|
| `ctx.pushEvent(payload)` | `return payload` — it lands in the main thread as `schedule.fired`. Returning `null` is silence. One value per run |
| `ctx.tools.call('old_name', args)` | `await call('new_name', input)` — new names, new field names, a typed value back |
| `ctx.tools.list()` to see what is connected | `await describe('')` for the root's children; `await describe('gmail_search_emails')` gives `accounts` |
| `ctx.prisma` to read the task's own past events | `schedule_list_runs` with `slug` and `hasValue: true`, then `schedule_get_run` for the value: a task remembers through what its runs returned |
| `ctx.prisma` for anything else | No database access. Keep state in the workspace (`workspace_query`, files) or run a script with `workspace_run_command` |
| `ctx.workspaceId` | Not needed: the program runs in its workspace |
| An exception | The run is `failed`; a `system.exception` reaches the main thread |
| Imports of packages | None. Logic that needs a package moves into a script of the workspace started with `workspace_run_command` |

A sketch of the pattern — state from the previous run, silence when nothing
changed:

```js
const history = await call('schedule_list_runs', { slug: 'price-watch', hasValue: true, limit: 1 });
let lastPrice = null;
if (history.runs.length) {
  const { value } = await call('schedule_get_run', { runId: history.runs[0].runId });
  lastPrice = value.price;
}
const page = await call('web_get', { url: 'https://shop.example/item/42.json' });
const price = JSON.parse(page.content).price;
console.log('price', price, 'previous', lastPrice);
if (price === lastPrice) return null;
return { price, previous: lastPrice };
```

`scripts/agent-tools/gmail-new-mail.ts` is a full real translation: a
watermark, deduplication over the last five runs, paging, several accounts.

A translated program starts with no memory: before the move its state lived in
events it can no longer read. Decide what the first run should do — report
everything, or start from "now" — and write the program accordingly. Only the
bundled Gmail program gets its memory seeded.

Every task gets `wake: true`: its event starts the secretary's turn at once.
A task is not edited after the move — cancel it and create it again
(`schedule_cancel_task`, `schedule_create_task`).

### 6. Names in texts and scripts

Search the installation's own texts for former tool names: task notes, prompts
and skills of the installation, workspace scripts that read the journal,
project libraries the agents follow. Names not listed pass unchanged.

| Former name | Catalog name |
|---|---|
| `send_file`, `send_images`; the secretary's `send_message` | `send_message` |
| `finish` (browser), `end_thread` | `end_thread` |
| the secretary's spawn functions, `spawn_agent` | `spawn_agent` |
| `workspace_export_file`, `workspace_import_file` | `export_file`, `import_file` |
| `storage_get_file` | `get_file_url`; for the secretary `view_file` |
| `remote_fetch_file` | `fetch_thread_file` |
| `list_threads`, `get_thread`, `get_thread_events` | `threads_list`, `threads_get`, `threads_get_transcript` |
| `create_task`, `list_tasks`, `cancel_task`, `run_task` | `schedule_create_task`, `schedule_list_tasks`, `schedule_cancel_task`, `schedule_run_task` |
| `list_job_runs`, `get_job_run` | `schedule_list_runs`, `schedule_get_run` |
| `request_restart` | `system_request_restart` |
| `data_query` | `workspace_query` |
| `workspace_read_file`, `_write_file`, `_list_files`, `_get_file`, `_delete_file` | `workspace_files_read`, `_write`, `_list`, `_stat`, `_delete` |
| `run_script` | `workspace_run_command` |
| `apps_list`, `apps_publish`, `apps_unpublish` | `workspace_apps_list`, `workspace_apps_publish`, `workspace_apps_unpublish` |
| `http_get`, `storage_download_file` | `web_get`, `web_download` |
| `perplexity_search`, `_ask`, `_reason`, `_research` | `web_perplexity_search`, `_ask`, `_reason`, `_research` |
| `notion-search`, `notion-fetch`, `notion-create-pages`, `notion-update-page`, `notion-list-private-pages` | `notion_search`, `notion_fetch`, `notion_create_pages`, `notion_update_page`, `notion_list_private_pages` |
| `request_authorization`, `request_oauth_client_credentials`, `request_external_server_credentials`, `forget_external_server_credentials`, `rename_connection`, `disconnect_connection` | `connections_authorize`, `connections_request_oauth_client`, `connections_request_secret`, `connections_forget_secret`, `connections_rename`, `connections_disconnect` |

A new name is not only a rename: inputs and outputs changed too (camelCase
fields, `nextCursor` paging, file references instead of content). The source of
truth for a capability is its definition in `src/tree/` — one file per node —
and, on a running installation, `describe` of its name.

### 7. Rehearsal on a copy

Restore a fresh dump into a separate PostgreSQL database. In the second
checkout, with `DATABASE_URL` pointing at that copy:

```bash
npm ci && npm run build
npx --no-install prisma migrate deploy
npm run migrate-agent-tools -- --mode tasks --dry-run --database COPY_NAME \
  --workspaces /path/to/installation/data/workspace --programs /path/to/programs
npm run migrate-agent-tools -- --mode journal --dry-run --database COPY_NAME
```

`--dry-run` runs the same translation, prints the counts and rolls back. Write
the counts down: they are what the real run is compared against. `--database`
must equal `current_database()` of the connection — a guard against running on
the wrong database. `--mode tasks` reads the task files under `--workspaces`
and writes only PostgreSQL.

Run `npm ci` from a plain terminal, not from a shell of a Balabash agent: there
`npm` resolves into the working copy's own `node_modules/.bin`.

## Window 1: new code and the task registry

Before the window: the secretary finishes every thread except the main one;
active sessions and threads are not carried over.

Keep each step in a file and run it with `bash step-N.sh`, each starting with
the same preamble. The preamble is the one the first installation used; the
values at the top are yours:

```bash
# window-env.sh
set -euo pipefail
umask 077
app=/path/to/balabash                 # the working copy the app runs from
name=your_database_name               # must equal current_database()
rev=agent-tools-compatible-71437a0    # the revision you move to
backup=/path/to/balabash-pre-switch   # create once: mkdir -m 700
programs=/path/to/programs            # translated code tasks; programs= if none
cd "$app"
unset DATABASE_URL
DATABASE_URL=$(node --env-file=.env -p 'new URL(process.env.DATABASE_URL).href')
export DATABASE_URL
PGPASSWORD=$(node -p 'decodeURIComponent(new URL(process.env.DATABASE_URL).password)')
export PGPASSWORD
dsn=$(node -p 'const u=new URL(process.env.DATABASE_URL); u.password=""; u.href')
test "$(psql -XAt --dbname="$dsn" -c 'SELECT current_database()')" = "$name"
```

If `psql` rejects a parameter of the Prisma URL (such as `schema`), drop that
one parameter when building `dsn`.

**Step 0 — while the app still runs.** Check the tools (`git`, `node`, `npm`,
`psql`, `pg_dump`, `pg_restore`; `pg_dump` of the server's major version), that
the working tree is clean, that the revision is fetched, and record where you
are:

```bash
source window-env.sh
git fetch origin --tags
test -z "$(git status --porcelain)"
git rev-parse "$rev^{commit}"
git rev-parse HEAD > "$backup/old.commit"
```

**Step 1 — stop the app.** In the terminal of `npm run supervise` press Ctrl-C
and wait for the supervisor and the app to exit. Close every other client of
the database under the app's login (`psql`, an IDE). Then confirm:

```bash
source window-env.sh
pgrep -u "$(id -u)" -fa 'supervisor\.js|dist/app\.js|npm run supervise' || echo 'no app processes'
psql -XAt --dbname="$dsn" -c "SELECT pid, application_name, state FROM pg_stat_activity
  WHERE datname = current_database() AND usename = session_user AND pid <> pg_backend_pid()
    AND backend_type = 'client backend'"
psql -X --dbname="$dsn" -c "SELECT kind, count(*) FROM scheduled_tasks GROUP BY kind" \
  -c "SELECT (SELECT count(*) FROM job_runs) AS former_runs"
```

`pgrep` also lists other Node apps of the same user — look at the working
directory of what it prints. The second query must return no rows.

**Step 2 — backup.** The dump is the only complete way back.

```bash
source window-env.sh
stage=$(mktemp -d "$backup/main.partial.XXXXXXXX")
PGOPTIONS='-c default_transaction_read_only=on' pg_dump -Fc --dbname="$dsn" -f "$stage/database.dump"
pg_restore --list "$stage/database.dump" > "$stage/database.toc"
cp -p .env "$stage/env.main"
find data/workspace -mindepth 2 -maxdepth 2 -type d -name tasks -print0 |
  tar --null -T - -czf "$stage/task-bodies.tar.gz"
for dir in data/remote-agents data/tools data/nodes data/mcp-servers; do
  if [[ -d "$dir" ]]; then cp -a --parents "$dir" "$stage"; fi
done
mv -T "$stage" "$backup/main"
if [[ -d dist-last-good ]]; then mv -T dist-last-good "$backup/dist-last-good.main"; fi
```

Moving `dist-last-good` away matters: after three quick crashes the supervisor
falls back to that bundle, and the old bundle must not run on a moved task
registry.

Optional, for comparing what the models see before and after: before this step
run `npm run render-context -- <workspaceId>` and copy `data/showcase` into the
backup. With several workspaces in the database the script refuses to guess —
the id is required.

**Step 3 — code and schema.**

```bash
source window-env.sh
test -f "$backup/main/database.toc"
git merge --ff-only "$rev"        # or: git switch --detach "$rev"
npm ci
npm run build
npx --no-install prisma migrate deploy
npx --no-install prisma migrate status
```

Go on only after a clean `migrate status`.

**Step 4 — the installation's files.** Put the rewritten extensions in place:
`data/nodes/`, the edited `data/mcp-servers/*.json` and
`data/remote-agents/*.ts`. Move `data/tools/` away — it is not read, and its
copy is in the backup. Leave the task body files where they are until step 5:
the migrator reads them.

**Step 5 — the task registry.**

```bash
source window-env.sh
run_ids() { psql -XAt --dbname="$dsn" -v ON_ERROR_STOP=1 -c 'SELECT id FROM schedule_runs' | LC_ALL=C sort; }
if [[ ! -e "$backup/before" ]]; then
  stage=$(mktemp -d "$backup/before.partial.XXXXXXXX")
  psql -Xq --dbname="$dsn" -v ON_ERROR_STOP=1 \
    -c "COPY (SELECT id,kind,command,cwd,timeout_ms,report_on_success FROM scheduled_tasks WHERE kind IN ('command','code') ORDER BY id) TO STDOUT WITH CSV HEADER" > "$stage/task-fields.csv"
  run_ids > "$stage/runs.before"
  mv -T "$stage" "$backup/before"
fi
move=(npm run migrate-agent-tools -- --mode tasks --database "$name" --workspaces "$PWD/data/workspace")
if [[ -n ${programs:-} ]]; then move+=(--programs "$programs"); fi
"${move[@]}" | tee -a "$backup/tasks.log"
if [[ ! -e "$backup/gmail-seeds.txt" ]]; then
  run_ids > "$backup/runs.after"
  LC_ALL=C comm -13 "$backup/before/runs.before" "$backup/runs.after" > "$backup/gmail-seeds.txt"
fi
"${move[@]}" | tee -a "$backup/tasks-repeat.log"
psql -X --dbname="$dsn" -v ON_ERROR_STOP=1 \
  -c 'SELECT kind,count(*) FROM scheduled_tasks GROUP BY kind' \
  -c 'SELECT (SELECT count(*) FROM job_runs) AS former_runs, (SELECT count(*) FROM schedule_runs) AS runs'
```

Expected: the first run prints `{"tasks":T,"seeds":S}` equal to the rehearsal
(`T` — the number of command and code tasks; `S` — 5 with the bundled Gmail
task, else 0); the repeat prints zeros; the registry holds only `program` and
`note`; `former_runs` is unchanged. The files in `before/` and
`gmail-seeds.txt` are what the targeted way back needs.

The migrator works in one transaction: on any failure nothing changed. Its
usual refusal is `Close other database connections before migrating: […]` —
close the named client and repeat the step.

**Step 6 — start.** In the operator's own terminal:

```bash
(u=$(umask); source window-env.sh; unset PGPASSWORD DATABASE_URL; umask "$u"; npm run supervise)
```

The `umask` dance keeps the app from inheriting `077` from the preamble —
otherwise every file the app and its agents create would be owner-only.
Running `npm run render-context -- <workspaceId>` before the start and reading
`data/showcase/` shows what each agent now sees, the installation's nodes
included.

## Between the windows: what to check

- The System screen: nothing under `nodes` and `mcp-servers`; Connections shows
  the services of the installation's nodes with their accounts and secrets.
- An agent that should get an installation node sees it in its core and can
  `describe` and call a capability; an agent that should not, does not.
- Schedule: every task is there with its next run; the list of runs pages
  through the former runs; the card of a former command run opens.
- The first runs of each program: a silent run is a `schedule_runs` row with
  status `ok` and no value; a returned value arrives in the main thread; a
  failure is a row with the error plus a `system.exception`.
- The Gmail program does not report again what was already reported.
- The feed, `get_event` and the transcript show a former successful call, a
  former failed call and a new call.
- No `system.exception` since the start.

## Window 2: the journal

One transaction of `--mode journal`:

- every row of `job_runs` moves into `schedule_runs` with its id;
- historical `tool.call.*` events get the catalog names (the table above);
- a former result becomes `value`; a result with `isError` becomes
  `tool.call.failed`; an error string becomes `{ kind: 'external_error', message }`.

The number of events does not change. Names of the installation's own former
tools are not in the migrator's table and stay as they were written; they read
fine.

Stop the app as in step 1 of window 1 and confirm it is stopped. Then:

```bash
source window-env.sh
psql -X --dbname="$dsn" -v ON_ERROR_STOP=1 \
  -c 'SELECT (SELECT count(*) FROM job_runs) AS former_runs, (SELECT count(*) FROM schedule_runs) AS runs' \
  -c "SELECT count(*) AS old_form FROM events WHERE (type='tool.call.completed' AND payload ? 'result') OR (type='tool.call.failed' AND jsonb_typeof(payload->'error')='string')"
if [[ ! -e "$backup/journal" ]]; then
  stage=$(mktemp -d "$backup/journal.partial.XXXXXXXX")
  PGOPTIONS='-c default_transaction_read_only=on' pg_dump -Fc --dbname="$dsn" -f "$stage/database.dump"
  pg_restore --list "$stage/database.dump" > "$stage/database.toc"
  mv -T "$stage" "$backup/journal"
fi
move=(npm run migrate-agent-tools -- --mode journal --database "$name")
"${move[@]}" | tee -a "$backup/journal/journal.log"
"${move[@]}" | tee -a "$backup/journal/journal-repeat.log"
psql -X --dbname="$dsn" -v ON_ERROR_STOP=1 \
  -c 'SELECT (SELECT count(*) FROM job_runs) AS former_runs, (SELECT count(*) FROM schedule_runs) AS runs' \
  -c "SELECT count(*) AS old_form FROM events WHERE (type='tool.call.completed' AND payload ? 'result') OR (type='tool.call.failed' AND jsonb_typeof(payload->'error')='string')"
```

Expected, with the numbers printed before the move:

- first run `{"jobs":J,"renamed":R,"completed":C,"failures":F}`: `J` equals
  `former_runs` before, `C + F` equals `old_form` before;
- the repeat prints four zeros;
- after: `former_runs` 0, `runs` = `former_runs` + `runs` before, `old_form` 0.

Start the app with the command of step 6. Open again the same former call, the
former error and the card of a former run.

For scale, the first installation: 137 554 events, 3688 former runs;
`renamed` 10 381, `completed` 8628, `failures` 23; the transaction took about
40 seconds against a remote database. A row-by-row comparison with the dump
afterwards showed no event outside `tool.call.*` changed and every change
matching the rules above.

## The way back

| Stopped at | What has changed | Going back |
|---|---|---|
| before step 5 of window 1 committed | code, `node_modules`, two additive migrations | check out `old.commit`, `npm ci`, restore `dist-last-good`, start. The two migrations stay in the database; on a rehearsal copy the old code took such a schema as current. Not done live |
| after step 5 | tasks are programs; Gmail seeds added | the targeted way back below, or restore the dump of step 2 |
| in window 2, the first run failed | nothing: the transaction rolled back | start the app; repeat the window later |
| after window 2 committed | the journal is in the new form | only the dump of window 2. The new code needs nothing undone — it works on a moved journal |

The targeted way back after step 5 restores the original task fields from
`before/task-fields.csv` and deletes exactly the seeded rows. It was designed
and reviewed but **never executed on a live installation**. First save and
remove in Schedule every program created after the move; then, with the app
stopped:

```bash
source window-env.sh
cd "$backup"
psql -X --dbname="$dsn" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
LOCK TABLE scheduled_tasks, schedule_runs IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE original_tasks AS
  SELECT id,kind,command,cwd,timeout_ms,report_on_success FROM scheduled_tasks WITH NO DATA;
\copy original_tasks FROM 'before/task-fields.csv' WITH CSV HEADER
CREATE TEMP TABLE gmail_seeds (id text PRIMARY KEY);
\copy gmail_seeds FROM 'gmail-seeds.txt'
DO $$ DECLARE new_slugs text; BEGIN
  SELECT string_agg(t.slug, ', ' ORDER BY t.slug) INTO new_slugs FROM scheduled_tasks t
    WHERE t.kind='program' AND NOT EXISTS (SELECT FROM original_tasks o WHERE o.id=t.id);
  IF new_slugs IS NOT NULL THEN
    RAISE EXCEPTION 'Save and remove these new programs in Schedule before rollback: %', new_slugs;
  END IF;
END $$;
UPDATE scheduled_tasks t SET kind=o.kind, command=o.command, cwd=o.cwd, timeout_ms=o.timeout_ms,
  report_on_success=o.report_on_success, code=NULL FROM original_tasks o
  WHERE t.id=o.id AND t.kind='program';
DELETE FROM schedule_runs r USING gmail_seeds s WHERE r.id=s.id;
COMMIT;
SQL
```

Then return the code (`git switch --detach "$(cat "$backup/old.commit")"`), the
`.env` copy, `dist-last-good`, the former `data/tools` and configs from
`$backup/main`, run `npm ci` and start. Events and runs written by the new code
stay; the old code shows a new successful call without its value.

Restoring a dump into the live database is not described here and was not
rehearsed.

## What the first installation ran into

- **`set -e` does not work inside the Bash tool of Claude Code.** A pasted
  `( set -euo pipefail; false; echo next )` prints `next` and returns 0, so a
  block would run on past a failed check. Run every step as a file in a new
  process (`bash step-N.sh`); do not paste the commands into the tool.
- **`render-context` without a workspace id fails** when the database has more
  than one workspace. It was the one step never rehearsed live, and the one
  that failed in the window.
- **`umask 077` leaks into the app** if `npm run supervise` is started from the
  shell that sourced the preamble. Use the start command of step 6.
- **The supervisor's fallback bundle.** `dist-last-good` from the old code must
  be out of the way before the new code starts.
- **`npm` in an agent's shell** resolves into `node_modules/.bin` of the
  working copy; `npm ci` from there would delete its own binary.
- **The migrator refuses any other client** under the app's login, idle ones
  too, and waits at most five seconds for each table lock.
- **A step's log should carry its outcome.** Write `OK` or the failed command
  into the same file as the output: the first installation's logs held only the
  output, and the outcome of a step had to be inferred afterwards.
- **Do not plan a rollback as the main safety net.** After window 1 the choice
  was to fix problems on top of the new code; the targeted way back was never
  needed.

## What was and was not exercised

Exercised live on the first installation: both windows, the translation of four
command tasks and the bundled Gmail task, the Anthropic secretary, Claude and
Codex agents on the catalog, the built-in nodes, reading of the mixed and of
the moved journal.

Not exercised there, because that installation had none: written nodes in
`data/nodes/`, configs in `data/mcp-servers/`, remote agent passports,
`--programs` with a hand-translated code task, a secretary on an
OpenAI-compatible gateway. These paths are covered by the repository's tests
(`src/tree/authored-nodes.test.ts`, `configured-servers.test.ts`,
`connectors.test.ts`, `scripts/agent-tools/migration.test.ts`), not by a live
move. Check them with extra care in the rehearsal and between the windows.

Also not observed live at the time of writing: Gmail deduplication on a real
incoming letter, and a restart requested through an agent on the new code.
