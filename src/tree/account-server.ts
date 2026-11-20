// Any connected account can discover the server's contract. Calls always
// resolve the workspace account selected by their caller.
import { isDeepStrictEqual } from 'node:util';
import { accountAuthority, CapabilityError, type AccountConnection, type Node } from '../catalog/index.ts';
import { registerAccountCatalog } from '../capabilities/connections/services.ts';
import { withAccountBearer } from '../capabilities/account-mcp.ts';
import { reportExtensionFailure, type ReportExtensionFailure } from '../capabilities/extensions.ts';
import { callServerResult, listServerTools } from '../capabilities/mcp-client.ts';
import type { ExternalServerConfig } from '../capabilities/server-config.ts';
import { prisma } from '../db/client.ts';
import { discoveredNode } from './discovered-node.ts';
import { connectionsPort } from './services.ts';

type Config = Extract<ExternalServerConfig, { transport: 'http' }>;
type Snapshot = {
  members: string[];
  source: string | null;
  failedAccounts: Set<string>;
  publishFailed: boolean;
  reservedInputs: string[];
  discoverAfter: number;
};

export function configureAccountServer(name: string, config: Config, publish: (node: Node, workspaceId?: string) => void,
  report?: ReportExtensionFailure) {
  const connection: AccountConnection = {
    type: 'account', service: name, summary: config.description!,
    ...(config.clientRegistration === 'manual' && { setup: 'Register an OAuth client at the provider and enter its credentials in Connections.' }),
    oauth: {
      url: config.url, clientRegistration: config.clientRegistration ?? 'dynamic', scope: config.scope,
      authorizationParams: config.authorizationParams, identityProbe: config.identityProbe,
    },
  };
  const settings = { name, description: config.description, recipients: config.recipients ?? [], connection };
  const states = new Map<string, Snapshot>();
  const bearer = (token: string) => ({ title: name, url: config.url, headers: { Authorization: `Bearer ${token}` } });
  const invoke: Parameters<typeof discoveredNode>[2] = async (tool, args, ctx) => {
    try {
      return await withAccountBearer(name, ctx.account!.account, accountAuthority(ctx), ctx.signal, token =>
        callServerResult(bearer(token), tool, args, { signal: ctx.signal }));
    } catch (error) {
      const state = states.get(ctx.caller.workspaceId);
      if (state && error instanceof CapabilityError && error.kind === 'unavailable' && !ctx.signal?.aborted) {
        state.discoverAfter = Math.min(state.discoverAfter, Date.now() + 60_000);
      }
      throw error;
    }
  };

  // Register OAuth before the first sign-in. The workspace grant cuts this
  // node when it has no accounts, including for scheduled programs.
  const empty = discoveredNode(settings, [], invoke, () => {});
  publish(empty);

  async function refresh(workspaceId: string, force: boolean) {
    const accounts = await prisma.connection.findMany({
      where: { server: name, workspaceId }, select: { id: true, accountKey: true, status: true }, orderBy: { id: 'asc' },
    });
    if (!accounts.length) {
      publish(empty, workspaceId);
      states.delete(workspaceId);
      return;
    }
    const state: Snapshot = states.get(workspaceId) ?? {
      members: [], source: null, failedAccounts: new Set(), publishFailed: false, reservedInputs: [], discoverAfter: 0,
    };
    states.set(workspaceId, state);
    const connected = accounts.filter(row => row.status === 'connected');
    const members = connected.map(row => row.id);
    if (!force && isDeepStrictEqual(state.members, members) && Date.now() < state.discoverAfter) return;
    state.members = members;
    for (const id of state.failedAccounts) if (!members.includes(id)) state.failedAccounts.delete(id);
    if (!connected.length) return;

    const issue = (message: string) => reportExtensionFailure('mcp-servers', name + '.json', message, report, workspaceId);
    // Prefer the last account that supplied the contract. A new login does
    // not require comparing tool lists or replacing a usable snapshot.
    connected.sort((a, b) => Number(b.id === state.source) - Number(a.id === state.source));
    state.discoverAfter = Date.now() + 60_000;
    for (const row of connected) {
      let tools;
      try {
        const authority = await connectionsPort().accountAuthority(workspaceId, name, row.accountKey);
        tools = await withAccountBearer(name, row.accountKey, authority, null, token => listServerTools(bearer(token)));
        state.failedAccounts.delete(row.id);
      } catch (error) {
        if (!state.failedAccounts.has(row.id)) {
          state.failedAccounts.add(row.id);
          await issue(`Account "${row.accountKey}": ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      const allowed = tools.filter(tool => !Object.hasOwn(tool.inputSchema.properties ?? {}, 'account'));
      const reserved = tools.filter(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, 'account')).map(tool => tool.name).sort();
      try {
        publish(discoveredNode(settings, allowed, invoke, () => {
          state.discoverAfter = Math.min(state.discoverAfter, Date.now() + 60_000);
        }), workspaceId);
        state.source = row.id;
        state.discoverAfter = Date.now() + 3_600_000;
        state.publishFailed = false;
        if (reserved.length && !isDeepStrictEqual(state.reservedInputs, reserved)) {
          await issue(`Tools omitted because their input declares the reserved field "account": ${reserved.join(', ')}`);
        }
        state.reservedInputs = reserved;
      } catch (error) {
        if (!state.publishFailed) await issue(error instanceof Error ? error.message : String(error));
        state.publishFailed = true;
      }
      return;
    }
  }

  // Read the rows inside the queue, so a slow probe cannot overwrite a
  // subsequent sign-in or disconnect. Other workspaces open independently.
  const pending = new Map<string, Promise<void>>();
  function enqueue(workspaceId: string, force: boolean) {
    const previous = pending.get(workspaceId) ?? Promise.resolve();
    const run = () => refresh(workspaceId, force);
    const next = previous.then(run, run).finally(() => {
      if (pending.get(workspaceId) === next) pending.delete(workspaceId);
    });
    pending.set(workspaceId, next);
    return next;
  }
  registerAccountCatalog(name, async (workspaceId, change) => {
    // Discovery itself can lose authorization while refreshing a token.
    // Queue the new membership without waiting on the probe that raised it.
    const nested = change === 'reauthorization_required' && pending.has(workspaceId);
    const next = enqueue(workspaceId, true);
    if (nested) void next.catch(error => console.error(`[mcp-servers] ${name} refresh failed:`, error));
    else await next;
  });
  return async () => {
    const rows = await prisma.connection.findMany({ where: { server: name }, select: { workspaceId: true }, distinct: ['workspaceId'] });
    const workspaces = new Set([...states.keys(), ...rows.map(row => row.workspaceId)]);
    await Promise.all([...workspaces].map(workspaceId => enqueue(workspaceId, false)));
  };
}
