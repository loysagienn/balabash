// The world library: canonical fragments of world knowledge — how Balabash
// itself works — one fragment per file, plain exported strings, zero
// machinery. The rule of the instruction layer: every fact has exactly one
// owner; a world fact's owner is its fragment here, and every prompt or tool
// description where the fact appears imports it instead of retelling it.
// Fragments are written neutrally to the consumer: any agent prompt, the
// coordinator instructions and tool descriptions may import them. Assembly is
// by hand — the author of a prompt picks the fragments that agent's situation
// needs.

export { BALABASH_PREAMBLE } from './preamble.ts';
export { PROJECTS_NOTE, PROJECTS_WORLD_NOTE } from './projects.ts';
export { REPO_RULES_NOTE } from './repo-rules.ts';
export { TELEGRAM_MARKDOWN_NOTE } from './telegram-markdown.ts';
export { TELEGRAM_OUTPUT_NOTE } from './telegram-output.ts';
export { THREAD_DIALOGUE_NOTE } from './thread-dialogue.ts';
export { THREAD_NAMING_NOTE } from './thread-naming.ts';
export { WORKBENCH_NOTE } from './workbench.ts';
export { WORKSPACE_STORAGE_NOTE } from './workspace-storage.ts';
