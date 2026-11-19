// The build of the catalog: the author's tree turned into the one registry
// everything reads — full names, schemas, the named types in use — and
// checked against the rules of the scheme. A broken rule stops the build
// (CatalogBuildError lists every problem at once); a text over its length
// budget or a field comment repeated verbatim is a warning.

import type { JsonSchema } from '../core/contract.ts';
import { ACTIONS, ACTION_NAMES, type ActionName } from './actions.ts';
import type { Capability, Connection, InputRule, Node, Recipe, RootDefinition, Vertex } from './definition.ts';
import { namedTypeSchema, toCatalogSchema, typeRefName } from './schema.ts';
import { referencedTypes, type Callable, type TypeDefinition } from './signature.ts';
import { getNamedType } from './types.ts';

// The field the platform adds to the input of every capability under a node
// with an account connection; the author neither writes nor receives it.
export const ACCOUNT_FIELD = {
  name: 'account',
  schema: { type: 'string', description: 'The account to act as.' } as JsonSchema,
};

export type CatalogNode = {
  kind: 'node';
  // The path from the root, segments joined by underscores; '' for the root.
  fullName: string;
  name: string;
  parent: CatalogNode | null;
  summary: string;
  guide: Recipe[];
  connection: Connection | null;
  external: boolean;
  children: CatalogVertex[];
};

export type CatalogCapability = {
  kind: 'capability';
  fullName: string;
  name: string;
  parent: CatalogNode;
  summary: string;
  description: string;
  // The whole input, the platform's account field included.
  input: JsonSchema;
  output: JsonSchema;
  inputRules: InputRule[];
  // Names of the named types the signature uses, with the types those use.
  types: string[];
  // The nearest node up the path that declares a connection.
  connectionNode: CatalogNode | null;
  external: boolean;
  definition: Capability;
};

export type CatalogVertex = CatalogNode | CatalogCapability;

export type CatalogAction = Callable & { name: ActionName; types: string[] };

export type Catalog = {
  root: CatalogNode;
  // Every vertex by its full name; the root is ''.
  vertices: ReadonlyMap<string, CatalogVertex>;
  types: ReadonlyMap<string, TypeDefinition>;
  actions: ReadonlyMap<ActionName, CatalogAction>;
};

export class CatalogBuildError extends Error {
  override name = 'CatalogBuildError';
  problems: string[];

  constructor(problems: string[]) {
    super(`The catalog breaks ${problems.length} rule(s):\n${problems.map(text => `- ${text}`).join('\n')}`);
    this.problems = problems;
  }
}

export const SEGMENT_PATTERN = /^[a-z][a-z0-9_]*$/;
const CAMEL_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const EXAMPLE_PATTERN = /\be\.g\.|\bfor example\b|\bExamples?\b/i;

// Length guides of the texts, in characters: strong recommendations, not
// limits.
const BUDGET = { summary: 90, description: 400, field: 140, recipe: 400, nodeSummary: 200 };

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function typeList(schema: JsonSchema): unknown[] {
  return Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
}

export function accountConnectionOf(capability: CatalogCapability): Connection | null {
  return capability.connectionNode?.connection?.type === 'account' ? capability.connectionNode.connection : null;
}

type SchemaSide = {
  input: boolean;
  // Field names stay as the external server calls them.
  external: boolean;
  // Every key of an object is always present.
  strict: boolean;
};

export function buildCatalog(root: RootDefinition): { catalog: Catalog; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const problem = (where: string, text: string) => problems.push(`${where || '(root)'}: ${text}`);
  const warning = (where: string, text: string) => warnings.push(`${where || '(root)'}: ${text}`);

  const vertices = new Map<string, CatalogVertex>();
  const actionNames = new Set<string>(ACTION_NAMES);

  // -------------------------------------------------------------------------
  // The tree: full names are the path joined by underscores

  const convert = (where: string, convertSchema: () => JsonSchema): JsonSchema => {
    try {
      return convertSchema();
    } catch (error) {
      problem(
        where,
        `the type does not convert to a schema: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {};
    }
  };

  const register = (vertex: CatalogVertex): void => {
    if (!SEGMENT_PATTERN.test(vertex.name)) {
      problem(vertex.fullName, `name "${vertex.name}" is not a snake_case segment`);
    }

    if (vertices.has(vertex.fullName)) {
      problem(vertex.fullName, 'two vertices share this full name');
    }

    if (actionNames.has(vertex.fullName)) {
      problem(vertex.fullName, 'the full name is taken by an action');
    }

    vertices.set(vertex.fullName, vertex);
  };

  const addCapability = (
    definition: Capability,
    parent: CatalogNode,
    connectionNode: CatalogNode | null,
  ): CatalogCapability => {
    const fullName = parent.fullName ? `${parent.fullName}_${definition.name}` : definition.name;
    const own = convert(`${fullName} input`, () => toCatalogSchema(definition.input, 'input').schema);
    const output = convert(`${fullName} output`, () => toCatalogSchema(definition.output, 'output').schema);
    const account = connectionNode?.connection?.type === 'account';
    const ownProperties = isSchema(own.properties) ? own.properties : {};

    if (account && ACCOUNT_FIELD.name in ownProperties) {
      problem(
        `${fullName} input.${ACCOUNT_FIELD.name}`,
        'the account field is added by the platform, not written in input',
      );
    }

    const input: JsonSchema = account
      ? {
          ...own,
          properties: { ...ownProperties, [ACCOUNT_FIELD.name]: ACCOUNT_FIELD.schema },
          required: [...(Array.isArray(own.required) ? own.required : []), ACCOUNT_FIELD.name],
        }
      : own;

    const vertex: CatalogCapability = {
      kind: 'capability',
      fullName,
      name: definition.name,
      parent,
      summary: definition.summary,
      description: definition.description,
      input,
      output,
      inputRules: definition.inputRules ?? [],
      types: [],
      connectionNode,
      external: parent.external,
      definition,
    };

    register(vertex);

    return vertex;
  };

  const addNode = (definition: Node, parent: CatalogNode, inherited: CatalogNode | null): CatalogNode => {
    const vertex: CatalogNode = {
      kind: 'node',
      fullName: parent.fullName ? `${parent.fullName}_${definition.name}` : definition.name,
      name: definition.name,
      parent,
      summary: definition.summary,
      guide: definition.guide ?? [],
      connection: definition.connection ?? null,
      external: parent.external || definition.external === true,
      children: [],
    };

    register(vertex);
    addChildren(vertex, definition.children, vertex.connection ? vertex : inherited);

    return vertex;
  };

  const addChildren = (parent: CatalogNode, children: Vertex[], connectionNode: CatalogNode | null): void => {
    for (const child of children) {
      parent.children.push(
        child.kind === 'node' ? addNode(child, parent, connectionNode) : addCapability(child, parent, connectionNode),
      );
    }
  };

  const rootNode: CatalogNode = {
    kind: 'node',
    fullName: '',
    name: '',
    parent: null,
    summary: root.summary,
    guide: root.guide ?? [],
    connection: null,
    external: false,
    children: [],
  };

  vertices.set('', rootNode);
  addChildren(rootNode, root.children, null);

  const capabilities = [...vertices.values()].filter(vertex => vertex.kind === 'capability');
  const nodes = [...vertices.values()].filter(vertex => vertex.kind === 'node');
  const topNodes = rootNode.children.filter(child => child.kind === 'node').map(child => child.fullName);
  const resolves = (name: string): boolean => (name !== '' && vertices.has(name)) || actionNames.has(name);

  // -------------------------------------------------------------------------
  // Texts: names must exist and stand in backticks, examples are banned

  // Names of vertices and actions written in backticks inside a text. A
  // token that only looks like a name of the tree (starts with a top-level
  // node) counts too, so that a name that does not exist is caught.
  const refsIn = (text: string | undefined): string[] => {
    const refs: string[] = [];

    for (const match of (text ?? '').matchAll(/`([^`]+)`/g)) {
      const token = match[1] ?? '';

      if (resolves(token)) {
        refs.push(token);
      } else if (SEGMENT_PATTERN.test(token) && topNodes.some(top => token.startsWith(`${top}_`))) {
        refs.push(token);
      }
    }

    return refs;
  };

  const nakedNames = [
    ...capabilities.map(capability => capability.fullName),
    ...ACTION_NAMES.filter(name => name.includes('_')),
  ];

  const checkText = (text: string | undefined, where: string): void => {
    if (!text) {
      return;
    }

    for (const ref of refsIn(text)) {
      if (!resolves(ref)) {
        problem(where, `names \`${ref}\`, which is not in the catalog`);
      }
    }

    const plain = text.replace(/`[^`]*`/g, ' ');

    for (const name of nakedNames) {
      if (new RegExp(`(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`).test(plain)) {
        problem(where, `names ${name} without backticks`);
      }
    }

    if (EXAMPLE_PATTERN.test(text)) {
      problem(where, 'the text carries an example ("e.g.", "for example", "Example")');
    }
  };

  const budget = (text: string | undefined, limit: number, where: string, what: string): void => {
    if (text && text.length > limit) {
      warning(where, `${what} is ${text.length} characters (budget ${limit})`);
    }
  };

  // -------------------------------------------------------------------------
  // Schemas

  const fieldComments = new Map<string, string[]>();
  const types = new Map<string, TypeDefinition>();

  const checkSchema = (schema: unknown, where: string, side: SchemaSide): void => {
    if (!isSchema(schema)) {
      problem(where, 'schema is not an object');

      return;
    }

    if (typeof schema.description === 'string') {
      checkText(schema.description, where);
      budget(schema.description, BUDGET.field, where, 'the field comment');

      if (schema.description.length >= 60) {
        fieldComments.set(schema.description, [...(fieldComments.get(schema.description) ?? []), where]);
      }
    }

    if (schema.$ref !== undefined) {
      const name = typeRefName(schema);
      const type = name ? getNamedType(name) : null;

      if (!type) {
        problem(where, `unknown type reference ${String(schema.$ref)}`);
      } else if (side.input && type.use === 'output') {
        problem(where, `the output type ${type.name} stands in an input`);
      } else if (!side.input && type.use === 'input') {
        problem(where, `the input type ${type.name} stands in an output`);
      }

      return;
    }

    const typesOfValue = typeList(schema);

    if (side.input && (typesOfValue.includes('null') || (Array.isArray(schema.enum) && schema.enum.includes(null)))) {
      problem(where, 'null in an input type (an optional field is left out instead)');
    }

    for (const key of ['anyOf', 'oneOf']) {
      const options = Array.isArray(schema[key]) ? (schema[key] as unknown[]) : [];

      for (const [index, option] of options.entries()) {
        if (side.input && isSchema(option) && option.type === 'null') {
          problem(where, 'null in an input type (an optional field is left out instead)');
        }

        checkSchema(option, `${where}<${key} ${index}>`, side);
      }
    }

    if (schema.properties !== undefined || typesOfValue.includes('object')) {
      const properties = isSchema(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

      if (schema.properties === undefined && schema.additionalProperties === undefined) {
        problem(where, 'an object without properties and without additionalProperties');
      }

      if (schema.properties !== undefined && schema.additionalProperties !== false) {
        problem(where, 'an object with properties must set additionalProperties: false (a strict object)');
      }

      const kind = properties.kind;

      if (
        isSchema(kind) &&
        where !== 'types.FileRef' &&
        (kind.const === 'file' || (Array.isArray(kind.enum) && kind.enum.includes('file')))
      ) {
        problem(`${where}.kind`, 'the pair kind: "file" is reserved for FileRef');
      }

      for (const [name, property] of Object.entries(properties)) {
        const at = `${where}.${name}`;

        if (!side.external && !CAMEL_PATTERN.test(name)) {
          problem(at, 'field name is not camelCase');
        }

        if (side.strict && !required.has(name)) {
          problem(at, 'an output key that is not always present (an optional field in an output)');
        }

        checkSchema(property, at, side);
      }

      if (isSchema(schema.additionalProperties)) {
        checkSchema(schema.additionalProperties, `${where}{}`, side);
      }
    }

    if (schema.items !== undefined) {
      checkSchema(schema.items, `${where}[]`, side);
    } else if (typesOfValue.includes('array')) {
      problem(where, 'an array without items');
    }
  };

  // The named types a signature uses, with the types those use; each is
  // defined and checked once, the first time it is met.
  const collectTypes = (schemas: JsonSchema[]): string[] => {
    const found: string[] = [];
    const queue = [...referencedTypes(schemas)];

    while (queue.length) {
      const name = queue.shift() as string;

      if (found.includes(name)) {
        continue;
      }

      const type = getNamedType(name);

      if (!type) {
        continue; // reported by checkSchema as an unknown reference
      }

      found.push(name);

      if (!types.has(name)) {
        const io = type.use === 'input' || type.use === 'any' ? 'input' : 'output';
        const schema = convert(`types.${name}`, () => namedTypeSchema(name, io).schema);

        types.set(name, { name, description: type.description, use: type.use, schema });

        if (!type.description) {
          problem(`types.${name}`, 'a type without a description');
        }

        checkText(type.description, `types.${name}`);

        if (type.use !== 'verbatim') {
          checkSchema(schema, `types.${name}`, {
            input: type.use === 'input',
            external: false,
            strict: type.use === 'output',
          });
        }
      }

      queue.push(...referencedTypes(types.get(name)?.schema));
    }

    return found;
  };

  // -------------------------------------------------------------------------
  // Capabilities and actions share the shape of a callable

  const checkCallable = (item: Callable, side: { external: boolean; isAction: boolean }): void => {
    const { name } = item;

    if (!item.description) {
      problem(name, 'no description');
    }

    checkText(item.description, `${name} description`);
    budget(item.description, BUDGET.description, name, 'the description');

    if (item.input.type !== 'object' || item.input.additionalProperties !== false) {
      problem(name, 'input must be a strict object');
    }

    checkSchema(item.input, `${name} input`, { input: true, external: side.external, strict: false });
    checkSchema(item.output, `${name} output`, { input: false, external: side.external, strict: true });

    const inputFields = isSchema(item.input.properties) ? item.input.properties : {};
    const inputRequired = new Set(Array.isArray(item.input.required) ? (item.input.required as string[]) : []);

    for (const rule of item.inputRules ?? []) {
      const [kind, fields] = Object.entries(rule)[0] ?? [];

      if (
        !kind ||
        !['exactlyOne', 'atLeastOne', 'atMostOne'].includes(kind) ||
        !Array.isArray(fields) ||
        fields.length < 2 ||
        Object.keys(rule).length !== 1
      ) {
        problem(name, 'an input rule that is not exactlyOne, atLeastOne or atMostOne over two or more fields');
        continue;
      }

      for (const field of fields) {
        if (!(field in inputFields)) {
          problem(name, `an input rule names "${field}", which is not an input field`);
        } else if (inputRequired.has(field)) {
          problem(name, `an input rule names "${field}", which is required`);
        } else if (isSchema(inputFields[field]) && (inputFields[field] as JsonSchema).default !== undefined) {
          problem(name, `an input rule names "${field}", which has a default and so is always set`);
        }
      }
    }

    // Lists page one way: limit and cursor in, nextCursor out.
    const outputFields = isSchema(item.output.properties) ? item.output.properties : {};
    const pages = ['cursor' in inputFields, 'limit' in inputFields, 'nextCursor' in outputFields];

    if (!side.isAction && (pages[0] || pages[2]) && !pages.every(Boolean)) {
      problem(name, 'a paged list takes limit and cursor and returns nextCursor — all three');
    }
  };

  const actions = new Map<ActionName, CatalogAction>();

  for (const name of ACTION_NAMES) {
    const definition = ACTIONS[name];
    const input = convert(`${name} input`, () => toCatalogSchema(definition.input, 'input').schema);
    const output = convert(`${name} output`, () => toCatalogSchema(definition.output, 'output').schema);
    const action: CatalogAction = { name, description: definition.description, input, output, types: [] };

    checkCallable(action, { external: false, isAction: true });
    action.types = collectTypes([input, output]);
    actions.set(name, action);
  }

  // The error of a failed call belongs to every signature without standing
  // in one.
  collectTypes([{ $ref: '#/types/CapabilityError' }]);

  for (const capability of capabilities) {
    const { fullName } = capability;

    if (!capability.summary) {
      problem(fullName, 'no summary');
    }

    if (/\.\s+\S/.test(capability.summary)) {
      problem(fullName, 'the summary is more than one sentence');
    }

    if (/\.$/.test(capability.summary)) {
      problem(fullName, 'the summary ends with a period');
    }

    checkText(capability.summary, `${fullName} summary`);
    budget(capability.summary, BUDGET.summary, fullName, 'the summary');

    checkCallable(
      {
        name: fullName,
        description: capability.description,
        input: capability.input,
        output: capability.output,
        inputRules: capability.inputRules,
      },
      { external: capability.external, isAction: false },
    );

    capability.types = collectTypes([capability.input, capability.output]);
  }

  for (const node of nodes) {
    const { fullName } = node;

    if (!node.summary) {
      problem(fullName, 'a node without a summary');
    }

    if (refsIn(node.summary).length) {
      problem(fullName, 'a node summary names capabilities');
    }

    checkText(node.summary, `${fullName} summary`);
    budget(node.summary, BUDGET.nodeSummary, fullName, 'the node summary');

    // What a recipe may name without declaring it: the capabilities that are
    // direct children of its node. The root has none: its capabilities are
    // granted one by one.
    const implied = new Set(
      fullName === '' ? [] : node.children.filter(child => child.kind === 'capability').map(child => child.fullName),
    );

    for (const [index, recipe] of node.guide.entries()) {
      const at = `${fullName || '(root)'} guide[${index}]`;
      const requires = new Set(recipe.requires ?? []);

      if (!recipe.text) {
        problem(at, 'a recipe without a text');
      }

      checkText(recipe.text, at);
      budget(recipe.text, BUDGET.recipe, at, 'the recipe');

      for (const required of requires) {
        if (!resolves(required)) {
          problem(at, `requires "${required}", which is not in the catalog`);
        }

        if (implied.has(required)) {
          problem(at, `requires "${required}", which is a capability of this node and is implied`);
        }
      }

      for (const ref of refsIn(recipe.text)) {
        if (resolves(ref) && !implied.has(ref) && !requires.has(ref) && vertices.get(ref)?.kind !== 'node') {
          problem(at, `names \`${ref}\` from outside the node without listing it in requires`);
        }
      }
    }

    if (node.connection) {
      if (!['account', 'secret'].includes(node.connection.type)) {
        problem(fullName, `unknown connection type "${String(node.connection.type)}"`);
      }

      if (!node.connection.service || !node.connection.summary) {
        problem(fullName, 'a connection names its service and carries a summary');
      }

      checkText(node.connection.summary, `${fullName} connection`);
      checkText(node.connection.setup, `${fullName} connection`);
    }
  }

  for (const [text, places] of fieldComments) {
    if (places.length >= 3) {
      warning(places[0] ?? '', `a field comment repeated verbatim in ${places.length} places: "${text.slice(0, 60)}…"`);
    }
  }

  if (problems.length) {
    throw new CatalogBuildError(problems);
  }

  return { catalog: { root: rootNode, vertices, types, actions }, warnings };
}
