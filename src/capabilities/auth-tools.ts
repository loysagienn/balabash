// The auth agent's tool server: issuing one-time links
// for per-user OAuth authorization, manual installation OAuth clients and
// installation secrets. Only the auth agent lists it in its tool bundle.
// The tools return links and instructions; the values
// travel out-of-band through the web forms, and the outcomes come back as
// thread-addressed connection.* / *.provisioned events.

import type { JsonObject } from '../core/contract.ts';
import type { ToolFunction } from './mcp-client.ts';
import type { BuiltinServerCallContext, BuiltinToolServer, UserAuthServer } from './tool-manager.ts';
import { listExternalSecretTargets, listUserAuthServers } from './tool-manager.ts';
import {
  ACCOUNT_KEY_PATTERN,
  disconnectConnection,
  getOauthClient,
  listUserConnections,
  renameConnection,
  requestAuthorization,
  requestOauthClientCredentials,
} from './connections/index.ts';
import { identityLabel } from './connections/identity.ts';
import { requestExternalServerCredentials } from './external-secrets.ts';

export const AUTH_SERVER_NAME = 'auth';

export const REQUEST_AUTHORIZATION_FUNCTION_NAME = 'request_authorization';
export const REQUEST_OAUTH_CLIENT_FUNCTION_NAME = 'request_oauth_client_credentials';
export const REQUEST_EXTERNAL_SERVER_CREDENTIALS_FUNCTION_NAME = 'request_external_server_credentials';
export const RENAME_CONNECTION_FUNCTION_NAME = 'rename_connection';
export const DISCONNECT_CONNECTION_FUNCTION_NAME = 'disconnect_connection';

// ---------------------------------------------------------------------------
// Account naming: the display name is the user's word, the slug is the
// immutable mnemonic address derived from it at birth.

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function deriveAccountKey(name: string, taken: ReadonlySet<string>): string {
  const base = name
    .toLowerCase()
    .split('')
    .map(char => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);
  const root = base && ACCOUNT_KEY_PATTERN.test(base) ? base : 'account';

  if (!taken.has(root)) {
    return root;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${root}-${suffix}`;

    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function serverEnumFunction(
  toolName: string,
  description: string,
  serverNames: string[],
  serverDescription: string,
): ToolFunction {
  return {
    functionName: toolName,
    serverName: AUTH_SERVER_NAME,
    toolName,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          enum: serverNames,
          description: serverDescription,
        },
      },
      required: ['server'],
      additionalProperties: false,
    },
  };
}

function describeAccountStatus(status: string): string {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'reauthorization_required':
      return 'authorization expired';
    case 'pending':
      return 'link issued, not completed yet';
    default:
      return status;
  }
}

type ConnectionRow = Awaited<ReturnType<typeof listUserConnections>>[number];

function describeAccountRow(row: ConnectionRow): string {
  const label = identityLabel(row.identity);

  return `${row.accountKey} — "${row.displayName}"${label ? ` <${label}>` : ''} (${describeAccountStatus(row.status)})`;
}

function listAccountRows(rows: ConnectionRow[]): string {
  return rows.map(row => describeAccountRow(row)).join('; ') || '(none)';
}

// request_authorization: servers ready for user authorization (dynamic
// registration, or manual with a provisioned OAuth client). Connected ones
// stay listed — access may have been revoked on the provider's side.
async function requestAuthorizationFunction(connections: ConnectionRow[]): Promise<ToolFunction | null> {
  const servers = listUserAuthServers();

  if (!servers.length) {
    return null;
  }

  const readiness = await Promise.all(
    servers.map(async server => ({
      server,
      ready: server.clientRegistration === 'dynamic' || Boolean(await getOauthClient(server.name)),
    })),
  );
  const readyServers = readiness.filter(entry => entry.ready).map(entry => entry.server);

  if (!readyServers.length) {
    return null;
  }

  const serverDescriptions = readyServers.map(server => {
    const rows = connections.filter(row => row.server === server.name);
    const multi = server.identityProbe
      ? '; supports multiple accounts — pass "name" to connect another one'
      : '; single account only';

    return `- ${server.name}: ${server.description} (accounts: ${listAccountRows(rows)}${multi})`;
  });

  return {
    functionName: REQUEST_AUTHORIZATION_FUNCTION_NAME,
    serverName: AUTH_SERVER_NAME,
    toolName: REQUEST_AUTHORIZATION_FUNCTION_NAME,
    description: `Create a one-time link that lets the user authorize or re-authorize Balabash in an external integration, and return that link. For an already connected account issue a link only to re-authorize — e.g. when authorization expired, access was revoked, or the user asks. To connect an ADDITIONAL account of a multi-account integration, ask the user for a human-readable name first and pass it as "name". Send the link to the user and wait: when they finish, a connection.completed event arrives in this thread and the integration's tools become available (connection.failed reports an error). Integrations:\n${serverDescriptions.join('\n')}`,
    inputSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          enum: readyServers.map(server => server.name),
          description: 'The integration to authorize or re-authorize',
        },
        account: {
          type: 'string',
          description:
            'Slug of the existing account to (re-)authorize. Required when the integration has several accounts; may be omitted otherwise.',
        },
        name: {
          type: 'string',
          description:
            'Human-readable name for connecting a NEW additional account — how the user will refer to it (e.g. "Клиент А"). The immutable slug address is derived from it. Not together with "account".',
        },
      },
      required: ['server'],
      additionalProperties: false,
    },
  };
}

// rename_connection / disconnect_connection: lifecycle verbs over existing
// accounts; exposed only when the user has connections at all.
function lifecycleFunctions(connections: ConnectionRow[]): ToolFunction[] {
  if (!connections.length) {
    return [];
  }

  const serverNames = [...new Set(connections.map(row => row.server))].sort();
  const lines = serverNames
    .map(serverName => `- ${serverName}: ${listAccountRows(connections.filter(row => row.server === serverName))}`)
    .join('\n');
  const serverProperty = {
    type: 'string',
    enum: serverNames,
    description: 'The integration the account belongs to',
  };

  return [
    {
      functionName: RENAME_CONNECTION_FUNCTION_NAME,
      serverName: AUTH_SERVER_NAME,
      toolName: RENAME_CONNECTION_FUNCTION_NAME,
      description: `Rename a connected account: changes its human-readable display name only; the slug (the address used in tool calls) and the provider identity never change. Accounts:\n${lines}`,
      inputSchema: {
        type: 'object',
        properties: {
          server: serverProperty,
          account: { type: 'string', description: 'Slug of the account to rename' },
          name: { type: 'string', description: 'The new display name' },
        },
        required: ['server', 'account', 'name'],
        additionalProperties: false,
      },
    },
    {
      functionName: DISCONNECT_CONNECTION_FUNCTION_NAME,
      serverName: AUTH_SERVER_NAME,
      toolName: DISCONNECT_CONNECTION_FUNCTION_NAME,
      description: `Disconnect an account of an integration: it disappears from every listing and its tools stop acting for it. Confirm with the user before calling. Stored tokens are deleted; remind the user to also revoke Balabash's access in the provider's security settings if they want a full revocation. Accounts:\n${lines}`,
      inputSchema: {
        type: 'object',
        properties: {
          server: serverProperty,
          account: { type: 'string', description: 'Slug of the account to disconnect' },
        },
        required: ['server', 'account'],
        additionalProperties: false,
      },
    },
  ];
}

// request_oauth_client_credentials: manual-registration servers still missing
// an installation-level OAuth client.
async function requestOauthClientFunction(): Promise<ToolFunction | null> {
  const missingClients: UserAuthServer[] = [];

  for (const server of listUserAuthServers()) {
    if (server.clientRegistration === 'manual' && !(await getOauthClient(server.name))) {
      missingClients.push(server);
    }
  }

  if (!missingClients.length) {
    return null;
  }

  return serverEnumFunction(
    REQUEST_OAUTH_CLIENT_FUNCTION_NAME,
    `Create a one-time web link where the operator can securely enter installation-level OAuth client credentials. Values go directly to the database and are never returned to the model or written to the event log. Send the link to the user and wait for an oauth_client.provisioned event in this thread. Integrations missing a manual OAuth client:\n${missingClients.map(server => `- ${server.name}: ${server.description}`).join('\n')}`,
    missingClients.map(server => server.name),
    'The integration whose installation OAuth client must be provisioned',
  );
}

// request_external_server_credentials: servers waiting for (or already
// running on) ${secret:NAME} installation credentials.
function requestExternalSecretsFunction(): ToolFunction | null {
  const targets = listExternalSecretTargets();

  if (!targets.length) {
    return null;
  }

  const lines = targets.map(target => {
    const status = target.error
      ? `last connection error: ${target.error}`
      : target.connected
        ? 'connected — issue a link only to replace or rotate credentials'
        : 'credentials required';

    return `- ${target.name}: fields ${target.secretNames.join(', ')} (${status})`;
  });

  return serverEnumFunction(
    REQUEST_EXTERNAL_SERVER_CREDENTIALS_FUNCTION_NAME,
    `Create a one-time web link where the operator can securely enter or replace installation credentials for a global external MCP server. Values go directly to the database and are never returned to the model or written to the event log. Send the link to the user and wait for a secrets.provisioned event in this thread. For a connected server, call this only when the user asks to replace or rotate credentials. Servers:\n${lines.join('\n')}`,
    targets.map(target => target.name),
    'The external MCP server whose installation credentials must be provisioned',
  );
}

function requireStringArg(args: JsonObject, key: string): string {
  const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';

  if (!value) {
    throw new Error(`The "${key}" argument is required`);
  }

  return value;
}

function optionalStringArg(args: JsonObject, key: string): string | null {
  const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';

  return value || null;
}

// Resolves the target account of an authorization link: an existing slug, a
// new named account, or — with neither given — the only existing account.
async function resolveAuthorizationTarget(
  userId: string,
  serverName: string,
  args: JsonObject,
): Promise<{ accountKey?: string; displayName?: string }> {
  const account = optionalStringArg(args, 'account');
  const name = optionalStringArg(args, 'name');

  if (account && name) {
    throw new Error('Pass either "account" (re-authorize an existing one) or "name" (connect a new one), not both');
  }

  const rows = (await listUserConnections(userId)).filter(row => row.server === serverName);

  if (account) {
    const row = rows.find(candidate => candidate.accountKey === account);

    if (!row) {
      throw new Error(`No account "${account}" of "${serverName}". Accounts: ${listAccountRows(rows)}`);
    }

    return { accountKey: row.accountKey };
  }

  if (name) {
    const clash = rows.find(row => row.displayName.trim().toLowerCase() === name.toLowerCase());

    if (clash) {
      throw new Error(
        `Name "${name}" is already used by account "${clash.accountKey}" of "${serverName}" — pass account: "${clash.accountKey}" to re-authorize it instead`,
      );
    }

    return {
      // 'default' is reserved for the pre-multi-account singleton: a user
      // named "Default" must not become indistinguishable from it.
      accountKey: deriveAccountKey(name, new Set([...rows.map(row => row.accountKey), 'default'])),
      displayName: name,
    };
  }

  if (rows.length > 1) {
    throw new Error(`"${serverName}" has several accounts — pass "account". Accounts: ${listAccountRows(rows)}`);
  }

  return { accountKey: rows[0]?.accountKey };
}

export function createAuthToolServer(): BuiltinToolServer {
  return {
    name: AUTH_SERVER_NAME,
    functionNames: [
      REQUEST_AUTHORIZATION_FUNCTION_NAME,
      REQUEST_OAUTH_CLIENT_FUNCTION_NAME,
      REQUEST_EXTERNAL_SERVER_CREDENTIALS_FUNCTION_NAME,
      RENAME_CONNECTION_FUNCTION_NAME,
      DISCONNECT_CONNECTION_FUNCTION_NAME,
    ],

    getFunctions: async userId => {
      // One connections fetch feeds every account-aware surface of this turn.
      const connections = await listUserConnections(userId);
      const functions = await Promise.all([
        requestAuthorizationFunction(connections),
        requestOauthClientFunction(),
        Promise.resolve(requestExternalSecretsFunction()),
      ]);

      return [...functions.filter((fn): fn is ToolFunction => fn !== null), ...lifecycleFunctions(connections)];
    },

    call: async (toolName, args, ctx: BuiltinServerCallContext) => {
      const server = requireStringArg(args, 'server');

      if (toolName === REQUEST_AUTHORIZATION_FUNCTION_NAME) {
        const target = await resolveAuthorizationTarget(ctx.userId, server, args);
        const url = await requestAuthorization(ctx.userId, ctx.threadId, server, target.accountKey, target.displayName);
        const accountNote = target.displayName
          ? ` (new account "${target.accountKey}" — "${target.displayName}")`
          : target.accountKey
            ? ` (account "${target.accountKey}")`
            : '';

        return `One-time authorization link for "${server}"${accountNote} (valid 15 minutes): ${url}\nSend it to the user and wait — a connection.completed event arrives in this thread when they finish, connection.failed on error.`;
      }

      if (toolName === RENAME_CONNECTION_FUNCTION_NAME) {
        const account = requireStringArg(args, 'account');
        const name = requireStringArg(args, 'name');
        const result = await renameConnection(ctx.userId, server, account, name);

        return `Account "${result.accountKey}" of "${server}" renamed: "${result.previousName}" → "${result.name}". The slug stays "${result.accountKey}".`;
      }

      if (toolName === DISCONNECT_CONNECTION_FUNCTION_NAME) {
        const account = requireStringArg(args, 'account');
        const result = await disconnectConnection(ctx.userId, server, account);

        return `Account "${result.accountKey}" ("${result.name}") of "${server}" is disconnected and its stored tokens are deleted. If the user wants a full revocation, remind them to also revoke Balabash's access in the provider's security settings.`;
      }

      if (toolName === REQUEST_OAUTH_CLIENT_FUNCTION_NAME) {
        const url = await requestOauthClientCredentials(ctx.userId, ctx.threadId, server);

        return `One-time operator link for the installation OAuth client of "${server}" (valid 15 minutes): ${url}\nSend it to the user and wait — an oauth_client.provisioned event arrives in this thread when the client is saved.`;
      }

      if (toolName === REQUEST_EXTERNAL_SERVER_CREDENTIALS_FUNCTION_NAME) {
        const url = await requestExternalServerCredentials(ctx.userId, ctx.threadId, server);

        return `One-time operator link for the installation credentials of "${server}" (valid 15 minutes): ${url}\nSend it to the user and wait — a secrets.provisioned event arrives in this thread when the values are saved.`;
      }

      throw new Error(`Unknown auth tool "${toolName}"`);
    },
  };
}
