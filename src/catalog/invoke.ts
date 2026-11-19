// The call of a capability — one path for every port and every caller, a
// model, a program or a task:
//
//   1. the call is checked against the caller's grant, every time, whatever
//      lies in the caller's context;
//   2. the arguments are checked against the input type and the conditions
//      between fields — before the action;
//   3. under an account connection the platform's `account` field is taken
//      out of the input and resolved to the account the call acts as;
//   4. the action runs;
//   5. the outcome is a value of the output type or a CapabilityError.
//
// The trace of a call (the journal record) joins this path when its form is
// designed.

import type { JsonObject, JsonValue } from '../core/contract.ts';
import { ACTIONS } from './actions.ts';
import { ACCOUNT_FIELD, accountConnectionOf, type CatalogCapability } from './catalog.ts';
import type { Caller } from './definition.ts';
import { capabilitySignature } from './describe.ts';
import { CapabilityError, toCapabilityError } from './errors.ts';
import { grantedVertex, nearestNodeHint, type ConnectionsPort, type Grant } from './grant.ts';
import { invalidInput, issuesOf, issuesText, parseActionInput, ruleIssues } from './input.ts';
import type { AccountValue } from './types.ts';

export type InvokeEnv = {
  caller: Caller;
  connections: ConnectionsPort;
  signal?: AbortSignal;
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

async function resolveAccount(
  capability: CatalogCapability,
  address: unknown,
  env: InvokeEnv,
): Promise<AccountValue | null> {
  const connection = accountConnectionOf(capability);

  if (!connection) {
    return null;
  }

  const accounts = await env.connections.accounts(env.caller.workspaceId, connection.service);

  if (typeof address !== 'string') {
    throw new CapabilityError(
      'invalid_input',
      `\`${capability.fullName}\` takes \`${ACCOUNT_FIELD.name}\`: the address of the account to act as. ${describeAccounts(connection.service, accounts)}`,
    );
  }

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

export async function invokeCapability(grant: Grant, name: string, input: unknown, env: InvokeEnv): Promise<JsonValue> {
  const vertex = grantedVertex(grant, name);

  if (!vertex || vertex.kind !== 'capability' || name === '') {
    const what =
      vertex?.kind === 'node' && name !== ''
        ? `\`${name}\` is a node, not a capability`
        : `You have no capability \`${name}\``;

    throw new CapabilityError('unknown_capability', `${what}. ${nearestNodeHint(grant, name)}`);
  }

  const signature = capabilitySignature(vertex);
  const raw = input ?? {};

  if (!isPlainObject(raw)) {
    throw invalidInput(
      name,
      [{ path: '', message: 'The input is an object with the fields of the signature' }],
      signature,
    );
  }

  const underAccount = accountConnectionOf(vertex) !== null;
  const { [ACCOUNT_FIELD.name]: address, ...rest } = raw;
  const own = underAccount ? rest : raw;
  const parsed = vertex.definition.input.safeParse(own);

  if (!parsed.success) {
    throw invalidInput(name, issuesOf(parsed.error), signature);
  }

  const broken = ruleIssues(vertex.inputRules, own);

  if (broken.length) {
    throw invalidInput(name, broken, signature);
  }

  const account = await resolveAccount(vertex, address, env);

  let value: unknown;

  try {
    value = await vertex.definition.run(parsed.data, { caller: env.caller, account, signal: env.signal ?? null });
  } catch (error) {
    throw toCapabilityError(error);
  }

  // A value that does not fit the output type is a defect of the capability:
  // a chain of calls relies on the form of a result without looking at it.
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

// The action `call`: a call by full name for a port that cannot make an open
// capability callable directly, and for the programs of the platform.
export async function call(grant: Grant, input: unknown, env: InvokeEnv): Promise<JsonValue> {
  const args = parseActionInput(grant, ACTIONS.call, input) as { name: string; input?: JsonObject };

  return invokeCapability(grant, args.name, args.input, env);
}
