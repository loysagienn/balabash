// The published contract survives a failed exchange. Connections reports the
// health of the login and proxy independently of the catalog snapshot.
import { createHash } from 'node:crypto';
import { resolveOperatorCredentials, tokenTtlMs } from '../adapters/ccr/token.ts';
import { reportExtensionFailure, type ReportExtensionFailure } from '../capabilities/extensions.ts';
import { connectorServer } from '../capabilities/claude-connector.ts';
import { warnRecipients } from '../capabilities/agent-catalog.ts';
import type { ExternalServerConfig } from '../capabilities/server-config.ts';
import { CapabilityError, type JsonObject, type Node } from '../catalog/index.ts';
import { callServerResult, listServerTools } from '../capabilities/mcp-client.ts';
import { discoverAndPublish } from './discovered-node.ts';

type Config = Extract<ExternalServerConfig, { transport: 'claude-connector' }>;
type Connector = {
  name: string;
  config: Config;
  recipients: string[];
  state: 'connected' | 'token_expired' | 'failed';
  error: string | null;
  tokenExpiresAt: Date | null;
  generation: string;
  discoveryFailed: boolean;
  discoverAfter: number;
};

const MINUTE = 60_000;
const CONTRACT_TTL = 60 * MINUTE;
const connectors: Connector[] = [];
let publish: (node: Node) => void;
let reportFailure: ReportExtensionFailure | undefined;

export async function startConnectors(configs: [string, Config][], install: typeof publish, report?: ReportExtensionFailure): Promise<void> {
  if (!configs.length) return;
  publish = install;
  reportFailure = report;
  for (const [name, config] of configs) {
    const recipients = config.recipients ?? [];
    warnRecipients(`[connectors] ${name}`, recipients);
    connectors.push({
      name, config, recipients, state: 'failed', error: null, tokenExpiresAt: null, generation: '', discoveryFailed: false, discoverAfter: 0,
    });
  }
  await refreshConnectors();
  setInterval(refreshConnectors, MINUTE).unref();
}

async function failed(connector: Connector, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const changed = !connector.discoveryFailed;
  connector.discoveryFailed = true;
  connector.discoverAfter = Date.now() + MINUTE;
  connector.state = 'failed';
  connector.error = message;
  connector.tokenExpiresAt = null;
  if (changed) await reportExtensionFailure('mcp-servers', connector.name + '.json', message, reportFailure);
}

async function invoke(connector: Connector, name: string, args: JsonObject, signal: AbortSignal | null) {
  const generation = connector.generation;
  const server = connectorServer(connector.name, connector.config.serverId);
  try {
    return await callServerResult(server, name, args, { signal });
  } catch (error) {
    // An old call still gets its error, but cannot overwrite a newer login's status.
    if (generation === connector.generation && connector.state !== 'token_expired' && error instanceof CapabilityError &&
        (error.kind === 'auth_required' || (error.kind === 'unavailable' && !signal?.aborted))) {
      connector.discoverAfter = Math.min(connector.discoverAfter, Date.now() + MINUTE);
      if (error.kind === 'auth_required') {
        connector.state = 'failed';
        connector.error = error.message;
        connector.tokenExpiresAt = null;
      }
    }
    throw error;
  }
}

async function refresh(): Promise<void> {
  let credentials;
  try {
    credentials = await resolveOperatorCredentials();
  } catch (error) {
    await Promise.all(connectors.map(connector => failed(connector, error)));
    return;
  }

  const generation = createHash('sha256').update(credentials.accessToken).digest('hex');
  const ttl = tokenTtlMs(credentials);
  for (const connector of connectors) {
    if (ttl !== null && ttl <= 0) {
      connector.generation = generation;
      connector.state = 'token_expired';
      connector.discoveryFailed = false;
      connector.error = null;
      connector.tokenExpiresAt = new Date(credentials.expiresAt!);
      connector.discoverAfter = 0;
      continue;
    }
    if (connector.generation === generation && Date.now() < connector.discoverAfter) continue;
    connector.generation = generation;

    try {
      await discoverAndPublish({
        name: connector.name,
        description: connector.config.description,
        recipients: connector.recipients,
        guide: "Every call acts as the operator's own account at the provider, whoever asks.",
      }, () => listServerTools(connectorServer(connector.name, connector.config.serverId)),
      (name, args, ctx) => invoke(connector, name, args, ctx.signal), () => {
        // Queue discovery, including for a fixed environment token. A bad
        // result never replays a write or starts a probe per failing call.
        connector.discoverAfter = Math.min(connector.discoverAfter, Date.now() + MINUTE);
      }, publish);
      connector.state = 'connected';
      connector.discoveryFailed = false;
      connector.error = null;
      connector.tokenExpiresAt = null;
      connector.discoverAfter = Date.now() + CONTRACT_TTL;
    } catch (error) {
      await failed(connector, error);
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
