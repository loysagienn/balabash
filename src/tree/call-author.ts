import type { TaskAuthor } from '../core/contract.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import type { CallContext } from '../catalog/index.ts';

type CallAuthor =
  | { actor: 'task'; task: TaskAuthor; agentName?: never }
  | { actor: 'agent'; agentName: string; task?: never };

export function callAuthor({ caller, program }: CallContext): CallAuthor {
  if (program?.task) {
    return { actor: 'task', task: { slug: program.task, runId: program.runId } };
  }

  return { actor: 'agent', agentName: caller.agentName };
}

export function registryAuthor(ctx: CallContext): RegistryAuthor {
  const { workspaceId, threadId } = ctx.caller;
  return { kind: 'thread', workspaceId, threadId, task: callAuthor(ctx).task };
}
