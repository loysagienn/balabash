import { coordinator } from '../../agents/access.ts';
import { getLlmBackend } from '../harness/openai/backend.ts';
import type { CatalogOpeningContext, FunctionCall } from '../harness/turn-contract.ts';
import { createCatalogPort } from '../harness/catalog-port.ts';
import { getCoordinatorFunctionDefinitions, dispatchCoordinatorFunction } from './functions.ts';
import { buildCoordinatorInstructions, END_TURN_FUNCTION, turnContractOf } from './instructions.ts';

export async function coordinatorPort(workspaceId: string, threadId: string) {
  const backend = getLlmBackend().kind;
  const usesCatalog = backend === 'openai';
  const instructions = buildCoordinatorInstructions(turnContractOf(backend), usesCatalog);
  if (usesCatalog) {
    const port = await createCatalogPort(coordinator, workspaceId, threadId);
    return {
      instructions: instructions + '\n\n' + port.instructions,
      tools: [...port.tools, END_TURN_FUNCTION],
      grantKey: port.grantKey,
      dispatch: (call: FunctionCall, openings: CatalogOpeningContext) =>
        call.name === END_TURN_FUNCTION.name ? { kind: 'end' as const } : port.dispatch(call, openings),
    };
  }
  return {
    instructions,
    tools: await getCoordinatorFunctionDefinitions(workspaceId),
    grantKey: undefined,
    dispatch: (call: FunctionCall) => dispatchCoordinatorFunction(call, { workspaceId, threadId }),
  };
}
