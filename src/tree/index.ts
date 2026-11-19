// The tree of Balabash: the real vertices of the capability catalog, written
// over its core (src/catalog) — the root with its guide, the capabilities of
// the root and the nodes. The core stands on its own; here the definitions
// meet the app: an action takes its data from the app's own layers (the
// log, the threads, the storage).
//
// - index.ts — the root: its summary, its guide and its children;
// - events.ts — the type Event and `get_event`;
// - threads.ts — the node `threads` and the type Thread;
// - projects.ts — the node `projects` and the type Project;
// - files.ts — a stored file as a FileRef and the file capabilities of the
//   root: `export_file`, `import_file`, `get_file_url`, `view_file`;
// - workspace.ts — the node `workspace` with `query` and `run_command`;
//   workspace-files.ts and workspace-apps.ts — its nodes `files` (with the
//   type WorkspaceFile) and `apps`;
// - file-area.ts — the workspace file area as the tree reaches it: the path
//   a caller names, the workbench a write needs;
// - cursor.ts — the cursor of a list paged along the log;
// - transcript.ts — the course of a thread as text.
//
// A recipe of the root joins its guide together with the capability it
// names: the build lets no recipe through that requires what the tree does
// not have.

import { buildCatalog, type Catalog, type RootDefinition } from '../catalog/index.ts';
import { getEvent } from './events.ts';
import { fileCapabilities } from './files.ts';
import { projects } from './projects.ts';
import { threads } from './threads.ts';
import { workspace } from './workspace.ts';

export const root: RootDefinition = {
  summary: 'Everything Balabash can do for you.',
  guide: [
    {
      text: 'Capabilities form a tree. `describe` a node to get its guide and one line per child; `describe` a capability to get its full description and exact signature. Describe a capability before its first call unless its signature is already in your context.',
      requires: ['describe'],
    },
    { text: 'Pass exactly the fields of the signature and leave an optional field out.' },
    { text: 'Call a described capability through `call` by its full name.', requires: ['call'] },
    {
      text: 'A chain of calls whose intermediate results you do not need to see goes into `run_program`: you get only what the program returns.',
      requires: ['run_program'],
    },
    {
      text: 'A failed call gives an error with a kind. invalid_input, unknown_capability, not_found, conflict: change the call. auth_required: the user has to connect or re-authorize the account. external_error: the outside system refused; read its message. unavailable: no answer came and the outcome is unknown; before retrying a write, check whether it took effect. internal: a defect of Balabash; report it.',
    },
    {
      text: 'Lists page one way: pass `nextCursor` of a result as `cursor` to get the next page; null means there is nothing more.',
    },
    {
      text: "A node that works with the user's accounts lists them in `describe`; each of its capabilities takes `account`, the address of the account to act as.",
      requires: ['describe'],
    },
    {
      text: 'A file in a result is a reference, never content. Where an input asks for a file, pass the id of the reference.',
    },
    {
      text: 'To work with the content of a stored file, put it into the workspace file area with `import_file`.',
      requires: ['import_file'],
    },
    {
      text: 'A file you produced in the workspace file area becomes a reference with `export_file`.',
      requires: ['export_file'],
    },
    { text: 'To look at a stored image, PDF or text yourself, use `view_file`.', requires: ['view_file'] },
    {
      text: 'When something outside Balabash has to fetch a stored file itself, give it the address from `get_file_url`.',
      requires: ['get_file_url'],
    },
    {
      text: "A reference handed to you names a thread and an event seq: read the event with `get_event` first. A thread's final report is its thread.completed event.",
      requires: ['get_event'],
    },
  ],
  children: [
    fileCapabilities.exportFile,
    fileCapabilities.importFile,
    fileCapabilities.getFileUrl,
    fileCapabilities.viewFile,
    getEvent,
    threads,
    projects,
    workspace,
  ],
};

let built: Catalog | null = null;

// The catalog of this installation, built once: a broken rule of the scheme
// stops the first use.
export function catalog(): Catalog {
  built ??= buildCatalog(root).catalog;

  return built;
}
