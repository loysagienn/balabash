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
//   tree by, and the one path of a call;
// - program.ts — the runner of programs and the action `run_program`;
//   program-process.ts — the process one run lives in.

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
  connectionOf,
  type Catalog,
  type CatalogAction,
  type CatalogCapability,
  type CatalogNode,
  type CatalogVertex,
} from './catalog.ts';
export {
  capability,
  node,
  type AccountAuthority,
  type AccountConnection,
  type Authority,
  type CallContext,
  type Caller,
  type Capability,
  type CapabilityDefinition,
  type Connection,
  type IdentityProbe,
  type OAuthSettings,
  type SecretAuthority,
  type SecretConnection,
  type InputRule,
  type Node,
  type NodeDefinition,
  type ProgramScope,
  type Recipe,
  type RootDefinition,
  type Vertex,
} from './definition.ts';
export { returnTypeText, capabilitySignature, capabilityTypeDefinitions, describe, type DescribeEnv } from './describe.ts';
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
export { accountAuthority, parseCallTarget, invokeCapability, secretAuthority, type InvokeEnv } from './invoke.ts';
export type { JsonSchema } from './json.ts';
export {
  consoleTail,
  countProgramCalls,
  countRunningPrograms,
  executeProgram,
  killRunningPrograms,
  programSyntaxProblem,
  runProgram,
  type ProgramEnv,
  type ProgramLaunch,
  type ProgramOutcome,
  type ProgramRun,
  type ProgramStart,
  type RunProgramEnv,
} from './program.ts';
export { expandSchema } from './schema.ts';
export { declarationText, ruleText, typeText, signatureText, typeDefinitionText } from './signature.ts';
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
