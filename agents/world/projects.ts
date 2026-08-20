// Projects — the passive libraries in the workspace file area. Two layers:
// the world kernel (what a project IS — imported by anyone, the coordinator
// included) and the workbench duty note (how a working agent treats a
// project's library — imported by workbench agents).

export const PROJECTS_WORLD_NOTE =
  "The user's projects are named long-lived work contexts — passive libraries: each is a folder in the " +
  'workspace file area, named by its immutable slug, with AGENTS.md as the entry point. A project is not ' +
  'tied to any thread.';

export const PROJECTS_NOTE =
  `${PROJECTS_WORLD_NOTE} The registry is visible via projects_list (projects_get shows one project with ` +
  'its folder). When your work concerns a project, read its AGENTS.md BEFORE starting. Anything new worth ' +
  "keeping — results, decisions, learned facts — APPEND to the project's inbox.md, dated, with the \"why\"; " +
  "do not rewrite the project's settled files unless the task itself asks for it — a dedicated gardener " +
  'agent consolidates later. When finishing a thread that touched a project, touch it via projects_update ' +
  '(a call with only the id bumps its recency); refresh the description when its topic drifted.';
