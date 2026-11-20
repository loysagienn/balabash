// Discovery authority is workspace-local. Publish only the contracts shared
// by the connected accounts there; calls always resolve the selected account.
import { isDeepStrictEqual } from 'node:util';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { accountAuthority, type AccountConnection, type Node, type AccountAuthority } from '../catalog/index.ts';
import { withAccountBearer } from '../capabilities/account-mcp.ts';
import { reportSkippedExtension, type ReportExtensionFailure } from '../capabilities/extensions.ts';
import { callServerResult, listServerTools } from '../capabilities/mcp-client.ts';
import type { ExternalServerConfig } from '../capabilities/server-config.ts';
import { prisma } from '../db/client.ts';
import { discoverAndPublish, discoveredNode } from './discovered-node.ts';
import { connectionsPort } from './services.ts';

type Config = Extract<ExternalServerConfig, { transport: 'http' }>;
type Snapshot = { members: string; discoverAfter: number; error: string | null };

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

  async function list(account: string, authority: AccountAuthority) {
    return withAccountBearer(name, account, authority, null, token => listServerTools(bearer(token)));
  }

  return async () => {
    const rows = await prisma.connection.findMany({
      where: { server: name }, select: { workspaceId: true, id: true, accountKey: true, status: true }, orderBy: { id: 'asc' },
    });
    const groups = Map.groupBy(rows, row => row.workspaceId);
    for (const workspaceId of states.keys()) {
      if (!groups.has(workspaceId)) {
        publish(empty, workspaceId);
        states.delete(workspaceId);
      }
    }
    for (const [workspaceId, accounts] of groups) {
      const connected = accounts.filter(row => row.status === 'connected');
      const members = JSON.stringify(connected.map(row => row.id));
      const state = states.get(workspaceId) ?? { members: '', discoverAfter: 0, error: null };
      states.set(workspaceId, state);
      if (state.members === members && Date.now() < state.discoverAfter) continue;
      if (state.members !== members) publish(empty, workspaceId);
      state.members = members;

      try {
        await discoverAndPublish(settings, async () => {
          const listings = await Promise.all(connected.map(async row =>
            list(row.accountKey, await connectionsPort().accountAuthority(workspaceId, name, row.accountKey))));
          const [first = [], ...others] = listings;
          return first.filter(tool => others.every(tools => tools.some(candidate => sameContract(candidate, tool))));
        }, invoke, () => { state.discoverAfter = Math.min(state.discoverAfter, Date.now() + 60_000); },
        node => publish(node, workspaceId));
        state.discoverAfter = Date.now() + 60 * 60_000;
        state.error = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (state.error !== message) await reportSkippedExtension('mcp-servers', name + '.json', `Workspace ${workspaceId}: ${message}`, report);
        state.error = message;
        state.discoverAfter = Date.now() + 60_000;
      }
    }
  };
}

function sameContract(a: Tool, b: Tool): boolean {
  return a.name === b.name && a.description === b.description && (a.title ?? a.annotations?.title) === (b.title ?? b.annotations?.title)
    && isDeepStrictEqual(a.inputSchema, b.inputSchema) && isDeepStrictEqual(a.outputSchema, b.outputSchema);
}
