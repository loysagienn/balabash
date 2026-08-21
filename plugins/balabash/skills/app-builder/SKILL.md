---
name: app-builder
description: Build a Balabash mini-app — answer the user with a working interactive tool instead of a document. Use whenever the user needs a tracker, dashboard, counter, log, viewer, form, checklist, or any small interactive UI over workspace data ("сделай трекер", "хочу дашборд", "форму для записи", "интерактивный список"), or explicitly asks for an app/mini-app/страничку с кнопками. An app is just a workspace folder with a balabash-app.json manifest and .tsx sources — no npm, no build step; the platform runs it in the browser at its own domain and bridges it to the workspace SQLite database through SQL endpoints you declare in the manifest.
---

# Building a Balabash mini-app

An app is a **folder in the workspace file area** containing a `balabash-app.json`
manifest and UI sources. You create it with ordinary file tools in one pass. There is
no registration, no deploy: the folder existing IS the app existing. Overwrite a file →
the app updates on the next page refresh. Delete the folder → the app is gone.

Start by copying the `template/` folder next to this file into the workspace and
renaming it; then edit.

## The manifest: balabash-app.json

```json
{
  "name": "Habit Tracker",
  "description": "What this app is, for the catalog",
  "entry": "index.tsx",
  "styles": ["styles.css"],
  "api": {
    "addEntry": {
      "params": { "habit": "string", "note": "string?" },
      "statement": "INSERT INTO habit_entries (habit, note) VALUES (:habit, :note)",
      "kind": "run"
    },
    "listEntries": {
      "params": {},
      "statement": "SELECT * FROM habit_entries ORDER BY id DESC",
      "kind": "all"
    }
  }
}
```

- `entry` — the root module (`.tsx/.ts/.jsx/.js`), rendered into `<div id="root">`.
- `styles` — optional `.css` files, linked into the page by the platform.
- `api` — **the app's entire server side**: named SQL statements over the workspace
  SQLite database. Nothing beyond these declarations is executable from the browser.
  - `params`: `string | number | boolean`, suffix `?` = optional (missing optional
    binds NULL). Values reach SQL ONLY through named binds (`:name`) — never
    concatenate.
  - `kind`: `run` (write; returns `{changes, lastInsertRowid}`) | `all` (rows) |
    `get` (one row or null).
  - Caps per call: 200 rows / 50 KB / 10 s. Design endpoints to return narrow slices
    or aggregates, never whole tables.

## UI sources

Plain React modules. Allowed imports — ONLY these, nothing else resolves:

- `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` — the platform's
  vendored React;
- `balabash/data` — the data SDK;
- your own files by **relative** path (`./list.tsx`).

Entry boots itself:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';

createRoot(document.getElementById('root')!).render(<App />);
```

Data access — `call(name, params)` from `balabash/data`, returning the statement
result per its `kind`:

```tsx
import { call } from 'balabash/data';

const rows = await call('listEntries');
await call('addEntry', { habit: 'run', note: '5k' });
```

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
