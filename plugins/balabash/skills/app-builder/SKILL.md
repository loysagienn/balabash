---
name: app-builder
description: Build a Balabash mini-app — answer the user with a working interactive tool instead of a document. Use whenever the user needs a tracker, dashboard, counter, log, viewer, form, checklist, or any small interactive UI over workspace data ("сделай трекер", "хочу дашборд", "форму для записи", "интерактивный список"), or explicitly asks for an app/mini-app/страничку с кнопками. An app is just a workspace folder with a balabash-app.json manifest and .tsx sources — no npm, no build step; the platform runs it in the browser at its own domain and bridges it to the workspace SQLite database through SQL endpoints you declare in the manifest.
---

# Building a Balabash mini-app

An app is a **folder in the workspace file area** containing a `balabash-app.json`
manifest and UI sources. You create it with ordinary file tools in one pass — write
the files directly. There is no scaffold, no registration, no deploy: the folder
existing IS the app existing. Overwrite a file → the app updates on the next page
refresh. Delete the folder → the app is gone.

Derive everything — table shapes, the endpoint set, components, layout, texts — from
the user's actual ask. There is deliberately no stock example to start from: an app
whose form comes from the task always beats one bent out of a template.

## The manifest: balabash-app.json

A single JSON object at the app folder root; unknown keys are rejected. Fields:

- `name` — required string (1–200 chars): the human title, shown in the catalog and
  as the page title.
- `description` — optional string (≤2000): what the app is, for the catalog.
- `entry` — required: path of the root UI module, relative to the app folder (no
  leading slash, no `..`), extension `.tsx`/`.ts`/`.jsx`/`.js`.
- `styles` — optional array of `.css` paths (same relative-path rules); the platform
  links them into the page in order.
- `api` — **the app's entire server side**: an object keyed by endpoint name (an
  identifier). Nothing beyond these declarations is executable from the browser.
  Each endpoint declares:
  - `params` — an object mapping a parameter name (identifier) to its type:
    `string`, `number` or `boolean`; a `?` suffix on the type marks the parameter
    optional (a missing optional binds SQL NULL).
  - `statement` — exactly one SQL statement over the workspace SQLite database.
    Every dynamic value must arrive through a named bind (`:paramName`) declared in
    `params` — never assembled into the SQL text. An undeclared bind, or a declared
    param the statement never uses, fails at call time.
  - `kind` — how the statement runs and what the caller receives: `run` (a write;
    resolves to an object with `changes` and `lastInsertRowid`), `all` (an array of
    rows), `get` (one row or `null`).

Caps per call: 200 rows / 50 KB / 10 s. Design endpoints as narrow slices and
aggregates the UI actually needs, never "select the whole table".

## UI sources

Plain React modules. Allowed imports — ONLY these specifiers resolve:

- `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` — the platform's
  vendored React;
- `@tanstack/react-query` (v5) — the vendored data-layer library;
- `balabash/data` — the data SDK;
- your own files by **relative** path, extension included.

Anything else fails in the browser — there is no npm here.

TanStack Query is the DEFAULT data layer: wrap the app in a query client provider
and drive reads with queries and writes with mutations (queryFn/mutationFn delegate
to `call`), invalidating the affected queries on mutation success. Do not hand-roll
effect-based fetching with manual reload flags — that is where stale closures and
race bugs come from.

The platform generates the page shell around an empty `root` element; the entry
module is loaded as an ES module and must mount the app itself: create a React root
over the element with id `root` (via `createRoot` from `react-dom/client`) and
render your top component into it.

The `balabash/data` SDK exports:

- `call(endpointName, params?)` — executes a declared endpoint; returns a promise
  resolving to the statement result per its `kind`, and rejecting with an `Error`
  carrying the platform's message otherwise. Expired owner auth is not your
  concern — on a 401 the SDK itself sends the browser through the cookie-refresh
  loop.
- `getAppContext()` — `{ mode: 'owner' | 'public', appPath?, slug? }`, if the UI
  wants to adapt to how it is being served.

## Your duties as the author (do these every time)

1. **Create the app's tables yourself** via `data_query` when you create or change the
   app — the platform executes NO DDL, ever. An endpoint over a missing table fails at
   runtime with "no such table". Apps may also read/write existing workspace tables —
   through declared statements only.
2. **Verify the endpoints** after writing them: call each statement once through
   `data_query` (or exercise the app) to catch typos before the user does.
3. **Validate the manifest** before handing the app over — run (from the app folder's
   parent or anywhere):

   ```bash
   node <path-to-this-skill>/validate.mjs <app-folder>
   ```

   It checks the manifest against the platform's own schema and that entry/styles
   files exist.

## Anti-patterns (never do these)

- No `npm`, `node_modules`, bundlers, or build steps inside the app folder — sources
  only; the platform transforms them on the fly.
- No `index.html` — the platform generates the page shell.
- No fetch to external URLs from the app: the browser side talks ONLY to
  `balabash/data`. Server-side integrations are not a thing apps have.
- No ad-hoc SQL from the browser and no SQL string-building — the `api` section is the
  whole perimeter.
- The app's files live in its own folder; don't reference workspace files outside it.

## URLs and publication

- The owner opens the app at `https://balabash.loysagienn.com/apps/<folder-path>`
  (auto-redirects to the execution domain). Give the user this link when the app is
  ready.
- Making the app public (a no-auth URL `https://balabash.app/<slug>` for anyone) is a
  separate explicit action owned by the secretary's `apps_publish` tool — tell the
  user to ask for publication in the main thread if they want a public link.
