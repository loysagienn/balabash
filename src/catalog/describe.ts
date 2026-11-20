// The action `describe`: the only thing that opens a vertex. A node gives its
// guide and one line per child; a capability gives its full description, its
// signature, the definitions of the named types the signature uses and the
// accounts of its node's connection. The value is the same for every port —
// what a port shows the model of it is the port's own view.

import { ACTIONS, type DescribeValue } from './actions.ts';
import type { CatalogCapability, CatalogNode, CatalogVertex } from './catalog.ts';
import { CapabilityError, toCapabilityError } from './errors.ts';
import {
  connectionNodeOf,
  grantedChildren,
  grantedGuide,
  grantedVertex,
  nearestNodeHint,
  type ConnectionsPort,
  type Grant,
} from './grant.ts';
import { parseActionInput } from './input.ts';
import { PRINTED_KEYWORDS, constraintText, signatureText, typeDefinitionText, typeText } from './signature.ts';
import type { JsonSchema } from './json.ts';
import type { AccountValue } from './types.ts';

export type DescribeEnv = {
  connections: ConnectionsPort;
};

async function accountsOf(grant: Grant, vertex: CatalogVertex, env: DescribeEnv): Promise<AccountValue[]> {
  const connection = connectionNodeOf(vertex)?.connection;

  return connection?.type === 'account' ? env.connections.accounts(grant.caller.workspaceId, connection.service) : [];
}

// Imported schemas can express constraints outside the authored catalog
// vocabulary (local refs, conditionals, open objects, tuple arrays). Show
// those schemas exactly when TypeScript notation would omit information.
function needsSchemaText(schema: JsonSchema): boolean {
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' || (!PRINTED_KEYWORDS.has(key) && !['title', '$schema'].includes(key))) return true;
    if (key === 'properties') {
      if (schema.additionalProperties !== false) return true;
      if (Object.values(value as object).some(child => typeof child === 'boolean' || needsSchemaText(child))) return true;
    }
    if (key === 'items' || key === 'additionalProperties') {
      if (key === 'items' && (typeof value === 'boolean' || Array.isArray(value))) return true;
      if (typeof value === 'object' && value && needsSchemaText(value as JsonSchema)) return true;
    }
    if (key === 'oneOf' || key === 'anyOf') {
      if (key === 'oneOf' || (value as JsonSchema[]).some(child => needsSchemaText(child) || constraintText(child, true))) return true;
    }
  }
  return false;
}

function serverTypeText(schema: JsonSchema, input = false): string {
  return needsSchemaText(schema) ? 'JSON Schema ' + JSON.stringify(schema) : typeText(schema, 0, input);
}

export function returnTypeText(capability: CatalogCapability): string {
  return capability.definition.serverSchemas?.output
    ? serverTypeText(capability.output)
    : typeText(capability.output, 0);
}

export function capabilitySignature(capability: CatalogCapability): string {
  if (capability.definition.serverSchemas) {
    return `${capability.fullName}(input: ${serverTypeText(capability.input, true)}): ${returnTypeText(capability)}`;
  }
  return signatureText({
    name: capability.fullName,
    description: capability.description,
    input: capability.input,
    output: capability.output,
    inputRules: capability.inputRules,
  });
}

export function capabilityTypeDefinitions(grant: Grant, capability: CatalogCapability): string[] {
  return capability.types.flatMap(name => {
    const type = grant.catalog.types.get(name);

    return type ? [typeDefinitionText(type)] : [];
  });
}

async function describeNode(grant: Grant, node: CatalogNode, env: DescribeEnv): Promise<DescribeValue> {
  return {
    kind: 'node',
    name: node.fullName,
    summary: node.summary,
    guide: grantedGuide(grant, node),
    accounts: await accountsOf(grant, node, env),
    children: grantedChildren(grant, node).map(child => ({
      kind: child.kind,
      name: child.fullName,
      summary: child.summary,
    })),
  };
}

async function describeCapability(
  grant: Grant,
  capability: CatalogCapability,
  env: DescribeEnv,
): Promise<DescribeValue> {
  return {
    kind: 'capability',
    name: capability.fullName,
    description: capability.description,
    signature: capabilitySignature(capability),
    types: capabilityTypeDefinitions(grant, capability),
    accounts: await accountsOf(grant, capability, env),
  };
}

// The outcome is the value or a CapabilityError, whatever failed on the way
// (the connections layer included).
export async function describe(grant: Grant, input: unknown, env: DescribeEnv): Promise<DescribeValue> {
  try {
    const { name = '' } = parseActionInput(grant, ACTIONS.describe, input) as { name?: string };
    const vertex = grantedVertex(grant, name);

    if (!vertex) {
      throw new CapabilityError('not_found', `You have no vertex \`${name}\`. ${nearestNodeHint(grant, name)}`);
    }

    return await (vertex.kind === 'node' ? describeNode(grant, vertex, env) : describeCapability(grant, vertex, env));
  } catch (error) {
    throw toCapabilityError(error);
  }
}
