// Named types of the catalog: declared once, named in every signature that
// uses them. A named type is a zod schema registered under its name — zod
// then refers to it by `$ref` wherever it stands, and a field keeps its own
// comment next to the reference (`FileId.describe('…')`).
//
// The registry is module-level on purpose, like zod's own: a type is a
// property of the schema instance, not of one catalog build.

import { z } from 'zod';
import { ERROR_KINDS } from './errors.ts';

// Where a type may stand. `output` — only in outputs (every key always
// present); `input` — only in inputs; `any` — in both; `verbatim` — someone
// else's JSON carried as is, its inside is not checked; `error` — the error
// of a failed call.
export type TypeUse = 'output' | 'input' | 'any' | 'verbatim' | 'error';

export type NamedType = {
  name: string;
  description: string;
  use: TypeUse;
  schema: z.ZodType;
};

export const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

const namedTypes = new Map<string, NamedType>();

// Declares a named type and returns its schema, to be used in fields as is.
export function namedType<T extends z.ZodType>(
  name: string,
  options: { description: string; use?: TypeUse },
  schema: T,
): T {
  if (!TYPE_NAME_PATTERN.test(name)) {
    throw new Error(`Type name "${name}" must match ${TYPE_NAME_PATTERN}`);
  }

  if (namedTypes.has(name)) {
    throw new Error(`Type "${name}" is declared twice`);
  }

  const registered = schema.meta({ id: name }) as T;

  namedTypes.set(name, { name, description: options.description, use: options.use ?? 'output', schema: registered });

  return registered;
}

export function getNamedType(name: string): NamedType | null {
  return namedTypes.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// The types of the platform itself. The types of a node (Event, Thread,
// Project, …) are declared next to the capabilities that own them.

export const FileId = namedType(
  'FileId',
  { description: 'Id of a file in Balabash storage: the form a file takes in an input.', use: 'any' },
  z.string(),
);

// The pair kind: 'file' is reserved for FileRef: by this mark the journal and
// the interface recognize a file inside any value without a schema.
export const FileRef = namedType(
  'FileRef',
  {
    description:
      'Reference to a file in Balabash storage: the form a file takes in an output. Identity and metadata, never content.',
  },
  z.strictObject({
    kind: z.literal('file').describe('Marks a file inside any value.'),
    id: FileId,
    name: z.string().nullable(),
    contentType: z.string().nullable().describe('MIME type.'),
    sizeBytes: z.int().nullable(),
    width: z.int().nullable().describe('Pixels; images only.'),
    height: z.int().nullable().describe('Pixels; images only.'),
  }),
);

export const JsonValue = namedType(
  'JsonValue',
  { description: 'Any JSON value carried verbatim; the field that uses it names what sets its form.', use: 'verbatim' },
  z.json(),
);

export const JsonObject = namedType(
  'JsonObject',
  {
    description:
      "A JSON object carried verbatim in another system's format; the field that uses it names what sets its form.",
    use: 'verbatim',
  },
  z.record(z.string(), JsonValue),
);

export const CapabilityErrorType = namedType(
  'CapabilityError',
  { description: 'What a failed call gives instead of a value.', use: 'error' },
  z.strictObject({
    kind: z.enum(ERROR_KINDS).describe('Tells who can fix it.'),
    message: z.string().describe('What went wrong and what to change.'),
    details: JsonValue.describe('Specifics of this error.').optional(),
  }),
);

export const WorkspacePath = namedType(
  'WorkspacePath',
  {
    description: 'Path relative to the root of the workspace file area: no leading "/", no "." or ".." segments.',
    use: 'any',
  },
  z.string().max(300),
);

export const Account = namedType(
  'Account',
  { description: 'One account of a service connected, or being connected, in this workspace.' },
  z.strictObject({
    account: z
      .string()
      .describe('Address of the account: immutable, unique within the service; the value of `account` in calls.'),
    name: z.string().describe('Human-readable name; it can be renamed.'),
    identity: z.string().nullable().describe('Who the account is at the provider, when known.'),
    status: z
      .enum(['connected', 'reauthorization_required', 'pending'])
      .describe('Only a connected account can act. pending: the sign-in link is not completed yet.'),
  }),
);

export type FileRefValue = z.infer<typeof FileRef>;
export type AccountValue = z.infer<typeof Account>;
