import { coordinator } from '../../agents/access.ts';
import { getLlmBackend } from '../harness/openai/backend.ts';
import type { CatalogOpeningContext, FunctionCall } from '../harness/turn-contract.ts';
import { createCatalogPort } from '../harness/catalog-port.ts';
import { buildCoordinatorInstructions, END_TURN_FUNCTION, turnContractOf } from './instructions.ts';

// On the signature port every capability goes through `call`, and a model
// reaches for the end of its turn the same way: call({name: "do_nothing"}).
// The catalog has no such capability, and its answer ("You have no
// capability `do_nothing`") talks the model out of the function it does
// have — the turn then runs into the iteration cap. The intent is
// unambiguous and the function takes no input, so such a call ends the turn
// like the function itself, whatever its `input` is.
function endsTurnThroughCall(call: FunctionCall): boolean {
  if (call.name !== 'call') return false;
  try {
    const target: unknown = JSON.parse(call.arguments);
    return typeof target === 'object' && target !== null && 'name' in target && target.name === END_TURN_FUNCTION.name;
  } catch {
    return false;
  }
}

export async function coordinatorPort(workspaceId: string, threadId: string) {
  const backend = getLlmBackend().kind;
  const instructions = buildCoordinatorInstructions(turnContractOf(backend));
  const port = await createCatalogPort(coordinator, workspaceId, threadId, backend === 'openai-compatible' ? 'signature' : 'function');
  const head = { instructions: instructions + '\n\n' + port.instructions, tools: port.tools };
  if (backend === 'anthropic') {
    return {
      head: { ...head, deferredTools: port.capabilityDefinitions() },
      grantKey: port.grantKey,
      sampleOpenings: port.sampleOpenings,
      dispatch: port.dispatch,
    };
  }
  // Only the signature port has `call` among its functions.
  const throughCall = backend === 'openai-compatible';
  return {
    head: { ...head, tools: [...port.tools, END_TURN_FUNCTION] },
    sampleOpenings: port.sampleOpenings,
    grantKey: port.grantKey,
    dispatch: (call: FunctionCall, openings: CatalogOpeningContext) =>
      call.name === END_TURN_FUNCTION.name || (throughCall && endsTurnThroughCall(call))
        ? { kind: 'end' as const }
        : port.dispatch(call, openings),
  };
}
