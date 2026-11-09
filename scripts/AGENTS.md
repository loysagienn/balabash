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

Renders the console's app icons (`src/console/public/*.png`: the tab's
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
bridge base verbs and the descriptions of its real tool bundle — one markdown
file per agent plus `coordinator.md` for the secretary, written into
`data/showcase/` (overwritten on every run). It walks the same code paths as
the live app (agent catalog, tool-manager bundles, session-run base verbs,
coordinator function definitions), so the output is the truth, not a
retelling.

This is the verification instrument for any work on prompts and tool
descriptions: run it before and after a change and diff the output.

```
npm run build && npm run render-context [-- <workspaceId>]
```

With one user in the database the workspaceId is inferred; with several the
script lists them and exits. Connecting per-user servers (gmail, notion) may
hit the network; a server that fails to connect is reported inside the
output instead of failing the run. Safe to run next to the live app: it
renders texts and never journals events or calls tools.
