// Scheduled-task contract — TYPES ONLY, no runtime values (the same boundary
// rule as src/core/contract.ts): a workspace task file imports this via
// `import type`, so after type erasure it has no runtime imports from the
// repository tree. Behaviour is injected through TaskContext at fire time.
// The regulations of task bodies: src/schedule/AGENTS.md.

import type { JsonObject, ToolsApi } from '../core/contract.ts';
import type { PrismaClient } from '../../prisma-generated/client.ts';

// The context a code task's run(ctx) receives. A task is not an agent: it has
// no thread, no dialogue and no trace of its own — the only memory it leaves
// is the events it pushes.
export type TaskContext = {
  // The workspace the task belongs to (its workspace id): what a body filters its
  // own past events by — the event log is shared by every workspace.
  workspaceId: string;
  // Journal a fact for the coordinator: always appended as a schedule.fired
  // event addressed to the workspace's main thread, with the task's slug and
  // name mixed into the payload — the task code does not choose the event
  // type or the addressee.
  pushEvent(payload: JsonObject): Promise<void>;
  // The app's database client (src/db/client.ts) — full access, the task is
  // trusted code of the installation.
  prisma: PrismaClient;
  // The workspace's tool surface: the task bundle's tool servers (see
  // taskBundle in engine.ts), resolved for the task's workspace. Calls are NOT
  // journaled as tool.call.* — a task has no thread to journal into.
  tools: ToolsApi;
};

export type TaskRun = (ctx: TaskContext) => Promise<void>;
