// Discovery authority is workspace-local. Publish only the contracts shared
// by the connected accounts there; calls always resolve the selected account.
import { isDeepStrictEqual } from 'node:util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { accountAuthority, type AccountConnection, type Node } from '../catalog/index.ts';
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
  publishedBy: string[];
  failedAccounts: Set<string>;
  publishFailed: boolean;
  excluded: string[];
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
  const invoke: Parameters<typeof discoveredNode>[2] = (tool, args, ctx) =>
    withAccountBearer(name, ctx.account!.account, accountAuthority(ctx), ctx.signal, token =>
      callServerResult(bearer(token), tool, args, { signal: ctx.signal }));

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
      members: [], publishedBy: [], failedAccounts: new Set(), publishFailed: false, excluded: [], discoverAfter: 0,
    };
    states.set(workspaceId, state);
    const connected = accounts.filter(row => row.status === 'connected');
    const members = connected.map(row => row.id);
    if (!force && isDeepStrictEqual(state.members, members) && Date.now() < state.discoverAfter) return;
    state.members = members;
    // A known contract remains describable through reauthorization. An
    // entirely new set of accounts must earn its own contract.
    const eligible = connected.length ? connected : accounts;
    if (state.publishedBy.length && !eligible.some(row => state.publishedBy.includes(row.id))) {
      publish(empty, workspaceId);
      state.publishedBy = [];
      state.excluded = [];
    }
    for (const id of state.failedAccounts) if (!members.includes(id)) state.failedAccounts.delete(id);
    if (!connected.length) return;

    const issue = (message: string) => reportExtensionFailure('mcp-servers', name + '.json', message, report, workspaceId);
    const results = await Promise.all(connected.map(async row => {
      try {
        const authority = await connectionsPort().accountAuthority(workspaceId, name, row.accountKey);
        const tools = await withAccountBearer(name, row.accountKey, authority, null, token => listServerTools(bearer(token)));
        state.failedAccounts.delete(row.id);
        return { id: row.id, tools };
      } catch (error) {
        if (!state.failedAccounts.has(row.id)) {
          state.failedAccounts.add(row.id);
          await issue(`Account "${row.accountKey}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      }
    }));
    const opened = results.filter(result => result !== null);
    state.discoverAfter = Date.now() + (state.failedAccounts.size ? 60_000 : 3_600_000);
    if (!opened.length) return;

    const [first, ...others] = opened;
    const tools = first.tools.filter(tool => !Object.hasOwn(tool.inputSchema.properties ?? {}, 'account') &&
      others.every(list => list.tools.some(candidate => sameContract(candidate, tool))));
    const included = new Set(tools.map(tool => tool.name));
    const excluded = [...new Set(opened.flatMap(list => list.tools.map(tool => tool.name)))].filter(tool => !included.has(tool)).sort();
    try {
      const node = discoveredNode(settings, tools, invoke, () => {
        state.discoverAfter = Math.min(state.discoverAfter, Date.now() + 60_000);
      });
      publish(node, workspaceId);
      state.publishedBy = opened.map(list => list.id);
      state.publishFailed = false;
      if (excluded.length && !isDeepStrictEqual(state.excluded, excluded)) {
        await issue(`Tools omitted (account-specific contract or reserved input "account"): ${excluded.join(', ')}`);
      }
      state.excluded = excluded;
    } catch (error) {
      if (!state.publishFailed) await issue(error instanceof Error ? error.message : String(error));
      state.publishFailed = true;
      state.discoverAfter = Date.now() + 60_000;
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

function sameContract(a: Tool, b: Tool): boolean {
  return a.name === b.name && a.description === b.description && (a.title ?? a.annotations?.title) === (b.title ?? b.annotations?.title)
    && isDeepStrictEqual(a.inputSchema, b.inputSchema) && isDeepStrictEqual(a.outputSchema, b.outputSchema);
}
