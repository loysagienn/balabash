import type { CallAuthor } from '../core/contract.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import type { CallContext } from '../catalog/index.ts';

export function callAuthor({ caller, program }: Pick<CallContext, 'caller' | 'program'>): CallAuthor {
  if (program?.task) {
    return { actor: 'task', task: { slug: program.task, runId: program.runId } };
  }

  return { actor: 'agent', agentName: caller.agentName };
}

export function registryAuthor(ctx: CallContext): RegistryAuthor {
  const { workspaceId, threadId } = ctx.caller;
  return { kind: 'thread', workspaceId, threadId, task: callAuthor(ctx).task };
}
