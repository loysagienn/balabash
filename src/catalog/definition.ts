// What an author writes: a capability (a leaf, a callable function) and a
// node (a group with a short summary and a guide). The definition does not
// know harnesses or protocols; the core in the prompt, the answer of
// `describe`, the check of arguments, the declarations for the ports and the
// signatures for programs are all derived from it.

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
  signal: AbortSignal | null;
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

export type Connection = {
  type: 'account' | 'secret';
  service: string;
  // What the service gives, one line for `connections_list`.
  summary: string;
  // What the operator sets up at the provider before the first authorization.
  setup?: string;
};

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
