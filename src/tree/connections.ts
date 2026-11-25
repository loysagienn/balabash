// The node `connections`: the connections of the workspace to outside
// services. What can be connected is the services of the tree (./services.ts
// registers them with the app's connections layer); the accounts, the OAuth
// clients and the secrets live in that layer, and so do the rules of the
// registry and the authorization itself. A capability here issues a link or
// changes the registry and returns at once: values travel through the web
// forms, never through a call, and the outcome comes back as an event
// addressed to the calling thread.

import { callAuthor } from './call-author.ts';
import { z } from 'zod';
import { Account, CapabilityError, capability, node, type AccountValue } from '../catalog/index.ts';
import {
  ConnectionError,
  disconnectConnection,
  hasOauthClient,
  listAccounts,
  listProvisionedOauthClients,
  reconnectConnection,
  renameConnection,
  requestOauthClientCredentials,
  startConnection,
  type ConnectLink,
} from '../capabilities/connections/index.ts';
import {
  getAccountService,
  getSecretService,
  listAccountServices,
  listSecretServices,
  refreshSecretServices,
  type AccountService,
} from '../capabilities/connections/services.ts';
import { forgetExternalServerSecrets, requestExternalServerCredentials } from '../capabilities/external-secrets.ts';
import { accountOf, accountValue } from './services.ts';

// A refusal of the connections layer as an error of the call; the texts are
// the layer's.
function refused(error: unknown): never {
  if (error instanceof ConnectionError) {
    const kind = error.code === 'bad_request' ? 'invalid_input' : error.code === 'not_found' ? 'not_found' : 'conflict';

    throw new CapabilityError(kind, error.message);
  }

  throw error;
}

function accountService(name: string): AccountService {
  const service = getAccountService(name);

  if (!service) {
    const known = listAccountServices().map(candidate => candidate.name);

    throw new CapabilityError(
      'not_found',
      `There is no account service "${name}". Account services: ${known.join(', ') || '(none)'}.`,
    );
  }

  return service;
}

// Installation services are refreshed before they are looked at: whether
// the secrets of each are stored is the state of the moment.
async function secretService(name: string): Promise<void> {
  await refreshSecretServices();

  if (!getSecretService(name)) {
    const known = listSecretServices().map(service => service.name);

    throw new CapabilityError(
      'not_found',
      `There is no installation service "${name}" that takes secrets. Installation services: ${known.join(', ') || '(none)'}.`,
    );
  }
}

function accountsText(accounts: AccountValue[]): string {
  return (
    accounts
      .map(
        account =>
          `${account.account} — "${account.name}"${account.identity ? ` (${account.identity})` : ''}, ${account.status}`,
      )
      .join('; ') || '(none)'
  );
}

const list = capability({
  name: 'list',
  summary: 'List the services, their accounts and the state of installation credentials',
  description:
    'List services managed in Balabash. Each user connects their own account to an account service. Installation credentials are shared.',
  input: z.strictObject({}),
  output: z.strictObject({
    accountServices: z.array(
      z.strictObject({
        service: z.string().describe('The value of `service` in the capabilities of this node.'),
        summary: z.string().describe('What the service gives.'),
        authorizedBy: z
          .enum(['oauth', 'key'])
          .describe('oauth: the user signs in at the provider; key: the user enters a key of their own at the provider in a form.'),
        oauthClient: z
          .enum(['dynamic', 'provisioned', 'missing', 'none'])
          .describe(
            'dynamic: the provider registers the client itself; missing: provision it before any account is authorized; none: a key service.',
          ),
        multipleAccounts: z.boolean(),
        accounts: z.array(Account),
      }),
    ),
    installationServices: z.array(
      z.strictObject({
        service: z.string(),
        summary: z.string().nullable(),
        secretNames: z.array(z.string()).describe('The secrets the service needs.'),
        status: z.enum(['connected', 'secrets_missing', 'failed']),
        error: z.string().nullable().describe('Of the last connection attempt, when status is failed.'),
      }),
    ),
  }),
  async run(_input, { caller }) {
    const rows = await listAccounts(caller.workspaceId);
    const provisioned = await listProvisionedOauthClients();

    await refreshSecretServices();

    return {
      accountServices: listAccountServices().map(service => ({
        service: service.name,
        summary: service.description,
        authorizedBy: service.key ? ('key' as const) : ('oauth' as const),
        oauthClient: service.key
          ? ('none' as const)
          : service.clientRegistration === 'dynamic'
            ? ('dynamic' as const)
            : provisioned.has(service.name)
              ? ('provisioned' as const)
              : ('missing' as const),
        multipleAccounts: service.identityProbe !== null,
        accounts: rows.filter(row => row.server === service.name).map(accountOf),
      })),
      installationServices: listSecretServices().map(service => ({
        service: service.name,
        summary: service.description,
        secretNames: service.secretNames,
        status: service.connected
          ? ('connected' as const)
          : service.error
            ? ('failed' as const)
            : ('secrets_missing' as const),
        error: service.connected ? null : service.error,
      })),
    };
  },
});

const authorize = capability({
  name: 'authorize',
  summary: 'Issue a link for the user to authorize or re-authorize an account',
  description:
    "Issue a one-time link for the user to authorize an account of a service, or to re-authorize an existing one. With neither `account` nor `name` the link is for the service's only account. The outcome arrives later as a connection.completed or connection.failed event in this thread. For a service authorized by key the link is a form for the key: a refused key is told there, not by an event.",
  input: z.strictObject({
    service: z.string(),
    account: z.string().optional().describe('An existing account to re-authorize.'),
    name: z.string().optional().describe('Human-readable name of a new, additional account.'),
  }),
  inputRules: [{ atMostOne: ['account', 'name'] }],
  output: z.strictObject({
    url: z.string(),
    expiresAt: z.string().describe('ISO 8601.'),
    account: Account.describe('The account the link is for, as it is now.'),
  }),
  async run(input, { caller }) {
    const service = accountService(input.service);
    const rows = await listAccounts(caller.workspaceId, service.name);
    const accounts = rows.map(accountOf);
    const name = input.name?.trim();
    // The account a link without a name is for: the one at the address
    // given, or the service's only one.
    const existing = input.account === undefined ? rows[0] : rows.find(row => row.accountKey === input.account);
    let link: ConnectLink;

    if (input.account !== undefined && !existing) {
      throw new CapabilityError(
        'not_found',
        `No account "${input.account}" in "${service.name}". Accounts: ${accountsText(accounts)}. A new account is added by name, not by address.`,
      );
    }

    if (input.name !== undefined && !name) {
      throw new CapabilityError('invalid_input', 'name is blank: give the new account a name the user will know it by.');
    }

    if (input.account === undefined && name === undefined && accounts.length > 1) {
      throw new CapabilityError(
        'invalid_input',
        `"${service.name}" has several accounts: pass account to re-authorize one of them, or name to add another. Accounts: ${accountsText(accounts)}.`,
      );
    }

    try {
      // A name always starts a new account; an address — given, or of the
      // service's only account — re-authorizes the very account seen here.
      // A service without accounts gets its first one. The layer judges
      // each of the three again when it writes: an account gone meanwhile
      // is not born again, a first account that is no longer the first is
      // refused.
      link =
        name !== undefined
          ? await startConnection(caller.workspaceId, caller.threadId, service.name, name)
          : existing
            ? await reconnectConnection(caller.workspaceId, caller.threadId, existing.id)
            : await startConnection(caller.workspaceId, caller.threadId, service.name, null);
    } catch (error) {
      refused(error);
    }

    const { connection } = link;

    return {
      url: link.url,
      expiresAt: link.expiresAt.toISOString(),
      account: accountValue(connection.accountKey, connection.displayName, connection.identity, connection.status),
    };
  },
});

const requestOauthClient = capability({
  name: 'request_oauth_client',
  summary: "Issue a link where the operator enters a service's OAuth client",
  description:
    'Issue a link to a form where the operator enters the OAuth client of the installation for a service: the client ID and secret of the app registered at the provider. The values are never returned. An oauth_client.provisioned event arrives in this thread when they are saved. Replacing a client keeps the connected accounts.',
  input: z.strictObject({ service: z.string() }),
  output: z.strictObject({
    url: z.string(),
    replacing: z.boolean().describe('true: a provisioned client will be replaced.'),
    setup: z.string().describe('What the operator sets up at the provider first.'),
  }),
  async run(input, ctx) {
    const { caller } = ctx;
    const service = accountService(input.service);

    if (service.key) {
      throw new CapabilityError(
        'invalid_input',
        `"${service.name}" is authorized by a key the user enters: there is no OAuth client. Its accounts are authorized right away.`,
      );
    }

    if (service.clientRegistration !== 'manual') {
      throw new CapabilityError(
        'invalid_input',
        `"${service.name}" registers its OAuth client at the provider itself: there is no client to enter. Its accounts are authorized right away.`,
      );
    }

    const replacing = await hasOauthClient(service.name);

    try {
      return {
        url: await requestOauthClientCredentials(caller.workspaceId, caller.threadId, service.name, callAuthor(ctx).task),
        replacing,
        setup: service.setup ?? service.description,
      };
    } catch (error) {
      refused(error);
    }
  },
});

const requestSecret = capability({
  name: 'request_secret',
  summary: "Issue a link where the operator enters a service's installation secrets",
  description:
    'Issue a link to a form where the operator enters or replaces the installation secrets of a service. The values are never returned. A secrets.provisioned event arrives in this thread when they are saved.',
  input: z.strictObject({ service: z.string() }),
  output: z.strictObject({ url: z.string() }),
  async run(input, ctx) {
    const { caller } = ctx;
    await secretService(input.service);

    return { url: await requestExternalServerCredentials(caller.workspaceId, caller.threadId, input.service, callAuthor(ctx).task) };
  },
});

const forgetSecret = capability({
  name: 'forget_secret',
  summary: "Delete a service's installation secrets and disconnect it for everyone",
  description:
    'Delete the stored installation secrets of a service: it is disconnected for every agent and every user until the secrets are entered again.',
  input: z.strictObject({ service: z.string() }),
  output: z.strictObject({ deleted: z.int().describe('How many secret values were deleted.') }),
  async run(input) {
    await secretService(input.service);

    return { deleted: await forgetExternalServerSecrets(input.service) };
  },
});

const rename = capability({
  name: 'rename',
  summary: 'Change the human-readable name of an account',
  description:
    'Change the human-readable name of an account. Its address and its identity at the provider do not change.',
  input: z.strictObject({ service: z.string(), account: z.string(), name: z.string().min(1) }),
  output: z.strictObject({ account: Account, previousName: z.string() }),
  async run(input, { caller }) {
    if (!input.name.trim()) {
      throw new CapabilityError('invalid_input', 'name is blank: give the account a name the user will know it by.');
    }

    try {
      const renamed = await renameConnection(
        caller.workspaceId,
        input.service,
        input.account,
        input.name,
        caller.threadId,
      );

      return { account: accountOf(renamed.connection), previousName: renamed.previousName };
    } catch (error) {
      refused(error);
    }
  },
});

const disconnect = capability({
  name: 'disconnect',
  summary: 'Disconnect an account and delete its stored tokens',
  description:
    'Disconnect an account and delete its stored tokens; its address becomes free. Access granted at the provider is not revoked by this.',
  input: z.strictObject({ service: z.string(), account: z.string() }),
  output: z.strictObject({ name: z.string().describe('The name the account had.') }),
  async run(input, { caller }) {
    try {
      const { name } = await disconnectConnection(caller.workspaceId, input.service, input.account, caller.threadId);

      return { name };
    } catch (error) {
      refused(error);
    }
  },
});

export const connections = node({
  name: 'connections',
  summary:
    "Connections of the workspace to outside services: the user's accounts and the credentials of the installation. Come here to connect or disconnect an account, or to have the operator enter credentials.",
  guide: [
    {
      text: 'Start with `connections_list`: it shows every service, its accounts with their status, whether its OAuth client is in place and which installation secrets are missing. Decide the next step from that state.',
    },
    {
      text: "A service whose OAuth client is missing takes two steps: `connections_request_oauth_client` for the client of the installation, then `connections_authorize` for the user's sign-in.",
    },
    {
      text: 'Every link is for the user: give it to them and wait. The call returns the link; the outcome arrives later as an event in this thread. Secret values never pass through the chat.',
    },
    {
      text: 'Re-authorize a connected account only when its authorization expired, access was revoked or the user asks. Replace a provisioned OAuth client or stored secrets only when the user asks.',
    },
    {
      text: 'To add another account to a service that holds several, ask the user for a name first and pass it as `name` to `connections_authorize`.',
    },
    {
      text: "Confirm with the user before `connections_disconnect` and `connections_forget_secret`. After a disconnect, remind them that a full revocation also needs Balabash's access removed at the provider.",
    },
  ],
  children: [list, authorize, requestOauthClient, requestSecret, forgetSecret, rename, disconnect],
});
