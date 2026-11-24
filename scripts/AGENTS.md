# scripts/

Offline maintenance scripts of the Balabash repository. They are not part of
the running app: each is bundled by `npm run build` into its own `dist/`
entry (see `build/server.js` entryPoints) and run manually with an npm
script. They read `.env` themselves (`--env-file`) and talk to the same
database and tool servers as the app — run them from the repository root.

## rebuild-threads (`scripts/rebuild-threads.ts`)

Rebuilds the threads projection from the event log: truncate + replay. The
projection is secondary by design; run this offline, with the app process
stopped.

```
npm run build && npm run rebuild-threads
```

## cleanup-sessions (`scripts/cleanup-sessions.ts`)

One-time removal of the SDK sessions that accumulated before the daily
retention sweep (`src/capabilities/session-cleanup.ts`) existed and belong to
no thread the journal can ask: Claude transcripts older than N days in the
CLI's project directories of Balabash's own agents (`data/workspace/*/files`,
`data/agent-state/*` — never the operator's interactive projects), Codex
rollouts and generated images older than N days in `data/codex-home`. The
sessions of active threads are spared. Each session goes through its SDK's
own means (`deleteSession`, `codex delete --force`). Without `--apply` it is
a dry run that lists what would go, with sizes; safe next to the live app.

```
npm run build && npm run cleanup-sessions [-- --older-than 7] [-- --apply]
```

## console-icons (`scripts/console-icons.mjs`)

Renders the icons of the browser extension (`src/browser-extension/icons/icon-16/32/48/128.png` — the cropped
mark, as the favicons) and the console's app icons (`src/console/public/*.png`: the tab's
`favicon-32/192`, install icons 192/512 `any` and `maskable`,
`apple-touch-icon` 180) from the approved service icon — the pair of 1254 px
PNGs in the project library, `balabash/design/balabash-icon-transparent.png`
and `balabash-icon-dark.png` (their `design/README.md` names them) — with
headless Chromium (playwright, a devDependency): the favicons are the
transparent one cropped to its visible pixels (alpha ≥ 2) and fitted into the
square by its longer side — the mark is 771 × 975, so it runs from the top
edge to the bottom one and is centered across, ~10.5 % of the width clear at
each side (the square canvas; Chromium stretches a non-square favicon to a
square, so the canvas stays square) — the `any` icons are the transparent one
as is, the maskable ones put it at 86 % over `--bg` (the safe zone is the
inner 80 % circle), the Apple icon is the dark one as is. The script measures
each favicon it rendered and fails before writing when the mark does not
reach both edges along its longer side, is off center or holds a margin
wider than the proportions allow; the log names the crop box and the
margins. Not bundled and not part of the build: the PNGs are committed, and
the script runs again only when the icon changes (a run on the approved pair
reproduces the committed PNGs byte for byte).

```
node scripts/console-icons.mjs <balabash-icon-transparent.png> <balabash-icon-dark.png>
```

## render-context (`scripts/render-context.ts`)

The instruction-layer showcase: materializes, per model, what that model
actually sees — the assembled system prompt, the initialMessage template, the
SDK catalog definitions and their port-specific metadata — one markdown
file per agent plus `coordinator.md` for the secretary, written into
`data/showcase/` (overwritten on every run). It walks the same code paths as
the live app (agent catalog, Claude and Codex catalog ports,
the configured coordinator port), so the output is the truth, not a
retelling.

This is the verification instrument for any work on prompts and tool
descriptions: run it before and after a change and diff the output.

```
npm run build && npm run render-context [-- <workspaceId>]
```

With one user in the database the workspaceId is inferred; with several the
script lists them and exits. Each SDK agent file and the coordinator file include an independent first opening of each granted vertex.
Claude shows the JSON text returned by its MCP bridge, Codex the structured content, and the coordinator the text and definition of its configured port. The script reads the workspace grant and accounts without invoking capabilities or journaling calls.

## measure-context (`scripts/measure-context.ts`)

The context measure: what the model of an agent's session actually received
in its first request — our prompt and everything the SDK's CLI added around
it: the CLI prefix, the dynamic block (environment, deferred tool names,
sub-agent types, skill listing, mode reminders, date), the system reminders
folded into the first user message (project instructions found from cwd up,
session context, commit attribution), the native tool definitions — each with
its size in chars and an estimate of its tokens (the request's real usage
spread over its chars), plus the request's real token usage. Where
`render-context` shows the instruction layer Balabash composes,
`measure-context` shows the whole request the session's transcript recorded;
together they tell what is ours and what is the CLI's. The instrument of the
work on the agents' context composition (`claude-prompt-composition.md` in
the project library): measure before and after a change and diff the output.

Sources: Claude — the CLI's transcript (`attachment` records, one per element
of the dynamic block and of the reminders; `api-request-shape` with the
system blocks and the tool definitions as sent, CLI ≥ 2.1.3xx, or the
`prompt_snapshot` attachments of older CLIs; `api-request-blob` messages; the
first `assistant` record's usage). Codex — the rollout (`session_meta`,
`turn_context`, the developer and user items of the first turn, the first
`token_count`); the Codex binary's own system prompt and tool definitions are
not written to the rollout, so for Codex only their total is measurable (the
input tokens minus the known texts).

By default the newest session of every repository agent found in the stores
of this installation: the Claude project directories derived from the agents'
cwds (`data/workspace/*/files`, `data/agent-state/*`, the repository root
for historical transcripts, shared with the operator's own sessions) and the
Codex rollouts of `data/codex-home`. A session is attributed to its agent by
the journal (`session.sdk` of its thread) when it knows it, else by the
system prompt's head against the catalog's instructions (within the session's
SDK — manager and codex share one brief), else by its agent-state directory;
unattributed sessions are skipped. Agents without a session in the stores are
named in the log. Output: `data/context-measure/<agent>.md` per session plus
`summary.md` (overwritten on every run); `--session <id>` measures that one
session into `<agent>-<id>.md`. Read-only: it reads transcripts and the
journal and writes the reports; safe next to the live app.

```
npm run build && npm run measure-context [-- --session <id>] [-- --out <dir>]
```

## migrate-agent-tools

Offline step 3 of the agent-tools move. Restore a current dump into a separate PostgreSQL
database and deploy the branch's Prisma migrations there first. Set DATABASE_URL to the
restored database. The --database argument must match current_database() on that connection.

    npm run migrate-agent-tools -- --mode tasks --database NAME --workspaces /path/to/data/workspace

At cutover, `tasks` moves the task registry and seeds Gmail memory. Run `journal` in a
second offline window after verifying the branch on mixed history:

    npm run migrate-agent-tools -- --mode journal --database NAME

Use `--dry-run` on the restored copy to run the same translation and report the counts after
rolling the transaction back. Both modes require the application and scheduler to stay offline
for the target database. The script refuses other client connections with its login, including
idle ones. It waits up to five seconds to acquire each table lock (for example during
autovacuum) and excludes concurrent writes throughout the transaction. Stop writers before the
maintenance window and keep them stopped until verification is complete.

The migration reads workspace task files and writes only PostgreSQL. Without `--dry-run` it
prints changed-row counts after commit. Running it again should give zeros. On failure every
change rolls back.

Command tasks are translated directly. The bundled Gmail program recognizes the original
module by its digest and takes its initial memory from that workspace's last five deliveries.
For another code task, supply its reviewed JavaScript program body in
`--programs DIR` under `<workspaceId>/<slug>.js`. A custom program takes responsibility
for its own initial state. A task without a translation aborts the transaction.
Historical job runs retain their ids, positions and the values shown by the schedule reader.

## browser-link-check (`scripts/browser-link-check.ts`)

The end-to-end check of the browser link (`src/browser-link`,
`src/browser-extension`) on this host: a Chromium with the extension plays
the user's browser. The script builds the extension for a stand of its own —
a console origin that exists only inside that Chromium, a temporary
directory — so it needs no installation and touches neither the app nor its
database. It prints a line per step and exits non-zero on the first failure;
the head of the script lists what the steps cover — the pairing and the
link, and an agent's run in the browser built the way `user_browser` builds
it (`agents/kit/user-browser.ts`, the tools of `agents/kit/playwright.ts`).
One step leaves two sessions silent before using them again: 90 seconds by
default, `--silence=<seconds>` changes it; 0 skips it, and with it the step
that waits a minute for the user's answer about a tab. Not bundled:
run from the source. Run it after every update of Playwright:
`src/browser-link/cdp-model.ts` repeats what Playwright expects of a browser.

```
node scripts/browser-link-check.ts [--silence=<seconds>]
```
