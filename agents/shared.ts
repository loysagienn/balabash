// Shared prompt fragments for agent declarations. Not an agent module itself
// (not listed in agents/index.ts), so the "export only `agent`" validation
// does not apply here.

// The Telegram output contract — one canonical block for every agent whose
// messages are delivered into a forum topic. telegram-delivery renders the
// text through markdown-it into Telegram HTML; anything outside this subset
// (tables above all) makes sendMessage fail with a parse error, so the rule
// must reach every prompt from this single place.
export const TELEGRAM_MARKDOWN_NOTE =
  'Use only the simple Markdown subset Telegram renders: **bold**, *italic*, `code`, fenced code blocks, ' +
  'links, blockquotes, simple lists. No tables, no HTML, no images. Never end a turn with empty final text.';

export const TELEGRAM_OUTPUT_NOTE =
  'How your output reaches the user: the final text of each of your turns is sent into the topic. ' +
  `Keep it in the user's language. ${TELEGRAM_MARKDOWN_NOTE}`;

// Projects — the passive libraries in the workspace file area. One canonical
// block for every workbench agent: how to recognize project work, read the
// library before working, and keep it current after.
export const PROJECTS_NOTE =
  "The user's projects — named long-lived work contexts — are visible via projects_list: each is a folder " +
  'in the workspace file area (named by its slug, projects_get shows it) with AGENTS.md as the entry point. ' +
  "When your work concerns a project, read its AGENTS.md BEFORE starting and keep the project's files and " +
  'AGENTS.md current as you go. When finishing a thread that touched a project, update it: at minimum a ' +
  '"touch" via projects_update (a call with only the id bumps its recency), and refresh the description ' +
  'when its topic drifted.';

// The two file areas and the bridge between them — one consistent line for
// every agent whose tool bundle includes the workspace server.
export const WORKSPACE_STORAGE_NOTE =
  'Files live in two areas: the workspace file area (path-addressed; the workspace_* tools and run_script) ' +
  'and Balabash file storage (fileId-addressed; storage_get_file, send_file, end_thread fileIds, message ' +
  'attachments). The bridge: workspace_export_file uploads a workspace file into storage and returns a ' +
  'fileId — the way a produced file reaches the user; workspace_import_file saves a stored file into the ' +
  'workspace file area — including binary files, which workspace_write_file cannot write.';
