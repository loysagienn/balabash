// What an author writes: a capability (a leaf, a callable function) and a
// node (a group with a short summary and a guide). The definition does not
// know harnesses or protocols; the core in the prompt, the answer of
// `describe`, the check of arguments, the declarations for the ports and the
// signatures for programs are all derived from it.

import type { JsonSchema } from './json.ts';
import type { z } from 'zod';
import type { AccountValue } from './types.ts';

// On whose behalf a call is made.
export type Caller = {
  workspaceId: string;
  threadId: string;
  agentName: string;
};

export type CallContext = {
  caller: Caller;
  // The account the call acts as: set for a capability under a node with an
  // account connection (the platform takes it from the `account` field of the
  // input and resolves it), null everywhere else.
  account: AccountValue | null;
  // What the connection of the capability's node gives the action to act
  // with: the access of the account the call acts as, or the installation's
  // secrets of the service. Null for a capability without a connection.
  authority: Authority | null;
  // Fires when the call is cancelled: nobody waits for its outcome any more.
  signal: AbortSignal | null;
  // The run of a program the call was made from, null for a call made
  // directly.
  program: ProgramScope | null;
};

// The run of a program, as a call made from it sees it.
export type ProgramScope = {
  // The id of the run: the trace of the call carries it.
  runId: string;
  // Calls act as this scheduled task. In-place runs act as the calling agent.
  task: string | null;
  // Fires when the run is over, however it ended. A call goes on to its own
  // end all the same; only what belongs to the run and must not outlive it —
  // a command the program started — is stopped by this signal.
  ended: AbortSignal;
};

// A condition between optional fields of the input, printed in the signature
// and checked by the platform before the action.
export type InputRule = { exactlyOne: string[] } | { atLeastOne: string[] } | { atMostOne: string[] };

export type CapabilityDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> = {
  // One segment of the path; the full name is the path from the root joined
  // by underscores.
  name: string;
  // The one line the parent shows.
  summary: string;
  // What it does and what limits it; what `describe` of the capability shows.
  description: string;
  input: I;
  output: O;
  // Discovery supplies the JSON Schemas directly. The parsers below validate
  // those same schemas without converting them through a second dialect.
  serverSchemas?: { input: JsonSchema; output?: JsonSchema };
  inputRules?: InputRule[];
  // Gets a value of the input type and the caller; returns a value of the
  // output type or throws a CapabilityError.
  run(input: z.output<I>, ctx: CallContext): Promise<z.input<O>> | z.input<O>;
};

export type Capability = CapabilityDefinition & { kind: 'capability' };

// One recipe of a guide: "how to do this and that here". `requires` lists the
// full names of the capabilities and actions it needs besides the
// capabilities of its own node; a grant shows the recipe only when the
// caller has them all.
export type Recipe = {
  text: string;
  requires?: string[];
};

// The authority of a connection, ready to act with. The platform holds the
// tokens and the secrets and puts them in: a capability never asks the model
// for a secret, and its action never learns how the authority was obtained.
export type AccountAuthority = {
  type: 'account';
  // The access token of the account the call acts as, good now: the platform
  // renews it ahead of its expiry. `rejected` names a token the provider has
  // just refused: the answer is a newer one. An account that can no longer
  // act — its authorization is gone — answers with `auth_required`.
  accessToken(rejected?: string): Promise<string>;
};

export type SecretAuthority = {
  type: 'secret';
  // The installation's secrets of the service, under the names its
  // connection declares.
  secrets: Readonly<Record<string, string>>;
};

export type Authority = AccountAuthority | SecretAuthority;

// How the platform asks the provider who an account is: a GET with the
// account's access token; the fields are paths into the JSON answer. A
// service that declares a probe can hold several accounts — the probe is
// what tells two of them apart.
export type IdentityProbe = {
  url: string;
  idField: string;
  labelField?: string;
  // The scheme the token goes under in the Authorization header: Bearer
  // when not said; "none" sends the token bare.
  authScheme?: 'Bearer' | 'OAuth' | 'none';
};

// How an account of the service is authorized: OAuth 2 with the user's
// consent.
export type OAuthSettings = {
  // Where the discovery of the authorization server starts: the protected
  // resource, when it names its authorization server itself (RFC 9728, an
  // MCP server), or the authorization server.
  url: string;
  // dynamic: the provider registers the client itself; manual: the operator
  // registers an app at the provider and enters its client once for the
  // installation.
  clientRegistration: 'dynamic' | 'manual';
  scope?: string;
  // Extra parameters of the consent request.
  authorizationParams?: Record<string, string>;
  identityProbe?: IdentityProbe;
};

type ConnectionTexts = {
  // The name of the service: the key its accounts, its OAuth client and its
  // secrets are stored under. One node of the tree declares it.
  service: string;
  // What the service gives, one line for `connections_list`.
  summary: string;
  // What the operator sets up at the provider before the first authorization.
  setup?: string;
};

// How an account of the service is authorized: by a key of the user's own
// at the provider (an API key, a personal token) that the user enters in a
// form of the console. The platform keeps it with the account and hands it
// to the action as the account's access token; a key the provider refuses
// sends the account to be authorized again — the user enters a new one.
export type KeySettings = {
  // What the provider calls the key: the label of the field the user fills.
  label: string;
  // Where the user gets the key and what it must allow: shown under the field.
  instructions?: string;
  // Asked with the key as it is entered: a key the provider refuses is not
  // stored, and the answer says whose it is. A service that declares a probe
  // can hold several accounts. The key goes with the request, so the probe
  // is an https address; only a service on this very host (a loopback
  // address) may be asked over http.
  identityProbe?: IdentityProbe;
};

// Each user connects their own account: by OAuth consent, or by a key.
export type AccountConnection = ConnectionTexts & { type: 'account' } & (
  | { oauth: OAuthSettings; key?: undefined }
  | { key: KeySettings; oauth?: undefined }
);

// The installation is connected once for everyone, by secrets the operator
// enters; `secrets` names them.
export type SecretConnection = ConnectionTexts & { type: 'secret'; secrets: readonly string[] };

export type Connection = AccountConnection | SecretConnection;

export type NodeDefinition = {
  name: string;
  // What is here and when to come; shown one level up.
  summary: string;
  guide?: Recipe[];
  // The connection the capabilities below need. An account connection adds
  // the platform's `account` field to the input of each of them.
  connection?: Connection;
  // An external server: the names of input fields stay as the server calls
  // them.
  external?: boolean;
  // Installation nodes address agents or profiles; revision identifies the
  // published contract for ports that retain an opening across turns.
  installation?: { source: 'authored' | 'discovered'; recipients: string[]; revision: string };
  children: Vertex[];
};

export type Node = NodeDefinition & { kind: 'node' };

export type Vertex = Node | Capability;

// The root is a node without a name: its guide and the lines of its children
// are the core that lies in the prompt.
export type RootDefinition = Omit<NodeDefinition, 'name' | 'connection' | 'external'>;

export function capability<I extends z.ZodObject, O extends z.ZodType>(
  definition: CapabilityDefinition<I, O>,
): Capability {
  return { kind: 'capability', ...definition } as unknown as Capability;
}

export function node(definition: NodeDefinition): Node {
  return { kind: 'node', ...definition };
}
