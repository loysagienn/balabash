// Projects — the passive libraries in the workspace file area. Two layers:
// the world kernel (what a project IS — imported by anyone, the coordinator
// included) and the workbench duty note (how a working agent treats a
// project's library — imported by workbench agents).

export const PROJECTS_WORLD_NOTE =
  "The user's projects are named long-lived work contexts — passive libraries: each is a folder in the " +
  'workspace file area, named by its immutable slug, with AGENTS.md as the entry point, plus a registry ' +
  'record (title and a ~300-char description — the scent a conversation is matched against). A project ' +
  'is not a unit of work: no status, no progress, no completion; nothing links threads or tasks to a project.';

export const PROJECTS_NOTE =
  `${PROJECTS_WORLD_NOTE} The registry is visible via projects_list (projects_get shows one project with ` +
  "its folder). When your work concerns a project, read its AGENTS.md BEFORE starting and keep the project's " +
  'files and AGENTS.md current as you go. When finishing a thread that touched a project, update it: at ' +
  'minimum a "touch" via projects_update (a call with only the id bumps its recency), and refresh the ' +
  'description when its topic drifted.';
