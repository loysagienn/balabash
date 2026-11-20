import { getLlmBackend } from '../harness/openai/backend.ts';
import type { FunctionCall } from '../harness/turn-contract.ts';
import { createCatalogPort } from './catalog-port.ts';
import { getCoordinatorFunctionDefinitions, dispatchCoordinatorFunction } from './functions.ts';
import { COORDINATOR_INSTRUCTIONS } from './instructions.ts';

export async function coordinatorPort(workspaceId: string, threadId: string) {
  if (getLlmBackend().kind === 'openai') return createCatalogPort(workspaceId, threadId);
  return {
    instructions: COORDINATOR_INSTRUCTIONS,
    tools: await getCoordinatorFunctionDefinitions(workspaceId),
    grantKey: undefined,
    dispatch: (call: FunctionCall) => dispatchCoordinatorFunction(call, { workspaceId, threadId }),
  };
}
