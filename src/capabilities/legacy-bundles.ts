// Server passports of the existing bridges. Each disappears with the port
// that replaces it. Keep the exact server sets until then: a catalog node
// and an old server do not necessarily cover the same operations.
const general = [
  'current_datetime', 'events', 'drive', 'gmail', 'http_get', 'notion', 'perplexity', 'projects',
  'remote', 'schedule', 'storage', 'storage_download_file', 'workspace',
];
const maintenance = [...general, 'restart'];

const servers: Record<string, string[]> = {
  architect: general,
  auth: ['auth', 'storage', 'events'],
  browser: ['workspace', 'workspace_files', 'storage'],
  codex: general,
  coordinator: [
    'apps', 'current_datetime', 'events', 'drive', 'gmail', 'http_get', 'perplexity', 'projects', 'remote',
    'schedule', 'storage', 'storage_download_file', 'workspace', 'workspace_files', 'restart',
  ],
  designer: general.filter(server => server !== 'drive'),
  engineer: maintenance,
  gardener: ['current_datetime', 'projects', 'remote', 'storage', 'storage_download_file', 'workspace'],
  image_generator: ['storage'],
  manager: general,
  scheduler: maintenance,
};

export function legacyServers(agent: string): string[] {
  return servers[agent] ?? [];
}
