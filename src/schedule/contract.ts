// Scheduled-task contract — TYPES ONLY, no runtime values (the same boundary
// rule as src/core/contract.ts): a task module in tasks/ imports this via
// `import type`, so after type erasure its file has no runtime imports from
// the bundle. Behaviour is injected through TaskContext at fire time.

import type { JsonObject, ToolsApi } from '../core/contract.ts';
import type { PrismaClient } from '../../prisma-generated/client.ts';

// The context a code task's run(ctx) receives. A task is not an agent: it has
// no thread, no dialogue and no trace of its own — the only memory it leaves
// is the events it pushes.
export type TaskContext = {
  // Journal a fact for the coordinator: always appended as a schedule.fired
  // event addressed to the workspace's main thread, with the task's slug and
  // name mixed into the payload — the task code does not choose the event
  // type or the addressee.
  pushEvent(payload: JsonObject): Promise<void>;
  // The app's database client (src/db/client.ts) — full access, the task is
  // trusted code shipped in the bundle.
  prisma: PrismaClient;
  // The workspace's tool surface: builtin pull tools plus every non-consent
  // tool server, resolved for the task's user. Calls are NOT journaled as
  // tool.call.* — a task has no thread to journal into.
  tools: ToolsApi;
};

export type TaskRun = (ctx: TaskContext) => Promise<void>;
