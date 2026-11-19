// The signature printer: one record in TypeScript notation that serves the
// model, a call by name and the code of a program. A signature is the whole
// contract of an input: ranges, lengths, integers, patterns, defaults and the
// conditions between fields are all printed. One printer for every
// capability — its own or of an external server.

import type { InputRule } from './definition.ts';
import type { JsonSchema } from './json.ts';
import { typeRefName } from './schema.ts';

const pad = (depth: number): string => '  '.repeat(depth);

function typeList(schema: JsonSchema): string[] {
  return Array.isArray(schema.type)
    ? (schema.type as string[])
    : schema.type === undefined
      ? []
      : [schema.type as string];
}

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function typeText(schema: JsonSchema, depth: number, input = false): string {
  const ref = typeRefName(schema);

  if (ref) {
    return ref;
  }

  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  }

  const options = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;

  if (options) {
    return options.map(option => typeText(option, depth, input)).join(' | ');
  }

  const types = typeList(schema);

  if (!types.length) {
    return schema.properties ? objectText(schema, depth, [], input) : 'JsonValue';
  }

  return types
    .map(type => {
      if (type === 'object') {
        return objectText(schema, depth, [], input);
      }

      if (type === 'array') {
        const inner = typeText(isSchema(schema.items) ? schema.items : {}, depth, input);

        return inner.includes('|') ? `Array<${inner}>` : `${inner}[]`;
      }

      return type === 'integer' ? 'number' : type;
    })
    .join(' | ');
}

export function objectText(schema: JsonSchema, depth: number, rules: string[] = [], input = false): string {
  const properties = Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>);

  if (!properties.length) {
    if (isSchema(schema.additionalProperties)) {
      return `Record<string, ${typeText(schema.additionalProperties, depth, input)}>`;
    }

    return schema.additionalProperties === false ? '{}' : 'JsonObject';
  }

  const required = new Set((schema.required ?? []) as string[]);
  const lines = properties.map(([name, property]) => {
    const notes = [property.description, constraintText(property, input)].filter(Boolean).join(' ');

    return `${pad(depth + 1)}${name}${required.has(name) ? '' : '?'}: ${typeText(property, depth + 1, input)};${notes ? `  // ${notes}` : ''}`;
  });

  return `{\n${[...rules.map(rule => `${pad(depth + 1)}// ${rule}`), ...lines].join('\n')}\n${pad(depth)}}`;
}

// The schema keywords the printer reads. The build refuses an input type
// that carries any other: a signature is the whole contract of an input.
export const PRINTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'description',
  'default',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
]);

// Everything the schema limits a value by, the way a signature says it:
// [integer, 1..25, default 10]. That a number is an integer is said only in
// an input: there the caller has to obey it. The limits of the elements of an
// array come last: [1..50 items, each: integer, ≥1].
export function constraintText(schema: JsonSchema, input = false): string {
  const parts: string[] = [];
  const range = (low: unknown, high: unknown, unit: string): string =>
    low !== undefined && high !== undefined
      ? `${low}..${high}${unit}`
      : low !== undefined
        ? `≥${low}${unit}`
        : `≤${high}${unit}`;

  if (input && typeList(schema).includes('integer')) {
    parts.push('integer');
  }

  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    parts.push(range(schema.minimum, schema.maximum, ''));
  }

  if (schema.exclusiveMinimum !== undefined) {
    parts.push(`>${schema.exclusiveMinimum}`);
  }

  if (schema.exclusiveMaximum !== undefined) {
    parts.push(`<${schema.exclusiveMaximum}`);
  }

  if (schema.multipleOf !== undefined) {
    parts.push(`multiple of ${schema.multipleOf}`);
  }

  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    parts.push(
      schema.minLength === 1 && schema.maxLength === undefined
        ? 'not empty'
        : range(schema.minLength, schema.maxLength, ' chars'),
    );
  }

  if (schema.minItems !== undefined || schema.maxItems !== undefined) {
    parts.push(range(schema.minItems, schema.maxItems, ' items'));
  }

  if (schema.pattern) {
    parts.push(`/${schema.pattern}/`);
  }

  if (schema.default !== undefined) {
    parts.push(`default ${JSON.stringify(schema.default)}`);
  }

  // An element that is an object prints its own fields, a named type its own
  // definition; a plain element has no other place for its limits.
  if (isSchema(schema.items) && !typeRefName(schema.items) && !schema.items.properties) {
    const each = constraintText(schema.items, input);

    if (each) {
      parts.push(`each: ${each.slice(1, -1)}`);
    }
  }

  return parts.length ? `[${parts.join(', ')}]` : '';
}

export function ruleText(rule: InputRule): string {
  const [kind, fields] = Object.entries(rule)[0] as [keyof typeof RULE_WORDS, string[]];

  return `${RULE_WORDS[kind]}: ${fields.join(', ')}`;
}

const RULE_WORDS = { exactlyOne: 'exactly one of', atLeastOne: 'at least one of', atMostOne: 'at most one of' };

export function wrap(text: string, indent: string, width = 110): string {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let line = '';

    for (const word of paragraph.split(' ')) {
      if (line && `${line} ${word}`.length > width - indent.length) {
        lines.push(indent + line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }

    lines.push(indent + line);
  }

  return lines.join('\n');
}

export type Callable = {
  name: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  inputRules?: InputRule[];
};

// The signature of a capability or an action: its input and output types.
export function signatureText(callable: Callable): string {
  const rules = (callable.inputRules ?? []).map(ruleText);

  return `${callable.name}(input: ${objectText(callable.input, 0, rules, true)}): ${typeText(callable.output, 0)}`;
}

// The signature under its full description — the form in which a capability
// is printed for reading.
export function declarationText(callable: Callable): string {
  return `/**\n${wrap(callable.description, ' * ')}\n */\n${signatureText(callable)}`;
}

export type TypeDefinition = {
  name: string;
  description: string;
  use: 'output' | 'input' | 'any' | 'verbatim' | 'error';
  schema: JsonSchema;
};

const VERBATIM_BODIES: Record<string, string> = {
  JsonValue: 'string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }',
  JsonObject: '{ [key: string]: JsonValue }',
};

// The definition of a named type, the way `describe` hands it out with a
// capability.
export function typeDefinitionText(type: TypeDefinition): string {
  const input = type.use === 'input' || type.use === 'any';
  const body = VERBATIM_BODIES[type.name] ?? typeText(type.schema, 0, input);
  const notes = type.schema.properties ? '' : constraintText(type.schema, input);

  return `/** ${type.description} */\ntype ${type.name} = ${body};${notes ? `  // ${notes}` : ''}`;
}

// The names of the named types a schema refers to, in the order met. The
// types those use are the caller's to follow through the definitions.
export function referencedTypes(schema: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    schema.forEach(entry => referencedTypes(entry, found));

    return found;
  }

  if (!isSchema(schema)) {
    return found;
  }

  const ref = typeRefName(schema);

  if (ref) {
    found.add(ref);
  }

  for (const value of Object.values(schema)) {
    referencedTypes(value, found);
  }

  return found;
}
