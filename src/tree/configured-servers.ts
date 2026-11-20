// Installation MCP servers. Discovery is a background/Connections operation.
// A turn uses the published contract and resolves the call's own authority.
import { CapabilityError, secretAuthority, type CallContext, type JsonObject, type Node } from '../catalog/index.ts';
import { reportSkippedExtension, type ReportExtensionFailure } from '../capabilities/extensions.ts';
import { callServerResult, CredentialsRefusedError, listServerTools } from '../capabilities/mcp-client.ts';
import type { ExternalServerConfig } from '../capabilities/server-config.ts';
import { getSecretReferenceNames, resolveExternalServerSecrets, resolveSecretReferences } from '../capabilities/server-secrets.ts';
import { registerAccountService, registerSecretServiceSource, type SecretService } from '../capabilities/connections/services.ts';
import { warnRecipients } from '../capabilities/agent-catalog.ts';
import { discoverAndPublish } from './discovered-node.ts';

type Config = Exclude<ExternalServerConfig, { transport: 'claude-connector' }>;
type Service = SecretService & { config: Config; version: string | null; discoverAfter: number };
const MINUTE = 60_000;

function server(name: string, config: Config) {
  return { title: name, ...config };
}

export function configureServers(configs: [string, Config][], publish: (node: Node) => void, report?: ReportExtensionFailure) {
  const services: Service[] = [];
  for (const [name, config] of configs) {
    warnRecipients(`[mcp-servers] ${name}`, config.recipients ?? []);
    if (config.transport === 'http' && config.auth === 'user') {
      registerAccountService({
        name, url: config.url, description: config.description!.trim(), setup: null,
        clientRegistration: config.clientRegistration ?? 'dynamic', scope: config.scope ?? null,
        authorizationParams: config.authorizationParams ?? null, identityProbe: config.identityProbe ?? null,
      });
      continue;
    }
    services.push({
      name, config, description: config.description ?? null, secretNames: getSecretReferenceNames(config),
      version: null, connected: false, error: null, discoverAfter: 0,
    });
  }

  async function failed(service: Service, message: string) {
    const changed = service.error !== message;
    Object.assign(service, { connected: false, error: message, discoverAfter: Date.now() + MINUTE });
    if (changed) await reportSkippedExtension('mcp-servers', service.name + '.json', message, report);
  }

  async function invoke(service: Service, tool: string, args: JsonObject, ctx: CallContext) {
    const secrets = service.secretNames.length ? secretAuthority(ctx).secrets : {};
    const config = resolveSecretReferences(service.config, secrets);
    const version = service.version;
    try {
      return await callServerResult(server(service.name, config), tool, args, { signal: ctx.signal });
    } catch (cause) {
      const error = safeError(cause, secrets);
      if (cause instanceof CredentialsRefusedError && service.secretNames.length) {
        const message = `${service.name} refused the installation credentials (HTTP 401). Ask the operator to replace them in Connections.`;
        if (version === service.version) await failed(service, message);
        throw new CapabilityError('auth_required', message);
      }
      if (version === service.version && error.kind === 'unavailable' && !ctx.signal?.aborted) await failed(service, error.message);
      throw error;
    }
  }

  async function refresh(service: Service) {
    try {
      const { secrets, secretVersion } = await resolveExternalServerSecrets(service.name, service.secretNames);
      if (!secrets) {
        Object.assign(service, { version: null, connected: false, error: null, discoverAfter: 0 });
        return;
      }
      if (service.version === secretVersion && Date.now() < service.discoverAfter) return;
      service.version = secretVersion;
      const { name, config, secretNames } = service;
      const endpoint = server(name, resolveSecretReferences(config, secrets));
      await discoverAndPublish({
        name, description: config.description, recipients: config.recipients ?? [],
        connection: secretNames.length ? { type: 'secret', service: name, secrets: secretNames, summary: config.description ?? name } : undefined,
      }, () => listServerTools(endpoint).catch(error => { throw safeError(error, secrets); }),
      (tool, args, ctx) => invoke(service, tool, args, ctx),
      () => { service.discoverAfter = Math.min(service.discoverAfter, Date.now() + MINUTE); }, publish);
      Object.assign(service, { connected: true, error: null, discoverAfter: Date.now() + 60 * MINUTE });
    } catch (error) {
      await failed(service, error instanceof Error ? error.message : String(error));
    }
  }

  if (!services.length) return;
  // A refresh after credential provisioning must observe the committed rows,
  // even when a probe of the previous values is still running.
  let pending = Promise.resolve();
  const refreshAll = () => {
    pending = pending.then(async () => { await Promise.all(services.map(refresh)); });
    return pending;
  };
  registerSecretServiceSource({
    list: () => services.filter(service => service.secretNames.length)
      .map(({ name, description, secretNames, connected, error }) => ({ name, description, secretNames, connected, error })),
    refresh: refreshAll,
  });
  setInterval(refreshAll, MINUTE).unref();
}

function safeError(error: unknown, secrets: Record<string, string>) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(secrets)) {
    if (value) message = message.replaceAll(value, '[redacted]');
  }
  return new CapabilityError(error instanceof CapabilityError ? error.kind : 'unavailable', message);
}
