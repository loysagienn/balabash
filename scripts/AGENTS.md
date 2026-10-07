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
npm run build && npm run render-context [-- <userId>]
```

With one user in the database the userId is inferred; with several the
script lists them and exits. Connecting per-user servers (gmail, notion) may
hit the network; a server that fails to connect is reported inside the
output instead of failing the run. Safe to run next to the live app: it
renders texts and never journals events or calls tools.
