import { coordinator } from '../../agents/access.ts';
import { getLlmBackend } from '../harness/openai/backend.ts';
import type { CatalogOpeningContext, FunctionCall } from '../harness/turn-contract.ts';
import { createCatalogPort } from '../harness/catalog-port.ts';
import { buildCoordinatorInstructions, END_TURN_FUNCTION, turnContractOf } from './instructions.ts';

export async function coordinatorPort(workspaceId: string, threadId: string) {
  const backend = getLlmBackend().kind;
  const instructions = buildCoordinatorInstructions(turnContractOf(backend));
  const port = await createCatalogPort(coordinator, workspaceId, threadId, backend === 'openai-compatible' ? 'signature' : 'function');
  const head = { instructions: instructions + '\n\n' + port.instructions, tools: port.tools };
  if (backend === 'anthropic') {
    return {
      head: { ...head, deferredTools: port.capabilityDefinitions() },
      grantKey: port.grantKey,
      dispatch: port.dispatch,
    };
  }
  return {
    head: { ...head, tools: [...port.tools, END_TURN_FUNCTION] },
    grantKey: port.grantKey,
    dispatch: (call: FunctionCall, openings: CatalogOpeningContext) =>
      call.name === END_TURN_FUNCTION.name ? { kind: 'end' as const } : port.dispatch(call, openings),
  };
}
