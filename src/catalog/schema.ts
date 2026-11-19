// From the author's zod description to the schema form of the catalog: JSON
// Schema in which a named type is a reference `#/types/<Name>` and nothing is
// inlined twice. The signature printer, the build checks and the ports all
// read this one form.

import { z } from 'zod';
import type { JsonSchema } from './json.ts';
import { getNamedType } from './types.ts';

export const TYPE_REF_PREFIX = '#/types/';

export type CatalogSchema = {
  schema: JsonSchema;
  // Definitions of the named types the conversion met, by name (the types
  // those use included).
  definitions: Record<string, JsonSchema>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function typeRefName(schema: JsonSchema): string | null {
  return typeof schema.$ref === 'string' && schema.$ref.startsWith(TYPE_REF_PREFIX)
    ? schema.$ref.slice(TYPE_REF_PREFIX.length)
    : null;
}

// zod's own artifacts that say nothing a signature or a port needs: the
// safe-integer bounds of every integer and the key type of a record.
function tidy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(tidy);
  }

  if (!isObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'propertyNames') {
      continue;
    }

    if (key === 'minimum' && entry === Number.MIN_SAFE_INTEGER) {
      continue;
    }

    if (key === 'maximum' && entry === Number.MAX_SAFE_INTEGER) {
      continue;
    }

    if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/$defs/')) {
      out[key] = `${TYPE_REF_PREFIX}${entry.slice('#/$defs/'.length)}`;
      continue;
    }

    // A property map is keyed by field names, not by schema keywords.
    out[key] =
      key === 'properties' && isObject(entry)
        ? Object.fromEntries(Object.entries(entry).map(([name, property]) => [name, tidy(property)]))
        : tidy(entry);
  }

  return out;
}

// How zod writes `z.json()`: a reference to a recursive schema it names
// itself. In the catalog "any JSON value" is the empty schema; a verbatim type
// built over it (a JSON object) keeps its own form and its reference to it.
function isOwnRecursion(definition: unknown): boolean {
  return isObject(definition) && typeof definition.$ref === 'string' && definition.$ref.startsWith('#/$defs/__schema');
}

// `io` chooses the side of the schema: in an input a field with a default is
// optional, in an output every key is present.
export function toCatalogSchema(schema: z.ZodType, io: 'input' | 'output'): CatalogSchema {
  const {
    $schema: _dialect,
    $defs,
    ...body
  } = z.toJSONSchema(schema, { io, target: 'draft-2020-12' }) as Record<string, unknown>;
  const definitions: Record<string, JsonSchema> = {};

  for (const [name, definition] of Object.entries(isObject($defs) ? $defs : {})) {
    const type = getNamedType(name);

    if (!type) {
      // zod names a recursive schema itself (`__schema0`); only the verbatim
      // "any JSON value" holds one, and it is written as the empty schema.
      continue;
    }

    definitions[name] = isOwnRecursion(definition) ? {} : (tidy(definition) as JsonSchema);
  }

  return { schema: tidy(body) as JsonSchema, definitions };
}

// The definition of one named type in the schema form of the catalog.
export function namedTypeSchema(name: string, io: 'input' | 'output'): CatalogSchema {
  const type = getNamedType(name);

  if (!type) {
    throw new Error(`Unknown named type "${name}"`);
  }

  const wrapped = toCatalogSchema(z.object({ value: type.schema }), io);
  const schema = wrapped.definitions[name];

  if (!schema) {
    throw new Error(`Type "${name}" did not convert to a definition`);
  }

  return { schema, definitions: wrapped.definitions };
}
