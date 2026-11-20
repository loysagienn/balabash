// A catalog call stores its JSON value or CapabilityError. Provider-specific
// additions (schemas, file content and previews) live only in the model view.
import { randomUUID } from 'node:crypto';
import type {
  Caller,
  ConnectionsPort,
  DescribeValue,
  Grant,
  CapabilityErrorValue,
  JsonObject,
  JsonValue,
  ProgramRun,
  ProgramScope,
} from '../catalog/index.ts';
import { CapabilityError, describe, invokeCapability, runProgram, toCapabilityError } from '../catalog/index.ts';
import { appendEvent } from '../core/append.ts';
import { callAuthor } from './call-author.ts';

type Call = {
  caller: Caller;
  callId: string;
  name: string;
  input: JsonValue;
  program?: ProgramScope;
};

async function journalCall<T extends JsonValue>(
  call: Call,
  invoke: () => Promise<T>,
  runDetails?: () => JsonObject,
): Promise<{ value: T; seq: bigint } | { error: CapabilityErrorValue; seq: bigint }> {
  const { caller, program } = call;
  const event = {
    workspaceId: caller.workspaceId,
    threadId: caller.threadId,
    ...callAuthor({ caller, program: program ?? null }),
  };
  const ids = { callId: call.callId, functionName: call.name, ...(program ? { runId: program.runId } : {}) };
  await appendEvent({ ...event, type: 'tool.call.started', payload: { ...ids, input: call.input } });

  let value: T;
  try {
    value = await invoke();
  } catch (error) {
    const failure = toCapabilityError(error).toValue();
    const result = await appendEvent({
      ...event,
      type: 'tool.call.failed',
      payload: { ...ids, error: failure, ...runDetails?.() },
    });
    if (!result.written) throw new Error('The log did not record the failure of ' + call.name);
    return { error: failure, seq: result.event.seq };
  }

  const result = await appendEvent({
    ...event,
    type: 'tool.call.completed',
    payload: { ...ids, value, ...runDetails?.() },
  });
  if (!result.written) throw new Error('The log did not record the result of ' + call.name);
  return { value, seq: result.event.seq };
}

// Code and outcome already live in the input and result of run_program.
function runDetails(run: ProgramRun): JsonObject {
  return {
    run: {
      id: run.id,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt.toISOString(),
      durationMs: run.durationMs,
      outcome: run.outcome,
      console: run.console,
      consoleTruncated: run.consoleTruncated,
    },
  };
}

export async function journalProgramCall(
  caller: Caller,
  program: ProgramScope,
  name: string,
  input: JsonValue,
  invoke: () => Promise<JsonValue>,
): Promise<JsonValue> {
  const result = await journalCall({ caller, program, callId: randomUUID(), name, input }, invoke);
  if ('error' in result) {
    const { kind, message, details } = result.error;
    throw new CapabilityError(kind, message, details);
  }
  return result.value;
}

// The entry point for direct catalog calls from a port. The port supplies
// decoded arguments; the catalog validates them, including a malformed
// argument string passed through verbatim by a wire adapter.
export async function dispatchCatalogCall(
  grant: Grant,
  connections: ConnectionsPort,
  call: Pick<Call, 'callId' | 'name' | 'input'>,
) {
  const { name, input, callId } = call;
  let opened: DescribeValue | undefined;
  let run: JsonObject = {};
  const result = await journalCall({ ...call, caller: grant.caller }, async () => {
    if (name === 'describe') {
      opened = await describe(grant, input, { connections });
      return opened;
    }
    if (name === 'run_program') {
      return runProgram(grant, input, {
        connections,
        start: { id: callId, startedAt: new Date() },
        traceCall: journalProgramCall,
        record: outcome => { run = runDetails(outcome); },
      });
    }
    return invokeCapability(grant, name, input, { connections });
  }, () => run);

  return { ...result, opened };
}
