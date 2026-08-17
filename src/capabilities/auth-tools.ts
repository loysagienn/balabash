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
  getOauthClient,
  listUserConnections,
  requestAuthorization,
  requestOauthClientCredentials,
} from './connections/index.ts';
import { requestExternalServerCredentials } from './external-secrets.ts';

export const AUTH_SERVER_NAME = 'auth';

export const REQUEST_AUTHORIZATION_FUNCTION_NAME = 'request_authorization';
export const REQUEST_OAUTH_CLIENT_FUNCTION_NAME = 'request_oauth_client_credentials';
export const REQUEST_EXTERNAL_SERVER_CREDENTIALS_FUNCTION_NAME = 'request_external_server_credentials';

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

function describeConnectionStatus(status: string | undefined): string {
  switch (status) {
    case 'connected':
      return 'connected — issue a link only to re-authorize, e.g. when the user revoked access or asks to reconnect';
    case 'reauthorization_required':
      return 'authorization expired and must be renewed';
    case 'pending':
      return 'authorization link issued, not completed yet';
    default:
      return 'never connected';
  }
}

// request_authorization: servers ready for user authorization (dynamic
// registration, or manual with a provisioned OAuth client). Connected ones
// stay listed — access may have been revoked on the provider's side.
async function requestAuthorizationFunction(userId: string): Promise<ToolFunction | null> {
  const servers = listUserAuthServers();

  if (!servers.length) {
    return null;
  }

  const connections = await listUserConnections(userId);
  const statuses = new Map(connections.map(connection => [connection.server, connection.status]));
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

  const serverDescriptions = readyServers.map(
    server => `- ${server.name}: ${server.description} (${describeConnectionStatus(statuses.get(server.name))})`,
  );

  return serverEnumFunction(
    REQUEST_AUTHORIZATION_FUNCTION_NAME,
    `Create a one-time link that lets the user authorize or re-authorize Balabash in an external integration, and return that link. Send it to the user and wait: when they finish, a connection.completed event arrives in this thread and the integration's tools become available (connection.failed reports an error). Integrations:\n${serverDescriptions.join('\n')}`,
    readyServers.map(server => server.name),
    'The integration to authorize or re-authorize',
  );
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

function requireServerArg(args: JsonObject): string {
  const server = typeof args.server === 'string' ? args.server.trim() : '';

  if (!server) {
    throw new Error('The "server" argument is required');
  }

  return server;
}

export function createAuthToolServer(): BuiltinToolServer {
  return {
    name: AUTH_SERVER_NAME,
    functionNames: [
      REQUEST_AUTHORIZATION_FUNCTION_NAME,
      REQUEST_OAUTH_CLIENT_FUNCTION_NAME,
      REQUEST_EXTERNAL_SERVER_CREDENTIALS_FUNCTION_NAME,
    ],

    getFunctions: async userId => {
      const functions = await Promise.all([
        requestAuthorizationFunction(userId),
        requestOauthClientFunction(),
        Promise.resolve(requestExternalSecretsFunction()),
      ]);

      return functions.filter((fn): fn is ToolFunction => fn !== null);
    },

    call: async (toolName, args, ctx: BuiltinServerCallContext) => {
      const server = requireServerArg(args);

      if (toolName === REQUEST_AUTHORIZATION_FUNCTION_NAME) {
        const url = await requestAuthorization(ctx.userId, ctx.threadId, server);

        return `One-time authorization link for "${server}" (valid 15 minutes): ${url}\nSend it to the user and wait — a connection.completed event arrives in this thread when they finish, connection.failed on error.`;
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
