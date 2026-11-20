// Shared catalog grants. A declaration may add its own nodes and override
// root capabilities. A profile name can also receive installation extensions.
import type { AgentPassport, CatalogAccess } from '../src/core/contract.ts';

export const accessProfiles: Readonly<Record<string, Omit<CatalogAccess, 'profile'>>> = {
  general: {
    nodes: ['threads', 'drive', 'gmail', 'web', 'web_perplexity', 'notion', 'projects', 'schedule', 'workspace'],
    addRoot: ['get_event', 'fetch_thread_file', 'get_file_url'],
  },
};

// The main thread participates in grants and extension addressing like any
// other agent. Its turn loop lives in src/coordinator.
export const coordinator: AgentPassport = {
  name: 'coordinator',
  description:
    'The secretary of the workspace: owns the main thread, talks with the user there, hands work out to the ' +
    'agents in child threads and relays what they bring back.',
  modes: ['user'],
  defaultMode: 'user',
  agents: ['architect', 'auth', 'browser', 'codex', 'designer', 'engineer', 'gardener', 'image_generator', 'manager', 'scheduler'],
  access: {
    nodes: ['workspace', 'workspace_files', 'workspace_apps', 'threads', 'drive', 'gmail', 'web', 'web_perplexity', 'projects', 'schedule', 'system'],
    addRoot: ['get_event', 'fetch_thread_file'],
  },
};
