// The published contract survives a failed exchange. Connections reports the
// health of the login and proxy independently of the catalog snapshot.
import { createHash } from 'node:crypto';
import { resolveOperatorCredentials, tokenTtlMs } from '../adapters/ccr/token.ts';
import { connectorServer } from '../capabilities/claude-connector.ts';
import { addressedTo } from '../capabilities/agent-catalog.ts';
import type { AgentPassport } from '../core/contract.ts';
import type { ExternalServerConfig } from '../capabilities/server-config.ts';
import { CapabilityError, type JsonObject, type Node } from '../catalog/index.ts';
import { callServerResult, EXTERNAL_CALL_TIMEOUT_MS, listServerTools } from '../capabilities/mcp-client.ts';
import { discoveredNode } from './discovered-node.ts';

type Config = Extract<ExternalServerConfig, { transport: 'claude-connector' }>;
type Connector = {
  name: string;
  config: Config;
  recipients: string[];
  state: 'connected' | 'token_expired' | 'failed';
  error: string | null;
  tokenExpiresAt: Date | null;
  generation: string;
  discoverAfter: number;
};

const MINUTE = 60_000;
const CONTRACT_TTL = 60 * MINUTE;
const connectors: Connector[] = [];
let publish: (node: Node) => void;

export async function startConnectors(configs: [string, Config][], install: typeof publish): Promise<void> {
  if (!configs.length) return;
  publish = install;
  for (const [name, config] of configs) {
    const recipients = config.recipients ?? [];
    if (!recipients.length) console.warn(`[connectors] ${name} has no agent recipients`);
    connectors.push({
      name, config, recipients, state: 'failed', error: null, tokenExpiresAt: null, generation: '', discoverAfter: 0,
    });
  }
  await refreshConnectors();
  setInterval(refreshConnectors, MINUTE).unref();
}

function failed(connector: Connector, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (connector.error !== message) console.warn(`[connectors] ${connector.name}: ${message}`);
  if (connector.state !== 'failed') connector.discoverAfter = Date.now() + MINUTE;
  connector.state = 'failed';
  connector.error = message;
  connector.tokenExpiresAt = null;
}

async function invoke(connector: Connector, name: string, args: JsonObject, signal: AbortSignal | null) {
  const generation = connector.generation;
  const server = connectorServer(connector.name, connector.config.serverId);
  const deadline = AbortSignal.timeout(EXTERNAL_CALL_TIMEOUT_MS);
  try {
    return await callServerResult(server, name, args, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (error) {
    // An old call still gets its error, but cannot overwrite a newer login's status.
    if (generation === connector.generation && error instanceof CapabilityError &&
        (error.kind === 'auth_required' || (error.kind === 'unavailable' && !signal?.aborted))) {
      failed(connector, error);
    }
    throw error;
  }
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
    if (ttl !== null && ttl <= 0) {
      connector.generation = generation;
      connector.state = 'token_expired';
      connector.error = null;
      connector.tokenExpiresAt = new Date(credentials.expiresAt!);
      connector.discoverAfter = 0;
      continue;
    }
    if (connector.generation === generation && Date.now() < connector.discoverAfter) continue;
    connector.generation = generation;

    try {
      const tools = await listServerTools(connectorServer(connector.name, connector.config.serverId));
      const node = discoveredNode({
        name: connector.name,
        description: connector.config.description,
        recipients: connector.recipients,
        guide: "Every call acts as the operator's own account at the provider, whoever asks.",
      }, tools, (name, args, signal) => invoke(connector, name, args, signal), () => {
        // Queue discovery, including for a fixed environment token. A bad
        // result never replays a write or starts a probe per failing call.
        connector.discoverAfter = Math.min(connector.discoverAfter, Date.now() + MINUTE);
      });
      publish(node);
      connector.state = 'connected';
      connector.error = null;
      connector.tokenExpiresAt = null;
      connector.discoverAfter = Date.now() + CONTRACT_TTL;
    } catch (error) {
      failed(connector, error);
      connector.discoverAfter = Date.now() + MINUTE;
    }
  }
}

let pending: Promise<void> | null = null;
async function refreshConnectors(): Promise<void> {
  if (!connectors.length) return;
  pending ??= refresh().finally(() => { pending = null; });
  await pending;
}

export async function connectorStatuses() {
  await refreshConnectors();
  return connectors.map(({ name, config, recipients, state, error, tokenExpiresAt }) => ({
    name, description: config.description ?? null, recipients, state, error, tokenExpiresAt,
  }));
}

export function connectorNamesFor(agent: AgentPassport): string[] {
  return connectors.filter(connector => addressedTo(connector.recipients, agent)).map(connector => connector.name);
}
