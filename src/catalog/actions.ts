// The actions: what an agent works with the tree by. They are given by a
// port and are not vertices of the tree; their names are reserved — no full
// name of a vertex may coincide with one. Here are their signatures and
// texts; `describe` and `call` are carried out by describe.ts and invoke.ts,
// `run_program` by the runner of programs.

import { z } from 'zod';
import { Account, JsonObject, JsonValue } from './types.ts';

export const ACTION_NAMES = ['describe', 'call', 'run_program'] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export type ActionDefinition = {
  name: ActionName;
  description: string;
  input: z.ZodObject;
  output: z.ZodType;
};

const accounts = z.array(Account).describe("Accounts of the node's connection; empty when it needs none.");

export const describeOutput = z.union([
  z.strictObject({
    kind: z.literal('node'),
    name: z.string().describe('Full name; empty for the root.'),
    summary: z.string(),
    guide: z.array(z.string()).describe('The recipes of the node that you can follow.'),
    accounts,
    children: z.array(
      z.strictObject({
        kind: z.enum(['node', 'capability']),
        name: z.string().describe('Full name.'),
        summary: z.string(),
      }),
    ),
  }),
  z.strictObject({
    kind: z.literal('capability'),
    name: z.string().describe('Full name.'),
    description: z.string(),
    signature: z.string().describe('Input and output types in TypeScript notation.'),
    types: z.array(z.string()).describe('Definitions of the named types the signature uses.'),
    accounts,
  }),
]);

export type DescribeValue = z.infer<typeof describeOutput>;

export const MAX_RUN_PROGRAM_SECONDS = 600;

export const ACTIONS: Record<ActionName, ActionDefinition> = {
  describe: {
    name: 'describe',
    description:
      'Describe a vertex of the catalog. A node gives its guide and one line per child; a capability gives its full description and signature. Omit `name` for the root.',
    input: z.strictObject({
      name: z.string().describe('Full name of a node or a capability.').optional(),
    }),
    output: describeOutput,
  },
  call: {
    name: 'call',
    description:
      'Call a capability by its full name. The input and the returned value follow the signature `describe` shows.',
    input: z.strictObject({
      name: z.string().describe('Full name of the capability.'),
      input: JsonObject.describe("Form set by the capability's signature.").optional(),
    }),
    output: JsonValue,
  },
  run_program: {
    name: 'run_program',
    description:
      'Run a program: JavaScript that calls capabilities and returns one result. `code` is the body of an async function with only `call(name, input)`, `describe(name)` and `console` in scope; a failed call throws a CapabilityError. Intermediate values and console output stay with the run: the returned JSON value is all you get. With nothing to return, end with `return null`.',
    input: z.strictObject({
      code: z.string(),
      timeoutSeconds: z.int().min(1).max(MAX_RUN_PROGRAM_SECONDS).default(120),
    }),
    output: JsonValue,
  },
};

export function isActionName(name: string): name is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(name);
}
