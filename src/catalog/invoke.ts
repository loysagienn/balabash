// The call of a capability — one path for every port and every caller, a
// model, a program or a task:
//
//   1. the call is checked against the caller's grant, every time, whatever
//      lies in the caller's context;
//   2. the arguments are checked against the input type and the conditions
//      between fields — before the action;
//   3. under an account connection the platform's `account` field is taken
//      out of the input and resolved to the account the call acts as;
//   4. the connection of the capability's node gives the call its authority:
//      the access of that account, or the installation's secrets;
//   5. the action runs on behalf of the caller the grant belongs to;
//   6. the outcome is a value of the output type or a CapabilityError —
//      whatever failed on the way, the connections layer included.
//
// The trace of a call (the journal record) joins this path when its form is
// designed.

import { ACTIONS } from './actions.ts';
import { ACCOUNT_FIELD, accountConnectionOf, connectionOf } from './catalog.ts';
import type {
  AccountAuthority,
  Authority,
  CallContext,
  Connection,
  ProgramScope,
  SecretAuthority,
} from './definition.ts';
import { capabilitySignature } from './describe.ts';
import { CapabilityError, toCapabilityError } from './errors.ts';
import { grantedVertex, nearestNodeHint, type ConnectionsPort, type Grant } from './grant.ts';
import { invalidInput, issuesOf, issuesText, parseActionInput, ruleIssues, type Issue } from './input.ts';
import type { JsonObject, JsonValue } from './json.ts';
import type { AccountValue } from './types.ts';

export type InvokeEnv = {
  connections: ConnectionsPort;
  signal?: AbortSignal;
  // The run of a program the call is made from.
  program?: ProgramScope;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeAccounts(service: string, accounts: AccountValue[]): string {
  const lines = accounts.map(
    account =>
      `${account.account} — "${account.name}"${account.identity ? ` (${account.identity})` : ''}, ${account.status}`,
  );

  return `Accounts of "${service}": ${lines.join('; ') || '(none)'}`;
}

// The account an address names, when it can act.
function connectedAccount(connection: Connection, accounts: AccountValue[], address: string): AccountValue {
  const account = accounts.find(candidate => candidate.account === address);

  if (!account) {
    throw new CapabilityError(
      'not_found',
      `No account "${address}" in "${connection.service}". ${describeAccounts(connection.service, accounts)}`,
    );
  }

  if (account.status !== 'connected') {
    throw new CapabilityError(
      'auth_required',
      `The account "${address}" of "${connection.service}" is not connected (${account.status}): the user has to authorize it.`,
    );
  }

  return account;
}

// What the connection gives the call to act with. The port answers
// `auth_required` itself when the connection is not in place any more; an
// authority of the wrong sort is a defect of the port.
async function authorityOf(
  grant: Grant,
  connection: Connection,
  account: AccountValue | null,
  env: InvokeEnv,
): Promise<Authority> {
  const authority =
    connection.type === 'account'
      ? await env.connections.accountAuthority(grant.caller.workspaceId, connection.service, account?.account ?? '')
      : await env.connections.secretAuthority(connection.service);

  if (authority?.type !== connection.type) {
    throw new CapabilityError('internal', `The connection "${connection.service}" gave no ${connection.type} authority.`);
  }

  return authority;
}

// The authority an action under an account connection acts with.
export function accountAuthority(ctx: CallContext): AccountAuthority {
  if (ctx.authority?.type !== 'account') {
    throw new CapabilityError('internal', 'The capability stands under no account connection: it has no account to act as.');
  }

  return ctx.authority;
}

// The authority an action under a secret connection acts with.
export function secretAuthority(ctx: CallContext): SecretAuthority {
  if (ctx.authority?.type !== 'secret') {
    throw new CapabilityError('internal', 'The capability stands under no secret connection: it has no secrets to act with.');
  }

  return ctx.authority;
}

async function invoke(grant: Grant, name: string, input: unknown, env: InvokeEnv): Promise<JsonValue> {
  const vertex = grantedVertex(grant, name);

  if (!vertex || vertex.kind !== 'capability' || name === '') {
    const what =
      vertex?.kind === 'node' && name !== ''
        ? `\`${name}\` is a node, not a capability`
        : `You have no capability \`${name}\``;

    throw new CapabilityError('unknown_capability', `${what}. ${nearestNodeHint(grant, name)}`);
  }

  const signature = capabilitySignature(vertex);
  // Only an input that was not passed at all stands for an empty one.
  const raw = input === undefined ? {} : input;

  if (!isPlainObject(raw)) {
    throw invalidInput(
      name,
      [{ path: '', message: 'The input is an object with the fields of the signature' }],
      signature,
    );
  }

  const connection = accountConnectionOf(vertex);
  const { [ACCOUNT_FIELD.name]: address, ...rest } = raw;
  const own = connection ? rest : raw;
  const parsed = vertex.definition.input.safeParse(own);
  const issues: Issue[] = parsed.success ? ruleIssues(vertex.inputRules, own) : issuesOf(parsed.error);
  const accounts = connection ? await env.connections.accounts(grant.caller.workspaceId, connection.service) : [];

  // The platform's field is refused the same way as the author's ones, with
  // what the caller needs to fill it: the accounts there are.
  if (connection && typeof address !== 'string') {
    issues.push({
      path: ACCOUNT_FIELD.name,
      message: `Pass the address of the account to act as. ${describeAccounts(connection.service, accounts)}`,
    });
  }

  if (!parsed.success || issues.length) {
    throw invalidInput(name, issues, signature);
  }

  const account = connection ? connectedAccount(connection, accounts, String(address)) : null;
  // A capability without a connection waits for nothing here: its action is
  // taken in the same tick as the call.
  const under = connectionOf(vertex);
  const authority = under ? await authorityOf(grant, under, account, env) : null;
  const value = await vertex.definition.run(parsed.data, {
    caller: grant.caller,
    account,
    authority,
    signal: env.signal ?? null,
    program: env.program ?? null,
  });

  // A value that does not fit the output type is a defect of the capability:
  // a chain of calls relies on the form of a result without looking at it.
  // The build lets no output type through that takes anything but JSON, so a
  // value that fits is a JSON value.
  const result = vertex.definition.output.safeParse(value);

  if (!result.success) {
    throw new CapabilityError(
      'internal',
      `\`${name}\` returned a value that does not fit its output type:\n${issuesText(issuesOf(result.error))}`,
      {
        issues: issuesOf(result.error),
      },
    );
  }

  return result.data as JsonValue;
}

export async function invokeCapability(grant: Grant, name: string, input: unknown, env: InvokeEnv): Promise<JsonValue> {
  try {
    return await invoke(grant, name, input, env);
  } catch (error) {
    throw toCapabilityError(error);
  }
}

// The action `call`: a call by full name for a port that cannot make an open
// capability callable directly, and for the programs of the platform.
export async function call(grant: Grant, input: unknown, env: InvokeEnv): Promise<JsonValue> {
  const args = parseActionInput(grant, ACTIONS.call, input) as { name: string; input?: JsonObject };

  return invokeCapability(grant, args.name, args.input, env);
}
