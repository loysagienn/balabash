// The installation MCP configs that appear on the Connections screen.
// Their status is the last probe. Agent capabilities come from src/tree.
import { probeExternalService } from './mcp-client.ts';
import { readExternalServerConfigs, type ExternalServerConfig } from './server-config.ts';
import { getSecretReferenceNames, resolveExternalServerSecrets } from './server-secrets.ts';
import { registerAccountService, registerSecretServiceSource, type SecretService } from './connections/services.ts';

type Service = SecretService & {
  config: ExternalServerConfig;
  version: string | null;
  retryAfter: number;
};
const services: Service[] = [];

export function listClaudeConnectorTargets() {
  return services
    .filter(service => service.config.transport === 'claude-connector')
    .map(({ name, description, connected, error }) => ({ name, description, connected, error }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

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

// Called once at boot before startTree registers catalog services and refreshes
// all sources. Only a service shown to the operator has a reason to be probed.
export async function loadExternalServices(): Promise<void> {
  for (const [name, config] of Object.entries(await readExternalServerConfigs())) {
    if (config.transport === 'http' && config.auth === 'user') {
      registerAccountService({
        name, url: config.url, description: config.description?.trim() || name, setup: null,
        clientRegistration: config.clientRegistration ?? 'dynamic', scope: config.scope ?? null,
        authorizationParams: config.authorizationParams ?? null, identityProbe: config.identityProbe ?? null,
      });
      continue;
    }

    const secretNames = getSecretReferenceNames(config);
    if (secretNames.length || config.transport === 'claude-connector') {
      services.push({
        name, description: config.description ?? null, secretNames, config,
        connected: false, error: null, retryAfter: 0, version: null,
      });
    }
  }

  registerSecretServiceSource({
    list: () => services.filter(service => service.secretNames.length)
      .map(({ name, description, secretNames, connected, error }) => ({ name, description, secretNames, connected, error })),
    refresh: refreshServices,
  });
}
