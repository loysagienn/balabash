// Tool-server manager (§10): local in-process servers (tools/*.ts) and
// external MCP servers (mcp-servers/*.json) behind one registry. Servers with
// unresolved ${secret:NAME} references wait in pending and reconnect when the
// secrets are provisioned; servers with auth: "user" are registered without a
// global connection — per-user clients are created lazily once the user's
// connection row says "connected". Module-level state is deliberate: the
// whole system is one process (§2), the runs consume this registry through
// their bundled ToolsApi.

import path from 'node:path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { JsonObject, ToolResult } from '../core/contract.ts';
import { connectExternalServer, connectUserServer, type ConnectedServer, type ToolFunction } from './mcp-client.ts';
import { startLocalToolSource, type LocalToolContext, type LocalToolSource } from './local-tool-source.ts';
import {
  getLocalToolPath,
  readExternalServerConfigs,
  readLocalToolFilenames,
  type ExternalServerConfig,
} from './server-config.ts';
import { resolveExternalServerSecrets } from './server-secrets.ts';
import { extractErrorText, toCanonicalToolResult } from './result-adapter.ts';
import { BUILTIN_TOOL_DEFINITIONS } from './builtin-tools.ts';
import { listUserConnections, markReauthorizationRequired } from './connections/index.ts';

// MCP SDK defaults to 60s per request; deep-research-style tools legitimately
// run for minutes. Progress notifications reset the clock when a server sends
// them.
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;

export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// Names a server tool must not take: the builtin pull tools and the
// coordinator's static functions share the same flat function namespace.
const RESERVED_FUNCTION_NAMES = new Set([
  ...BUILTIN_TOOL_DEFINITIONS.map(tool => tool.name),
  'send_message',
  'do_nothing',
  'cancel_thread',
]);

export function isReservedFunctionName(functionName: string): boolean {
  if (RESERVED_FUNCTION_NAMES.has(functionName)) {
    return true;
  }

  for (const server of builtinToolServers.values()) {
    if (server.functionNames.includes(functionName)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Builtin tool servers: in-src capabilities behind the same server/bundle
// surface as MCP servers — today the auth tools (§7.4 consent), stage 5 adds
// request_capability. Calls receive the calling run's identity: the issued
// links и events are thread-addressed.

export type BuiltinServerCallContext = {
  userId: string;
  threadId: string;
};

export type BuiltinToolServer = {
  name: string;
  // A consent server never rides into a bundle through 'all' — only agents
  // naming it explicitly get it (§7.4).
  consent: boolean;
  // Static function namespace: lookup and collision checks stay synchronous;
  // getFunctions may expose a state-dependent subset with live descriptions.
  functionNames: string[];
  getFunctions(userId: string): Promise<ToolFunction[]>;
  call(toolName: string, args: JsonObject, ctx: BuiltinServerCallContext): Promise<ToolResult>;
};

const builtinToolServers = new Map<string, BuiltinToolServer>();

export function registerBuiltinToolServer(server: BuiltinToolServer): void {
  if (!SERVER_NAME_PATTERN.test(server.name)) {
    throw new Error(`Tool server name "${server.name}" must match ${SERVER_NAME_PATTERN}`);
  }

  builtinToolServers.set(server.name, server);
}

// ---------------------------------------------------------------------------
// Bundles (§7.4): granularity is a whole tool server. 'all' excludes consent
// servers — they only reach agents that name them explicitly; a spawner may
// narrow the declared bundle but never widen it.

export type ToolBundle = {
  declared: 'all' | string[];
  narrowed?: string[];
};

function isServerInBundle(bundle: ToolBundle, serverName: string): boolean {
  const consent = consentServers.has(serverName) || Boolean(builtinToolServers.get(serverName)?.consent);
  const declaredOk = bundle.declared === 'all' ? !consent : bundle.declared.includes(serverName);

  return declaredOk && (!bundle.narrowed || bundle.narrowed.includes(serverName));
}

// ---------------------------------------------------------------------------
// Registries

let servers = new Map<string, ConnectedServer>();
let localToolSources = new Map<string, LocalToolSource>();
let localToolContext: LocalToolContext | null = null;
const consentServers = new Set<string>();

type PendingExternalServer = {
  name: string;
  config: ExternalServerConfig;
  secretNames: string[];
  error: string | null;
  connected: boolean;
  secretVersion: string | null;
};

let pendingExternalServers = new Map<string, PendingExternalServer>();

// Servers with auth: "user" have no global connection: every user authorizes
// their own account. The registry feeds the connections layer; per-user
// clients are created lazily once a user's connection row says "connected".
export type UserAuthServer = {
  name: string;
  url: string;
  description: string;
  clientRegistration: 'dynamic' | 'manual';
  scope: string | null;
  authorizationParams: Record<string, string> | null;
};

const userAuthServers = new Map<string, UserAuthServer>();
const userServers = new Map<string, Map<string, ConnectedServer>>();

export function getUserAuthServer(serverName: string): UserAuthServer | null {
  return userAuthServers.get(serverName) ?? null;
}

export function listUserAuthServers(): UserAuthServer[] {
  return [...userAuthServers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function dropUserClient(serverName: string, userId: string): void {
  const clients = userServers.get(userId);
  const client = clients?.get(serverName);

  if (!clients || !client) {
    return;
  }

  clients.delete(serverName);
  void client.close().catch(() => {});
}

// Lazily connects the user's authorized servers before tool definitions are
// handed out. A failed refresh downgrades the connection to
// reauthorization_required; transient errors are logged and retried on the
// next turn.
async function ensureUserServers(userId: string): Promise<void> {
  if (!userAuthServers.size) {
    return;
  }

  const rows = await listUserConnections(userId);
  const connectedNames = new Set(rows.filter(row => row.status === 'connected').map(row => row.server));

  for (const server of userAuthServers.values()) {
    if (userServers.get(userId)?.has(server.name) || !connectedNames.has(server.name)) {
      continue;
    }

    try {
      const connected = await connectUserServer(server, userId);
      const taken = new Set(
        [...servers.values(), ...(userServers.get(userId)?.values() ?? [])].flatMap(existing =>
          existing.functions.map(fn => fn.functionName),
        ),
      );
      const collisions = connected.functions.filter(
        toolFunction => taken.has(toolFunction.functionName) || isReservedFunctionName(toolFunction.functionName),
      );

      if (collisions.length) {
        console.warn(
          `[tools] "${server.name}" for user ${userId}: dropped colliding tools ${collisions.map(fn => fn.functionName).join(', ')}`,
        );
        connected.functions = connected.functions.filter(fn => !collisions.includes(fn));
      }

      const clients = userServers.get(userId) ?? new Map<string, ConnectedServer>();

      clients.set(server.name, connected);
      userServers.set(userId, clients);

      console.log(
        `[tools] connected "${server.name}" for user ${userId}; tools: ${connected.functions.map(fn => fn.functionName).join(', ') || '(none)'}`,
      );
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        await markReauthorizationRequired(server.name, userId, getErrorMessage(error));
      } else {
        console.error(`[tools] failed to connect "${server.name}" for user ${userId}:`, error);
      }
    }
  }
}

// Pending secret targets for the auth agent: which servers wait for which
// installation credentials, and how their last connection attempt went.
export type ExternalSecretTarget = {
  name: string;
  secretNames: string[];
  error: string | null;
  connected: boolean;
};

export function listExternalSecretTargets(): ExternalSecretTarget[] {
  return [...pendingExternalServers.values()]
    .map(pending => ({
      name: pending.name,
      secretNames: pending.secretNames,
      error: pending.error,
      connected: pending.connected,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNoFunctionCollisions(connectedServers: ReadonlyMap<string, ConnectedServer>): void {
  const functionOwners = new Map<string, string>();

  for (const server of connectedServers.values()) {
    for (const toolFunction of server.functions) {
      if (isReservedFunctionName(toolFunction.functionName)) {
        throw new Error(`Tool "${toolFunction.functionName}" from "${server.name}" collides with a builtin function`);
      }

      const existingOwner = functionOwners.get(toolFunction.functionName);

      if (existingOwner) {
        throw new Error(
          `Tool "${toolFunction.functionName}" is provided by both "${existingOwner}" and "${server.name}"`,
        );
      }

      functionOwners.set(toolFunction.functionName, server.name);
    }
  }
}

function toUserAuthServer(serverName: string, config: ExternalServerConfig & { transport: 'http' }): UserAuthServer {
  return {
    name: serverName,
    url: config.url,
    description: config.description?.trim() || serverName,
    clientRegistration: config.clientRegistration === 'manual' ? 'manual' : 'dynamic',
    scope: config.scope ?? null,
    authorizationParams: config.authorizationParams ?? null,
  };
}

// Retries pending servers whose secrets appeared or changed since the last
// attempt (secretVersion), before tool definitions are handed out.
async function ensurePendingExternalServers(): Promise<void> {
  for (const pending of [...pendingExternalServers.values()]) {
    const resolved = await resolveExternalServerSecrets(pending.name, pending.config);

    if (!resolved.config) {
      continue;
    }

    if (pending.connected && pending.secretVersion === resolved.secretVersion && servers.has(pending.name)) {
      continue;
    }

    try {
      const existing = servers.get(pending.name);
      const connected = await connectExternalServer(pending.name, resolved.config);
      const next = new Map(servers);

      next.set(pending.name, connected);

      try {
        assertNoFunctionCollisions(next);
      } catch (error) {
        await connected.close().catch(() => {});
        throw error;
      }

      servers = next;
      pending.connected = true;
      pending.secretVersion = resolved.secretVersion;
      pending.error = null;

      if (existing) {
        void existing.close().catch(() => {});
      }

      console.log(
        `[tools] connected pending external server "${pending.name}"; tools: ${connected.functions.map(fn => fn.functionName).join(', ') || '(none)'}`,
      );
    } catch (error) {
      pending.error = getErrorMessage(error);
      console.error(`[tools] failed to connect pending external server "${pending.name}":`, error);
    }
  }
}

export async function loadToolServers(ctx: LocalToolContext): Promise<void> {
  localToolContext = ctx;
  const connected = new Map<string, ConnectedServer>();
  const nextUserAuth = new Map<string, UserAuthServer>();
  const nextPending = new Map<string, PendingExternalServer>();
  const nextLocalSources = new Map<string, LocalToolSource>();
  const nextConsent = new Set<string>();
  const discovered: Array<{
    name: string;
    config: ExternalServerConfig;
    origin: ConnectedServer['origin'];
  }> = [];
  const names = new Set<string>();

  const addDiscovered = (name: string, config: ExternalServerConfig, origin: ConnectedServer['origin']) => {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`Tool server name "${name}" must match ${SERVER_NAME_PATTERN}`);
    }

    if (names.has(name)) {
      throw new Error(`Duplicate tool server name "${name}"`);
    }

    names.add(name);

    if (config.consent) {
      nextConsent.add(name);
    }

    discovered.push({ name, config, origin });
  };

  for (const filename of await readLocalToolFilenames()) {
    const serverName = path.basename(filename, '.ts');
    const source = await startLocalToolSource(getLocalToolPath(filename), ctx);

    nextLocalSources.set(serverName, source);
    addDiscovered(serverName, source.config, 'file');
  }

  for (const [serverName, config] of Object.entries(await readExternalServerConfigs())) {
    addDiscovered(serverName, config, 'external');
  }

  for (const { name: serverName, config, origin } of discovered) {
    if (config.transport === 'http' && config.auth === 'user') {
      nextUserAuth.set(serverName, toUserAuthServer(serverName, config));
      continue;
    }

    const resolved = await resolveExternalServerSecrets(serverName, config);

    if (resolved.config) {
      const server = await connectExternalServer(serverName, resolved.config);

      server.origin = origin;
      connected.set(serverName, server);

      if (resolved.secretNames.length) {
        nextPending.set(serverName, {
          name: serverName,
          config,
          secretNames: resolved.secretNames,
          error: null,
          connected: true,
          secretVersion: resolved.secretVersion,
        });
      }
    } else {
      nextPending.set(serverName, {
        name: serverName,
        config,
        secretNames: resolved.secretNames,
        error: null,
        connected: false,
        secretVersion: null,
      });
    }
  }

  assertNoFunctionCollisions(connected);

  const previous = servers;
  const previousLocalSources = localToolSources;

  servers = connected;
  localToolSources = nextLocalSources;
  pendingExternalServers = nextPending;

  consentServers.clear();

  for (const name of nextConsent) {
    consentServers.add(name);
  }

  userAuthServers.clear();

  for (const [serverName, server] of nextUserAuth) {
    userAuthServers.set(serverName, server);
  }

  for (const server of previous.values()) {
    void server.close().catch(() => {});
  }
  for (const source of previousLocalSources.values()) {
    void source.close().catch(() => {});
  }

  // Configs changed wholesale — per-user clients reconnect lazily.
  for (const clients of userServers.values()) {
    for (const client of clients.values()) {
      void client.close().catch(() => {});
    }
  }
  userServers.clear();

  const functionNames = [...connected.values()].flatMap(server => server.functions.map(fn => fn.functionName));

  console.log(
    `[tools] loaded servers: ${[...connected.keys()].join(', ') || '(none)'}; tools: ${functionNames.join(', ') || '(none)'}`,
  );

  if (pendingExternalServers.size) {
    const waiting = [...pendingExternalServers.values()].filter(pending => !pending.connected);

    if (waiting.length) {
      console.log(
        `[tools] pending servers (installation credentials required): ${waiting.map(pending => pending.name).join(', ')}`,
      );
    }
  }

  if (userAuthServers.size) {
    console.log(`[tools] registered user-auth servers: ${[...userAuthServers.keys()].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Lookup and calls

type ToolFunctionEntry = {
  fn: ToolFunction;
  server: ConnectedServer;
  scope: 'global' | 'user';
};

function getToolFunctionEntry(userId: string, bundle: ToolBundle, functionName: string): ToolFunctionEntry | null {
  for (const server of servers.values()) {
    if (!isServerInBundle(bundle, server.name)) {
      continue;
    }

    const fn = server.functions.find(candidate => candidate.functionName === functionName);

    if (fn) {
      return { fn, server, scope: 'global' };
    }
  }

  for (const server of userServers.get(userId)?.values() ?? []) {
    if (!isServerInBundle(bundle, server.name)) {
      continue;
    }

    const fn = server.functions.find(candidate => candidate.functionName === functionName);

    if (fn) {
      return { fn, server, scope: 'user' };
    }
  }

  return null;
}

function getBuiltinServerForFunction(bundle: ToolBundle, functionName: string): BuiltinToolServer | null {
  for (const server of builtinToolServers.values()) {
    if (isServerInBundle(bundle, server.name) && server.functionNames.includes(functionName)) {
      return server;
    }
  }

  return null;
}

export function isServerToolFunction(userId: string, bundle: ToolBundle, functionName: string): boolean {
  return Boolean(getBuiltinServerForFunction(bundle, functionName) || getToolFunctionEntry(userId, bundle, functionName));
}

// The functions of the bundle's servers — global, this user's authorized
// ones, and builtin servers — connecting pending and per-user servers first.
export async function getServerToolFunctions(userId: string, bundle: ToolBundle): Promise<ToolFunction[]> {
  await ensurePendingExternalServers();
  await ensureUserServers(userId);

  const functions = [...servers.values(), ...(userServers.get(userId)?.values() ?? [])]
    .filter(server => isServerInBundle(bundle, server.name))
    .flatMap(server => server.functions);

  for (const server of builtinToolServers.values()) {
    if (isServerInBundle(bundle, server.name)) {
      functions.push(...(await server.getFunctions(userId)));
    }
  }

  return functions;
}

export type ServerToolOutcome = {
  serverName: string;
  toolName: string;
  result: ToolResult;
};

export async function callServerTool(
  ctx: BuiltinServerCallContext,
  bundle: ToolBundle,
  functionName: string,
  args: JsonObject,
): Promise<ServerToolOutcome> {
  const { userId } = ctx;

  const builtinServer = getBuiltinServerForFunction(bundle, functionName);

  if (builtinServer) {
    return {
      serverName: builtinServer.name,
      toolName: functionName,
      result: await builtinServer.call(functionName, args, ctx),
    };
  }

  const entry = getToolFunctionEntry(userId, bundle, functionName);

  if (!entry) {
    throw new Error(`Unknown tool "${functionName}"`);
  }

  const { fn, server, scope } = entry;

  let raw: Record<string, unknown>;

  try {
    raw = (await server.client.callTool({ name: fn.toolName, arguments: args }, undefined, {
      timeout: TOOL_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    })) as Record<string, unknown>;
  } catch (error) {
    // Tokens can die between the connect at turn start and the call itself.
    if (scope === 'user' && error instanceof UnauthorizedError) {
      dropUserClient(fn.serverName, userId);
      await markReauthorizationRequired(fn.serverName, userId, getErrorMessage(error));

      throw new Error(
        `Authorization for "${fn.serverName}" has expired. Start the auth agent so the user gets a new authorization link.`,
      );
    }

    throw error;
  }

  if (raw.isError) {
    throw new Error(extractErrorText(raw));
  }

  const result = await toCanonicalToolResult(raw, {
    userId,
    serverName: fn.serverName,
    toolName: fn.toolName,
  });

  return { serverName: fn.serverName, toolName: fn.toolName, result };
}

// Reload entries (stage 5 wires the capability.reload.* consumer): the local
// context survives loadToolServers for that purpose.
export function getLocalToolContext(): LocalToolContext | null {
  return localToolContext;
}
