// Discovery and Connections share one status. Successful discovery is reused
// across turns; a new CLI login or a failed probe triggers rediscovery.
import { createHash } from 'node:crypto';
import { resolveOperatorCredentials, tokenTtlMs } from '../adapters/ccr/token.ts';
import { connectorServer } from '../capabilities/claude-connector.ts';
import { addressedTo } from '../capabilities/agent-catalog.ts';
import type { AgentPassport, RemoteAgentDeclaration } from '../core/contract.ts';
import type { ExternalServerConfig } from '../capabilities/server-config.ts';
import { CapabilityError, type Node } from '../catalog/index.ts';
import { callServerResult, EXTERNAL_CALL_TIMEOUT_MS, listServerTools } from '../capabilities/mcp-client.ts';
import { discoveredNode } from './discovered-node.ts';
import type { ConnectorServiceView } from '../api/contract.ts';

type Config = Extract<ExternalServerConfig, { transport: 'claude-connector' }>;
type Connector = { config: Config; view: ConnectorServiceView; generation: string; retryAfter: number };
const connectors: Connector[] = [];
let publish: (name: string, node: Node | null) => void;

export function configureConnectors(configs: [string, Config][], install: typeof publish): void {
  publish = install;
  for (const [name, config] of configs) {
    const recipients = config.recipients ?? [];
    if (!recipients.length) console.warn(`[connectors] ${name} has no agent recipients`);
    connectors.push({
      config, generation: '', retryAfter: 0,
      view: { name, recipients, description: config.description ?? null, state: 'failed', error: null, tokenExpiresAt: null },
    });
  }
}

function failed(connector: Connector, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (connector.view.error !== message) console.warn(`[connectors] ${connector.view.name}: ${message}`);
  Object.assign(connector.view, { error: message, state: 'failed', tokenExpiresAt: null });
  connector.retryAfter = Date.now() + 60_000;
  publish(connector.view.name, null);
}

async function refresh(): Promise<void> {
  let credentials;
  try {
    credentials = await resolveOperatorCredentials();
  } catch (error) {
    for (const connector of connectors) failed(connector, error);
    return;
  }
  const generation = createHash('sha256').update(credentials.accessToken).digest('hex');
  const ttl = tokenTtlMs(credentials);
  for (const connector of connectors) {
    const { config, view } = connector;
    if (ttl !== null && ttl <= 0) {
      Object.assign(view, { state: 'token_expired', error: null, tokenExpiresAt: new Date(credentials.expiresAt!) });
      publish(view.name, null);
      continue;
    }
    if (connector.generation === generation && (view.state === 'connected' || Date.now() < connector.retryAfter)) continue;
    connector.generation = generation;
    try {
      const server = () => connectorServer(view.name, config.serverId);
      const tools = await listServerTools(server());
      const node = discoveredNode({
        name: view.name, description: config.description, recipients: view.recipients,
        guide: "Calls act as the operator's provider account connected on claude.ai.",
      }, tools, async (name, args, signal) => {
        try {
          const deadline = AbortSignal.timeout(EXTERNAL_CALL_TIMEOUT_MS);
          return await callServerResult(server(), name, args, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
        } catch (error) {
          if (error instanceof CapabilityError &&
              (error.kind === 'auth_required' || (error.kind === 'unavailable' && !signal?.aborted))) {
            failed(connector, error);
          }
          throw error;
        }
      });
      publish(view.name, node);
      Object.assign(view, { state: 'connected', error: null, tokenExpiresAt: null });
      connector.retryAfter = 0;
    } catch (error) {
      failed(connector, error);
    }
  }
}

let pending: Promise<void> | null = null;
export async function refreshConnectors(): Promise<void> {
  if (!connectors.length) return;
  pending ??= refresh().finally(() => { pending = null; });
  await pending;
}

export async function connectorServiceViews(): Promise<ConnectorServiceView[]> {
  await refreshConnectors();
  return connectors.map(({ view }) => ({ ...view }));
}

export function connectorNamesFor(agent: AgentPassport | RemoteAgentDeclaration): string[] {
  return connectors.filter(({ view }) => addressedTo(view.recipients, agent)).map(({ view }) => view.name);
}
