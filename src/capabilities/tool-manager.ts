// Tool-server manager (§10): local in-process servers (tools/*.ts) and
// external MCP servers (mcp-servers/*.json) behind one registry. Servers with
// unresolved ${secret:NAME} references wait in pending and reconnect when the
// secrets are provisioned; servers with auth: "user" are registered without a
// global connection — per-user clients join at the connections step of
// stage 4. Module-level state is deliberate: the whole system is one process
// (§2), the runs consume this registry through their bundled ToolsApi.

import path from 'node:path';
import type { JsonObject, ToolResult } from '../core/contract.ts';
import { connectExternalServer, type ConnectedServer, type ToolFunction } from './mcp-client.ts';
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
  return RESERVED_FUNCTION_NAMES.has(functionName);
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
  const declaredOk = bundle.declared === 'all' ? !consentServers.has(serverName) : bundle.declared.includes(serverName);

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

export function getUserAuthServer(serverName: string): UserAuthServer | null {
  return userAuthServers.get(serverName) ?? null;
}

export function listUserAuthServers(): UserAuthServer[] {
  return [...userAuthServers.values()].sort((a, b) => a.name.localeCompare(b.name));
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
};

function getToolFunctionEntry(bundle: ToolBundle, functionName: string): ToolFunctionEntry | null {
  for (const server of servers.values()) {
    if (!isServerInBundle(bundle, server.name)) {
      continue;
    }

    const fn = server.functions.find(candidate => candidate.functionName === functionName);

    if (fn) {
      return { fn, server };
    }
  }

  return null;
}

export function isServerToolFunction(bundle: ToolBundle, functionName: string): boolean {
  return Boolean(getToolFunctionEntry(bundle, functionName));
}

// The functions of the bundle's servers, connecting pending servers first.
// userId is part of the surface for the per-user servers joining later in
// stage 4.
export async function getServerToolFunctions(_userId: string, bundle: ToolBundle): Promise<ToolFunction[]> {
  await ensurePendingExternalServers();

  return [...servers.values()]
    .filter(server => isServerInBundle(bundle, server.name))
    .flatMap(server => server.functions);
}

export type ServerToolOutcome = {
  serverName: string;
  toolName: string;
  result: ToolResult;
};

export async function callServerTool(
  userId: string,
  bundle: ToolBundle,
  functionName: string,
  args: JsonObject,
): Promise<ServerToolOutcome> {
  const entry = getToolFunctionEntry(bundle, functionName);

  if (!entry) {
    throw new Error(`Unknown tool "${functionName}"`);
  }

  const { fn, server } = entry;

  const raw = (await server.client.callTool({ name: fn.toolName, arguments: args }, undefined, {
    timeout: TOOL_CALL_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
  })) as Record<string, unknown>;

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
