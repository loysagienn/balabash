// The capability catalog: one tree of everything the platform does for an
// agent, one definition and one name per capability for every harness and
// for the journal.
//
// The module stands on its own: it imports nothing from the rest of the app.
//
// - definition.ts — what an author writes: a capability and a node;
// - types.ts — named types, declared once and named in signatures;
// - errors.ts — the one error channel and its closed set of kinds;
// - catalog.ts — the build: full names, schemas, the rules of the scheme;
// - signature.ts — the printer of signatures in TypeScript notation;
// - grant.ts — the catalog for one caller;
// - actions.ts, describe.ts, invoke.ts — the actions an agent works with the
//   tree by, and the one path of a call.

export {
  ACTIONS,
  ACTION_NAMES,
  isActionName,
  type ActionDefinition,
  type ActionName,
  type DescribeValue,
} from './actions.ts';
export {
  ACCOUNT_FIELD,
  CatalogBuildError,
  accountConnectionOf,
  buildCatalog,
  type Catalog,
  type CatalogAction,
  type CatalogCapability,
  type CatalogNode,
  type CatalogVertex,
} from './catalog.ts';
export {
  capability,
  node,
  type CallContext,
  type Caller,
  type Capability,
  type CapabilityDefinition,
  type Connection,
  type InputRule,
  type Node,
  type NodeDefinition,
  type Recipe,
  type RootDefinition,
  type Vertex,
} from './definition.ts';
export { capabilitySignature, capabilityTypeDefinitions, describe, type DescribeEnv } from './describe.ts';
export {
  CapabilityError,
  ERROR_KINDS,
  toCapabilityError,
  type CapabilityErrorValue,
  type ErrorKind,
} from './errors.ts';
export {
  computeGrant,
  connectionNodeOf,
  grantedChildren,
  grantedGuide,
  grantedVertex,
  nearestNode,
  type ConnectionsPort,
  type Grant,
  type GrantPolicy,
} from './grant.ts';
export { call, invokeCapability, type InvokeEnv } from './invoke.ts';
export type { JsonSchema } from './json.ts';
export { declarationText, signatureText, typeDefinitionText } from './signature.ts';
export {
  Account,
  CapabilityErrorType,
  FileId,
  FileRef,
  JsonObject,
  JsonValue,
  WorkspacePath,
  getNamedType,
  namedType,
  type AccountValue,
  type FileRefValue,
  type NamedType,
  type TypeUse,
} from './types.ts';
