// Load installation MCP settings once. Credential-backed services register
// here; the tree installs the discovered claude.ai connectors.
import { probeExternalService } from './mcp-client.ts';
import { readExternalServerConfigs, type ExternalServerConfig } from './server-config.ts';
import { getSecretReferenceNames, resolveExternalServerSecrets } from './server-secrets.ts';
import { registerAccountService, registerSecretServiceSource, type SecretService } from './connections/services.ts';

type Service = SecretService & {
  config: Exclude<ExternalServerConfig, { transport: 'claude-connector' }>;
  version: string | null;
  retryAfter: number;
};
const services: Service[] = [];

async function refresh(): Promise<void> {
  for (const service of services) {
    const { config, secretVersion } = await resolveExternalServerSecrets(service.name, service.config);
    if (!config) {
      Object.assign(service, { connected: false, error: null, version: null, retryAfter: 0 });
      continue;
    }
    if (service.version === secretVersion && (service.connected || Date.now() < service.retryAfter)) continue;
    service.version = secretVersion;
    try {
      await probeExternalService(service.name, config);
      Object.assign(service, { connected: true, error: null, retryAfter: 0 });
    } catch (error) {
      service.connected = false;
      service.error = error instanceof Error ? error.message : String(error);
      service.retryAfter = Date.now() + 60_000;
      console.error(`[connections] failed to probe "${service.name}":`, error);
    }
  }
}

// A refresh can be requested by the console and a credential change together.
// Read the rows again after an earlier probe finishes, including after failure.
let pending = Promise.resolve();
function refreshServices(): Promise<void> {
  pending = pending.then(refresh, refresh);
  return pending;
}

// Called by startTree before the first grants or Connections requests.
export async function loadExternalServices() {
  const connectors: [string, Extract<ExternalServerConfig, { transport: 'claude-connector' }>][] = [];
  for (const [name, config] of Object.entries(await readExternalServerConfigs())) {
    if (config.transport === 'claude-connector') {
      connectors.push([name, config]);
      continue;
    }

    if (config.transport === 'http' && config.auth === 'user') {
      registerAccountService({
        name, url: config.url, description: config.description?.trim() || name, setup: null,
        clientRegistration: config.clientRegistration ?? 'dynamic', scope: config.scope ?? null,
        authorizationParams: config.authorizationParams ?? null, identityProbe: config.identityProbe ?? null,
      });
      continue;
    }

    const secretNames = getSecretReferenceNames(config);
    if (secretNames.length) {
      services.push({
        name, description: config.description ?? null, secretNames, config,
        connected: false, error: null, retryAfter: 0, version: null,
      });
    }
  }

  registerSecretServiceSource({
    list: () => services
      .map(({ name, description, secretNames, connected, error }) => ({ name, description, secretNames, connected, error })),
    refresh: refreshServices,
  });
  return connectors;
}
