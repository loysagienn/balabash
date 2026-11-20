import type { RegistryAuthor } from '../core/registry-events.ts';
import type { CallContext } from '../catalog/index.ts';

export function callAuthor({ caller, program }: CallContext) {
  if (program?.task) {
    return { actor: 'task' as const, task: { slug: program.task, runId: program.runId } };
  }

  return { actor: 'agent' as const, agentName: caller.agentName };
}

export function registryAuthor(ctx: CallContext): RegistryAuthor {
  const { workspaceId, threadId } = ctx.caller;
  return { kind: 'thread', workspaceId, threadId, task: callAuthor(ctx).task };
}
