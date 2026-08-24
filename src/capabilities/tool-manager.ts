// Tool-server manager: local in-process servers (tools/*.ts) and
// external MCP servers (mcp-servers/*.json) behind one registry. Servers with
// unresolved ${secret:NAME} references wait in pending and reconnect when the
// secrets are provisioned; servers with auth: "user" are registered without a
// global connection — per-user clients are created lazily once the user's
// connection row says "connected". Module-level state is deliberate: the
// whole system is one process, the runs consume this registry through
// their bundled ToolsApi.

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { JsonObject, JsonValue, ToolResult } from '../core/contract.ts';
import { localToolModules } from '../../tools/index.ts';
import { connectExternalServer, connectUserServer, type ConnectedServer, type ToolFunction } from './mcp-client.ts';
import { startLocalToolSource, type LocalToolContext, type LocalToolSource } from './local-tool-source.ts';
import {
  readExternalServerConfigs,
  type ExternalServerConfig,
  type IdentityProbeConfig,
  type ToolOverride,
} from './server-config.ts';
import { resolveExternalServerSecrets } from './server-secrets.ts';
import { runToolHandler } from './tool-result.ts';
import { listUserConnections, markReauthorizationRequired } from './connections/index.ts';
import { backfillConnectionIdentity, identityLabel } from './connections/identity.ts';

// MCP SDK defaults to 60s per request; deep-research-style tools legitimately
// run for minutes. Progress notifications reset the clock when a server sends
// them.
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;

export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

// The platform-owned account parameter injected into every tool of a
// user-auth server: the model addresses one connected account per call, the
// platform resolves the slug to a client and strips the parameter before the
// call crosses the module boundary. The name is reserved — a user-auth server
// must not declare it itself.
export const ACCOUNT_PARAMETER = 'account';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Names a server tool must not take: the coordinator's static functions
// share the same flat function namespace (the builtin pull tools are covered
// by the builtin-server functionNames check below).
const RESERVED_FUNCTION_NAMES = new Set(['send_message', 'do_nothing', 'send_to_thread', 'cancel_thread']);

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
// surface as MCP servers. Calls receive the calling run's identity: the
// issued links and events are thread-addressed.

export type BuiltinServerCallContext = {
  userId: string;
  threadId: string;
};

export type BuiltinToolServer = {
  name: string;
  // Static function namespace: lookup and collision checks stay synchronous;
  // getFunctions may expose a state-dependent subset with live descriptions.
  functionNames: string[];
  getFunctions(userId: string): Promise<ToolFunction[]>;
  // Birth contract: the tool returns data or throws; the platform
  // wrapper (runToolHandler) shapes the structured result at the call site.
  call(toolName: string, args: JsonObject, ctx: BuiltinServerCallContext): Promise<JsonValue>;
};

const builtinToolServers = new Map<string, BuiltinToolServer>();

export function registerBuiltinToolServer(server: BuiltinToolServer): void {
  if (!SERVER_NAME_PATTERN.test(server.name)) {
    throw new Error(`Tool server name "${server.name}" must match ${SERVER_NAME_PATTERN}`);
  }

  builtinToolServers.set(server.name, server);
}

// ---------------------------------------------------------------------------
// Bundles: granularity is a whole tool server, and every grant is explicit —
// a server reaches only the bundles that name it. A spawner may narrow the
// declared bundle but never widen it.

export type ToolBundle = {
  declared: string[];
  narrowed?: string[];
};

function isServerInBundle(bundle: ToolBundle, serverName: string): boolean {
  // Narrowing intersects — it only ever shrinks.
  return bundle.declared.includes(serverName) && (!bundle.narrowed || bundle.narrowed.includes(serverName));
}

// ---------------------------------------------------------------------------
// Registries

let servers = new Map<string, ConnectedServer>();
let localToolSources = new Map<string, LocalToolSource>();

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
  // 'file' = an in-process tool server (tools/*.ts) with per-user auth: its
  // calls still carry the caller's identity in _meta, like any local server.
  origin: ConnectedServer['origin'];
  url: string;
  description: string;
  clientRegistration: 'dynamic' | 'manual';
  scope: string | null;
  authorizationParams: Record<string, string> | null;
  // Declared identity probe — the precondition for multiple accounts.
  identityProbe: IdentityProbeConfig | null;
  toolOverrides: Record<string, ToolOverride> | undefined;
};

const userAuthServers = new Map<string, UserAuthServer>();

// Per-user clients: userId → server name → accountKey → client. Accounts of
// one server share a single function set — the canonical list lives on the
// first live client of the group (see ensureUserServers).
type UserServerAccounts = Map<string, ConnectedServer>;

const userServers = new Map<string, Map<string, UserServerAccounts>>();

// The canonical client of a server group: the one whose function list is the
// group's exposed set. Map iteration order is insertion order, so this is the
// first live account.
function canonicalClient(accounts: UserServerAccounts): ConnectedServer | null {
  return accounts.values().next().value ?? null;
}

export function getUserAuthServer(serverName: string): UserAuthServer | null {
  return userAuthServers.get(serverName) ?? null;
}

export function listUserAuthServers(): UserAuthServer[] {
  return [...userAuthServers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function dropUserClient(serverName: string, userId: string, accountKey: string): void {
  const groups = userServers.get(userId);
  const accounts = groups?.get(serverName);
  const client = accounts?.get(accountKey);

  if (!groups || !accounts || !client) {
    return;
  }

  accounts.delete(accountKey);

  if (!accounts.size) {
    groups.delete(serverName);
  }

  void client.close().catch(() => {});
}

type ConnectionRow = Awaited<ReturnType<typeof listUserConnections>>[number];

// Lazily connects the user's authorized servers before tool definitions are
// handed out, and returns the user's connection rows for the account surface.
// A failed refresh downgrades the connection to reauthorization_required;
// transient errors are logged and retried on the next turn.
async function ensureUserServers(userId: string): Promise<ConnectionRow[]> {
  if (!userAuthServers.size) {
    return [];
  }

  const rows = await listUserConnections(userId);

  for (const server of userAuthServers.values()) {
    const connectedRows = rows.filter(row => row.server === server.name && row.status === 'connected');

    for (const row of connectedRows) {
      if (userServers.get(userId)?.get(server.name)?.has(row.accountKey)) {
        continue;
      }

      try {
        const connected = await connectUserServer(server, row);

        // The account parameter is platform-owned: a server declaring it
        // itself would clash with the injected one.
        const reserving = connected.functions.filter(fn =>
          isObject(fn.inputSchema.properties) ? ACCOUNT_PARAMETER in fn.inputSchema.properties : false,
        );

        if (reserving.length) {
          void connected.close().catch(() => {});
          throw new Error(
            `tools ${reserving.map(fn => fn.functionName).join(', ')} declare the platform-reserved "${ACCOUNT_PARAMETER}" parameter`,
          );
        }

        const groups = userServers.get(userId) ?? new Map<string, UserServerAccounts>();
        const accounts = groups.get(server.name) ?? new Map<string, ConnectedServer>();

        // Concurrent turns can race to connect the same account across the
        // await above — the loser closes its client instead of leaking it.
        if (accounts.has(row.accountKey)) {
          void connected.close().catch(() => {});
          continue;
        }

        // Every account's function list is pruned against other servers and
        // reserved names (siblings of the same server are one function set by
        // design, not collisions) — so canonical rotation after a drop never
        // exposes an unpruned list.
        const siblingFunctions = [...groups.entries()]
          .filter(([name]) => name !== server.name)
          .map(([, group]) => canonicalClient(group))
          .filter((client): client is ConnectedServer => Boolean(client))
          .flatMap(client => client.functions.map(fn => fn.functionName));
        const taken = new Set([
          ...[...servers.values()].flatMap(existing => existing.functions.map(fn => fn.functionName)),
          ...siblingFunctions,
        ]);
        const collisions = connected.functions.filter(
          toolFunction => taken.has(toolFunction.functionName) || isReservedFunctionName(toolFunction.functionName),
        );

        if (collisions.length) {
          console.warn(
            `[tools] "${server.name}" (${row.accountKey}) for user ${userId}: dropped colliding tools ${collisions.map(fn => fn.functionName).join(', ')}`,
          );
          connected.functions = connected.functions.filter(fn => !collisions.includes(fn));
        }

        accounts.set(row.accountKey, connected);
        groups.set(server.name, accounts);
        userServers.set(userId, groups);

        console.log(
          `[tools] connected "${server.name}" (${row.accountKey}) for user ${userId}; tools: ${connected.functions.map(fn => fn.functionName).join(', ') || '(none)'}`,
        );

        // Lazy identity backfill: a pre-multi-account row just proved its
        // tokens work — record who the provider says it is, so the twin
        // guard and the account surface see it. Off the hot path: the turn
        // does not wait for the provider round-trip.
        if (server.identityProbe && !row.identityId) {
          void backfillConnectionIdentity(server.identityProbe, row.id)
            .then(backfill => {
              if (!backfill.ok) {
                console.warn(
                  `[tools] identity backfill for "${server.name}" (${row.accountKey}) of user ${userId} failed: ${backfill.reason}`,
                );
              }
            })
            .catch(() => {});
        }
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          console.warn(
            `[tools] "${server.name}" (${row.accountKey}) for user ${userId} is unauthorized — marked for re-authorization`,
          );
          await markReauthorizationRequired(row.id, getErrorMessage(error));
        } else {
          console.error(`[tools] failed to connect "${server.name}" (${row.accountKey}) for user ${userId}:`, error);
        }
      }
    }
  }

  return rows;
}

// One account, described for the model: slug first (the address), then the
// human name, identity and status.
function describeAccount(row: ConnectionRow): string {
  const label = identityLabel(row.identity);

  return `${row.accountKey} — "${row.displayName}"${label ? ` (${label})` : ''}, ${row.status}`;
}

// The teaching error for a missing or unknown account slug: it names every
// account of the server — address, name, identity, status — so the model can
// correct itself or surface the choice to the user. A connected account whose
// client was dropped mid-turn is called out as such instead of reading as a
// contradiction ("unknown" yet listed as connected).
async function accountSelectionError(
  serverName: string,
  userId: string,
  passed: unknown,
  liveSlugs: ReadonlySet<string>,
): Promise<string> {
  const rows = (await listUserConnections(userId)).filter(row => row.server === serverName);
  const described =
    rows
      .map(row => {
        const base = describeAccount(row);

        return row.status === 'connected' && !liveSlugs.has(row.accountKey)
          ? `${base} — client not live right now, retry on the next turn`
          : base;
      })
      .join('; ') || '(none)';
  const intro =
    typeof passed === 'string'
      ? `Unknown account "${passed}" for "${serverName}".`
      : `Tools of "${serverName}" require the "${ACCOUNT_PARAMETER}" parameter naming the account to act as.`;

  return `${intro} Accounts of "${serverName}": ${described}`;
}

// Injects the platform account parameter into one tool schema: an enum of the
// live account slugs, so an invalid address is rejected by the schema itself.
function withAccountParameter(fn: ToolFunction, slugs: string[], described: string[]): ToolFunction {
  const schema = fn.inputSchema;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  return {
    ...fn,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        [ACCOUNT_PARAMETER]: {
          type: 'string',
          enum: slugs,
          description: `The connected account to act as: ${described.join('; ')}`,
        },
      },
      required: [...required, ACCOUNT_PARAMETER],
    },
  };
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

function toUserAuthServer(
  serverName: string,
  config: ExternalServerConfig & { transport: 'http' },
  origin: ConnectedServer['origin'],
): UserAuthServer {
  return {
    name: serverName,
    origin,
    url: config.url,
    description: config.description?.trim() || serverName,
    clientRegistration: config.clientRegistration === 'manual' ? 'manual' : 'dynamic',
    scope: config.scope ?? null,
    authorizationParams: config.authorizationParams ?? null,
    identityProbe: config.identityProbe ?? null,
    toolOverrides: config.toolOverrides,
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
  const connected = new Map<string, ConnectedServer>();
  const nextUserAuth = new Map<string, UserAuthServer>();
  const nextPending = new Map<string, PendingExternalServer>();
  const nextLocalSources = new Map<string, LocalToolSource>();
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

    discovered.push({ name, config, origin });
  };

  for (const [serverName, module] of Object.entries(localToolModules)) {
    const source = await startLocalToolSource(serverName, module, ctx);

    nextLocalSources.set(serverName, source);
    addDiscovered(serverName, source.config, 'file');
  }

  for (const [serverName, config] of Object.entries(await readExternalServerConfigs())) {
    addDiscovered(serverName, config, 'external');
  }

  for (const { name: serverName, config, origin } of discovered) {
    if (config.transport === 'http' && config.auth === 'user') {
      nextUserAuth.set(serverName, toUserAuthServer(serverName, config, origin));
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
  for (const groups of userServers.values()) {
    for (const accounts of groups.values()) {
      for (const client of accounts.values()) {
        void client.close().catch(() => {});
      }
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
  // Global: the server itself. User: the group's canonical client — the call
  // site picks the actual account client from `accounts`.
  server: ConnectedServer;
  accounts?: UserServerAccounts;
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

  for (const [serverName, accounts] of userServers.get(userId)?.entries() ?? []) {
    if (!isServerInBundle(bundle, serverName)) {
      continue;
    }

    const canonical = canonicalClient(accounts);
    const fn = canonical?.functions.find(candidate => candidate.functionName === functionName);

    if (canonical && fn) {
      return { fn, server: canonical, accounts, scope: 'user' };
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

  const connectionRows = await ensureUserServers(userId);

  const functions = [...servers.values()]
    .filter(server => isServerInBundle(bundle, server.name))
    .flatMap(server => server.functions);

  // User-auth servers expose one function set per server — the canonical
  // client's — regardless of how many accounts are connected; every tool
  // schema gets the platform account parameter.
  for (const [serverName, accounts] of userServers.get(userId)?.entries() ?? []) {
    if (!isServerInBundle(bundle, serverName)) {
      continue;
    }

    const slugs = [...accounts.keys()];
    const described = slugs.map(slug => {
      const row = connectionRows.find(candidate => candidate.server === serverName && candidate.accountKey === slug);

      return row ? describeAccount(row) : slug;
    });

    for (const fn of canonicalClient(accounts)?.functions ?? []) {
      functions.push(withAccountParameter(fn, slugs, described));
    }
  }

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
      result: await runToolHandler(() => builtinServer.call(functionName, args, ctx)),
    };
  }

  const entry = getToolFunctionEntry(userId, bundle, functionName);

  if (!entry) {
    throw new Error(`Unknown tool "${functionName}"`);
  }

  const { fn, scope, accounts } = entry;

  let { server } = entry;
  let callArgs = args;

  // Resolve the platform account parameter: slug → this account's client. The
  // parameter never crosses the module boundary — it is stripped here; a
  // missing or unknown slug teaches instead of guessing.
  if (scope === 'user') {
    const { [ACCOUNT_PARAMETER]: accountArg, ...rest } = args;
    const target = typeof accountArg === 'string' ? accounts?.get(accountArg) : undefined;

    if (!target) {
      throw new Error(await accountSelectionError(fn.serverName, userId, accountArg, new Set(accounts?.keys() ?? [])));
    }

    server = target;
    callArgs = rest;
  }

  let raw: Record<string, unknown>;

  try {
    // Local (in-process) servers receive the calling run's identity in _meta:
    // a file ingested by a local tool must land in the caller's workspace, not
    // as an ownerless row. External servers never see workspace internals.
    const meta = server.origin === 'file' ? { _meta: { balabash: { userId, threadId: ctx.threadId } } } : {};

    raw = (await server.client.callTool({ name: fn.toolName, arguments: callArgs, ...meta }, undefined, {
      timeout: TOOL_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    })) as Record<string, unknown>;
  } catch (error) {
    // Tokens can die between the connect at turn start and the call itself.
    if (scope === 'user' && error instanceof UnauthorizedError) {
      if (server.accountKey) {
        dropUserClient(fn.serverName, userId, server.accountKey);
      }

      if (server.connectionId) {
        await markReauthorizationRequired(server.connectionId, getErrorMessage(error));
      }

      throw new Error(
        `Authorization for "${fn.serverName}" has expired. A re-authorization thread is started automatically — tell the user to complete it in the new topic; do not start another auth thread yourself.`,
      );
    }

    throw error;
  }

  // Verbatim record: the raw MCP answer exactly as the server
  // produced it — isError included ("the tool answered, albeit with an
  // error"). Only breakage of the call itself (transport, auth, unknown
  // tool) throws — journaled as tool.call.failed by the caller.
  return { serverName: fn.serverName, toolName: fn.toolName, result: raw as ToolResult };
}

