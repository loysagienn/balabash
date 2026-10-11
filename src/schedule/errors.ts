// A refusal of a schedule command — one class for the registry's doors
// (src/schedule/commands.ts, input.ts): the api maps the code to a status
// (src/api/api.ts), the tool server words it as its reply. bad_request —
// the input itself; conflict — the slug is taken; not_found — no such task
// in this workspace (a foreign one answers the same); replaced — the slug
// now belongs to another row than the command named; sleeping — a code
// task without a body; no_main_thread — a workspace with no thread to fire
// into.

export type ScheduleErrorCode = 'bad_request' | 'conflict' | 'not_found' | 'replaced' | 'sleeping' | 'no_main_thread';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}
