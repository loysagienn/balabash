// The words of an action row (ui/Xp) and its details, from the tool name
// and its input/result as the log recorded them: a native tool of the SDK
// session (session.tool.*), a bridge function (tool.call.*), a Codex
// command or file change. Pure, tested without the DOM.

import type { JsonObject, JsonValue } from '../../../core/contract.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';

export type ActionLabel = {
  icon: IconName;
  // A tool row: the name in mono and its argument…
  tool?: string;
  arg?: string;
  // …or a sentence: "Read 6 files in" + "src/api/apps".
  text?: string;
  textArg?: string;
};

// What an expanded row shows.
export type ActionDetail =
  // A command and what it printed (Bash, Shell).
  | { kind: 'terminal'; command: string; output: string }
  // A file change as a unified diff (Edit, Write, MultiEdit, FileChange).
  | { kind: 'diff'; diff: string }
  // Markdown text (thinking).
  | { kind: 'md'; text: string }
  // The input and the result of any other tool, as text.
  | { kind: 'io'; input: string; output: string | null };

const ARG_MAX = 120;

export function clipLine(text: string, max = ARG_MAX): string {
  const line = text.trim().split('\n')[0] ?? '';

  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// The tail of a path — enough to tell the file ("…/thread/ThreadScreen.tsx").
export function shortPath(path: string, parts = 3): string {
  const segments = path.split('/').filter(Boolean);

  return segments.length > parts ? `…/${segments.slice(-parts).join('/')}` : segments.join('/') || path;
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function firstString(input: JsonObject): string | null {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

// The text form of a tool result: a string as is, content blocks joined
// (an omitted image is named, not shown), anything else as JSON.
export function resultText(result: JsonValue | undefined): string {
  if (result === undefined || result === null) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    return result
      .map(block => {
        if (block && typeof block === 'object' && !Array.isArray(block)) {
          if (typeof block.text === 'string') {
            return block.text;
          }
          if (block.omitted === true) {
            return `[${typeof block.type === 'string' ? block.type : 'binary'} omitted${typeof block.mediaType === 'string' ? ` · ${block.mediaType}` : ''}]`;
          }
        }

        return JSON.stringify(block, null, 2);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// A unified-diff body for the Markdown renderer's diff grammar.
function diffOf(path: string, removed: string, added: string): string {
  const lines = [`--- ${path}`, `+++ ${path}`];

  for (const line of removed === '' ? [] : removed.split('\n')) {
    lines.push(`-${line}`);
  }
  for (const line of added === '' ? [] : added.split('\n')) {
    lines.push(`+${line}`);
  }

  return lines.join('\n');
}

export type NativeAction = { label: ActionLabel; detail: ActionDetail | null; add?: number; del?: number };

// A native tool of the session journal (Claude: Bash, Read, Edit, …;
// Codex: Shell, FileChange, WebSearch, mcp__<server>__<tool>).
export function nativeAction(name: string, input: JsonObject, result?: JsonValue): NativeAction {
  const output = result === undefined ? null : resultText(result);
  const command = str(input.command);
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);

  if ((name === 'Bash' || name === 'Shell') && command) {
    return { label: { icon: 'square-terminal', tool: name, arg: clipLine(command) }, detail: { kind: 'terminal', command, output: output ?? '' } };
  }

  if (name === 'Edit' && path) {
    const removed = typeof input.old_string === 'string' ? input.old_string : '';
    const added = typeof input.new_string === 'string' ? input.new_string : '';

    return {
      label: { icon: 'file-pen-line', tool: name, arg: shortPath(path) },
      detail: { kind: 'diff', diff: diffOf(shortPath(path), removed, added) },
      add: lineCount(added),
      del: lineCount(removed),
    };
  }

  if (name === 'MultiEdit' && path && Array.isArray(input.edits)) {
    let add = 0;
    let del = 0;
    const chunks: string[] = [];

    for (const edit of input.edits) {
      if (edit && typeof edit === 'object' && !Array.isArray(edit)) {
        const removed = typeof edit.old_string === 'string' ? edit.old_string : '';
        const added = typeof edit.new_string === 'string' ? edit.new_string : '';

        add += lineCount(added);
        del += lineCount(removed);
        chunks.push(diffOf(shortPath(path), removed, added));
      }
    }

    return { label: { icon: 'file-pen-line', tool: 'Edit', arg: shortPath(path) }, detail: { kind: 'diff', diff: chunks.join('\n') }, add, del };
  }

  if (name === 'Write' && path) {
    const content = typeof input.content === 'string' ? input.content : '';

    return { label: { icon: 'file-pen-line', tool: name, arg: shortPath(path) }, detail: { kind: 'diff', diff: diffOf(shortPath(path), '', content) }, add: lineCount(content) };
  }

  if (name === 'FileChange' && Array.isArray(input.changes)) {
    const paths = input.changes
      .map(change => (change && typeof change === 'object' && !Array.isArray(change) && typeof change.path === 'string' ? change.path : null))
      .filter((file): file is string => file !== null);
    const arg = paths.length === 0 ? 'files' : paths.length === 1 ? shortPath(paths[0]!) : `${shortPath(paths[0]!)} +${paths.length - 1}`;

    return { label: { icon: 'file-pen-line', tool: 'Edit', arg }, detail: { kind: 'io', input: paths.join('\n'), output } };
  }

  if ((name === 'Read' || name === 'NotebookEdit') && path) {
    return { label: { icon: 'file-text', tool: name, arg: shortPath(path) }, detail: { kind: 'io', input: path, output } };
  }

  if (name === 'Grep' || name === 'Glob') {
    const pattern = str(input.pattern) ?? firstString(input) ?? '';
    const where = str(input.path);

    return { label: { icon: 'search', tool: name, arg: clipLine(where ? `${pattern} in ${shortPath(where)}` : pattern) }, detail: { kind: 'io', input: JSON.stringify(input, null, 2), output } };
  }

  if (name === 'WebFetch' || name === 'WebSearch') {
    const target = str(input.url) ?? str(input.query) ?? firstString(input) ?? '';

    return { label: { icon: name === 'WebSearch' ? 'search' : 'globe', tool: name, arg: clipLine(target.replace(/^https?:\/\//, '')) }, detail: { kind: 'io', input: JSON.stringify(input, null, 2), output } };
  }

  if (name === 'Agent' || name === 'Task') {
    const what = str(input.description) ?? str(input.prompt) ?? '';

    return { label: { icon: 'bot', tool: 'Agent', arg: clipLine(what) }, detail: { kind: 'io', input: typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input, null, 2), output } };
  }

  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);

  if (mcp) {
    return { label: { icon: 'plug', tool: mcp[2]!, arg: clipLine(firstString(input) ?? mcp[1]!) }, detail: { kind: 'io', input: JSON.stringify(input, null, 2), output } };
  }

  const arg = firstString(input);

  return { label: { icon: 'wrench', tool: name, ...(arg ? { arg: clipLine(arg) } : {}) }, detail: { kind: 'io', input: JSON.stringify(input, null, 2), output } };
}

const BRIDGE_ICONS: Record<string, IconName> = {
  spawn_agent: 'bot',
  send_to_thread: 'message-square-reply',
  cancel_thread: 'circle-stop',
  end_thread: 'check',
  request_restart: 'refresh-cw',
  get_event: 'file-text',
  get_thread: 'file-text',
  get_thread_events: 'file-text',
  list_threads: 'messages-square',
  data_query: 'database',
  http_get: 'globe',
  create_task: 'calendar-clock',
  run_task: 'play',
  list_tasks: 'calendar-clock',
  cancel_task: 'calendar-clock',
  send_file: 'paperclip',
  workspace_export_file: 'upload',
  workspace_import_file: 'download',
};

// A function of the Balabash bridge (tool.call.*): the function by name,
// the first string of its input as the argument.
export function bridgeAction(functionName: string, input: JsonObject): { label: ActionLabel; input: string } {
  const arg = firstString(input) ?? (Object.keys(input).length > 0 ? Object.values(input).map(v => String(v)).join(', ') : '');
  const icon = BRIDGE_ICONS[functionName] ?? (functionName.startsWith('gmail_') ? 'inbox' : functionName.startsWith('notion') ? 'file-text' : functionName.startsWith('perplexity') ? 'search' : 'wrench');

  return { label: { icon, tool: functionName, ...(arg ? { arg: clipLine(arg) } : {}) }, input: JSON.stringify(input, null, 2) };
}

// Tools whose rows the feed does not draw: the plan card stands for them.
export function isPlanTool(name: string): boolean {
  return name === 'TodoWrite';
}

// "0.1s", "4.2s", "38s", "1:12", "1:02:05".
export function actionDuration(ms: number): string {
  const total = Math.max(0, ms);

  if (total < 10_000) {
    return `${(total / 1000).toFixed(1)}s`;
  }
  if (total < 60_000) {
    return `${Math.round(total / 1000)}s`;
  }

  const seconds = Math.floor(total / 1000);
  const minutes = Math.floor(seconds / 60) % 60;
  const hours = Math.floor(seconds / 3600);
  const rest = String(seconds % 60).padStart(2, '0');

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
