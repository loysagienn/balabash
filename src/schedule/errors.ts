// A refusal of a schedule command — one class for the registry's doors
// (src/schedule/commands.ts, input.ts): the api maps the code to a status
// (src/api/api.ts), the catalog returns a capability error. bad_request —
// the input itself; conflict — the slug is taken; not_found — no such task
// in this workspace (a foreign one answers the same); replaced — the slug
// now belongs to another row than the command named; no_main_thread — a workspace with no thread to fire
// into.

export type ScheduleErrorCode = 'bad_request' | 'conflict' | 'not_found' | 'replaced' | 'no_main_thread';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}
