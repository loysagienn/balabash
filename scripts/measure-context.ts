// The context measure: what the model of an agent's session actually received
// in its first request — our prompt and what the SDK's CLI added around it:
// the CLI prefix, the dynamic block (environment, deferred tool names, agent
// types, skill listing, mode reminders), the system reminders folded into the
// first user message (project instructions, session context, attribution),
// the native tool definitions — each with its size and an estimate of its
// tokens — plus the request's real token usage. Where render-context shows
// the instruction layer Balabash composes, this shows the whole request the
// session's transcript recorded, so the two together say what is ours and
// what is the CLI's. The instrument of the work on the agents' context
// composition: measure before and after a change and diff the output.
//
// Sources: Claude — the CLI's transcript (`<claude config dir>/projects/
// <encoded cwd>/<sessionId>.jsonl`): `attachment` records (one per element
// of the dynamic block and of the reminders), `api-request-shape` (the system
// blocks and the tool definitions as sent; CLI ≥ 2.1.3xx), `prompt_snapshot`
// attachments (the same for older CLIs), `api-request-blob` (the messages)
// and the first `assistant` record (the usage). Codex — the rollout
// (`CODEX_HOME/sessions/<y>/<m>/<d>/rollout-<stamp>-<id>.jsonl`):
// `session_meta`, `turn_context`, the developer and user items of the first
// turn, the first `token_count`; the Codex binary's own system prompt and tool
// definitions are not written to the rollout, so for Codex only their total
// (the first request's input tokens minus the known texts) is measurable.
//
// Usage: npm run build && npm run measure-context [-- --session <id>] [-- --out <dir>]
//   Default: the newest session of every repository agent found in the CLI
//   stores of this installation — Claude project directories derived from
//   the agents' cwds (`data/workspace/*/files`, `data/agent-state/*`, the
//   repository root) and the Codex rollouts of `data/codex-home`. A session is
//   attributed to an agent by the journal (session.sdk events of its thread)
//   when it knows it, otherwise by the system prompt's head against the
//   catalog's instructions, otherwise by its agent-state directory.
//   --session <id>: that one session (Claude transcript or Codex rollout).
//   Output: <out>/<agent>.md per session (or <agent>-<id>.md with --session)
//   and <out>/summary.md; default out: data/context-measure/ (overwritten).
//
// Read-only: it reads transcripts and the journal and writes the reports.

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { AgentDeclaration } from '../src/core/contract.ts';
import { prisma } from '../src/db/client.ts';
import { getAgents, isRemoteAgent, loadAgents } from '../src/capabilities/agent-catalog.ts';
import { claudeProjectDirName, claudeProjectsDir } from '../src/harness/claude-sdk/session-store.ts';
import { codexHomeDir } from '../src/harness/codex-sdk/codex-home.ts';
import { listCodexRollouts } from '../src/harness/codex-sdk/session-store.ts';

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1]?.trim() : undefined;
const outDir = path.resolve(args.includes('--out') ? (args[args.indexOf('--out') + 1] ?? '') : path.join('data', 'context-measure'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_LIMIT = 600; // records: the first request of a session is in the first few dozen

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const head = (text: string, n = 90): string => text.replace(/\s+/g, ' ').trim().slice(0, n);
const chars = (value: unknown): number => (typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length);
const fmt = (n: number): string => n.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// The agent catalog: the repository's own session agents, with the head of
// each instructions text to recognize a session's prompt by.

loadAgents();

const sessionAgents = getAgents().filter((agent): agent is AgentDeclaration => !isRemoteAgent(agent) && Boolean(agent.session));
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

function agentByPrompt(prompt: string, sdk: 'claude' | 'codex'): AgentDeclaration | null {
  const text = normalize(prompt);
  // Among the agents of this SDK (a role brief is shared across backends —
  // manager and codex), the longest matching head wins.
  let best: { agent: AgentDeclaration; length: number } | null = null;

  for (const agent of sessionAgents.filter(agent => agent.sdk === sdk)) {
    const instructions = normalize(agent.session!.instructions);
    const probe = instructions.slice(0, Math.min(instructions.length, 160));

    if (probe.length >= 40 && text.startsWith(probe) && (!best || probe.length > best.length)) {
      best = { agent, length: probe.length };
    }
  }

  return best?.agent ?? null;
}

// The journal's attribution: session id → agent and thread, where the thread
// journaled its session (session.sdk).
async function journalAttribution(): Promise<Map<string, { agent: string; threadId: string }>> {
  try {
    const rows = await prisma.$queryRaw<{ id: string; agent: string; thread_id: string }[]>`
      SELECT DISTINCT s.payload->>'sdkSessionId' AS id, t.agent, t.id AS thread_id
      FROM events s JOIN threads t ON t.id = s.thread_id
      WHERE s.type = 'session.sdk'`;

    return new Map(rows.map(row => [row.id.toLowerCase(), { agent: row.agent, threadId: row.thread_id }]));
  } catch (error) {
    console.error(`[measure-context] journal unavailable, attributing by content only: ${error instanceof Error ? error.message : String(error)}`);

    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Reading a JSONL file up to a limit of records.

async function readRecords(file: string, limit: number, stop?: (record: Json, index: number) => boolean): Promise<Json[]> {
  const records: Json[] = [];
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let record: unknown;

    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (isObject(record)) {
      records.push(record);

      if (records.length >= limit || stop?.(record, records.length)) {
        break;
      }
    }
  }

  rl.close();

  return records;
}

// ---------------------------------------------------------------------------
// Claude: the first request of a transcript.

type Element = { kind: string; role: string; chars: number; head: string; detail?: string[] };
type ToolDef = { name: string; chars: number; flags: string };
type Usage = { input: number; cacheWrite: number; cacheRead: number; total: number };

type ClaudeMeasure = {
  sdk: 'claude';
  sessionId: string;
  file: string;
  mtime: Date;
  version: string;
  cwd: string;
  model: string;
  effort: string;
  timestamp: string;
  source: string; // where the system blocks and tools came from
  system: { label: string; chars: number; head: string; detail?: string[] }[];
  dynamic: Element[]; // attachments rendered with the system role
  reminders: Element[]; // attachments rendered into the first user message
  prompt: { text: string; chars: number };
  tools: ToolDef[];
  deferred: string[];
  skills: { name: string; chars: number; origin: string }[];
  agentTypes: string[];
  messages: { role: string; blocks: string[]; chars: number }[];
  request: { betas: number; maxTokens: number; cacheBreakpoints: string[] };
  usage: Usage | null;
  totalChars: number;
};

const repoSkills = new Set<string>();
const pluginSkills = new Set<string>();

async function loadSkillOrigins(): Promise<void> {
  const list = async (dir: string, into: Set<string>, prefix = '') => {
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          into.add(prefix + entry.name);
        }
      }
    } catch {
      /* no such directory */
    }
  };

  await list(path.resolve('.claude', 'skills'), repoSkills);
  await list(path.resolve('plugins', 'balabash', 'skills'), pluginSkills, 'balabash:');
}

function skillOrigin(name: string): string {
  if (pluginSkills.has(name)) {
    return 'plugins/balabash';
  }

  if (repoSkills.has(name)) {
    return '.claude/skills (repository)';
  }

  return name.includes(':') ? 'plugin' : 'CLI bundled';
}

function renderedChars(record: Json): number {
  const rendered = Array.isArray(record.rendered) ? record.rendered : [];

  return rendered.reduce<number>((sum, item) => sum + (isObject(item) ? str(item.content).length : 0), 0);
}

function renderedText(record: Json): string {
  const rendered = Array.isArray(record.rendered) ? record.rendered : [];

  return rendered.map(item => (isObject(item) ? str(item.content) : '')).join('\n');
}

function usageOf(message: Json): Usage | null {
  const usage = isObject(message.usage) ? message.usage : null;

  if (!usage) {
    return null;
  }

  const input = Number(usage.input_tokens ?? 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);

  return { input, cacheWrite, cacheRead, total: input + cacheWrite + cacheRead };
}

async function measureClaude(file: string): Promise<ClaudeMeasure | null> {
  const sessionId = path.basename(file, '.jsonl').toLowerCase();
  const replies = new Set<string>();
  let snapshotsWithTools = 0;
  // The first request: everything up to the first assistant record; the
  // older CLIs write the tool definitions into the second prompt_snapshot
  // (after the first reply), so read on until the tools are seen. One reply
  // streams as several assistant records sharing a message id.
  let index = 0;
  const records = await readRecords(file, SCAN_LIMIT, record => {
    index += 1;

    if (record.type === 'assistant') {
      replies.add(str(isObject(record.message) ? record.message.id : '') || String(index));
    }

    if (record.type === 'api-request-shape' || (record.type === 'attachment' && isObject(record.attachment) && record.attachment.type === 'prompt_snapshot' && Array.isArray(record.attachment.tools))) {
      snapshotsWithTools += 1;
    }

    return replies.size >= 1 && (snapshotsWithTools >= 1 || replies.size >= 3);
  });

  const firstAssistantIndex = records.findIndex(record => record.type === 'assistant');

  if (firstAssistantIndex < 0) {
    return null;
  }

  const beforeReply = records.slice(0, firstAssistantIndex);
  const assistant = records[firstAssistantIndex]!;
  const assistantMessage = isObject(assistant.message) ? assistant.message : {};
  const version = str(records.find(record => typeof record.version === 'string')?.version) || '?';
  const cwd = str(records.find(record => typeof record.cwd === 'string')?.cwd);
  const attachments = beforeReply.filter(record => record.type === 'attachment' && isObject(record.attachment));
  const shape = beforeReply.find(record => record.type === 'api-request-shape');
  const shapeBody = shape && isObject(shape.shape) ? shape.shape : null;
  const snapshots = records.filter(record => record.type === 'attachment' && isObject(record.attachment) && record.attachment.type === 'prompt_snapshot').map(record => record.attachment as Json);
  const snapshotWithTools = snapshots.find(snapshot => Array.isArray(snapshot.tools));
  const request = beforeReply.find(record => record.type === 'api-request');
  const params = request && isObject(request.params) ? request.params : {};

  // System blocks: the shape when the CLI recorded one, else the snapshot.
  const system: ClaudeMeasure['system'] = [];
  let source: string;
  let promptText = '';

  if (shapeBody && Array.isArray(shapeBody.system)) {
    source = 'api-request-shape (the request as sent)';

    shapeBody.system.forEach((block, index) => {
      const text = isObject(block) ? str(block.text) : str(block);

      system.push({ label: `system[${index}]`, chars: text.length, head: head(text) });
    });
  } else if (snapshots[0]) {
    source = "prompt_snapshot attachment (the CLI's own record of its prompt; tools — the `schema` entries, the definitions as sent)";
    const prefix = str(snapshots[0].cliPrefix ?? snapshotWithTools?.cliPrefix);

    if (prefix) {
      system.push({ label: 'cliPrefix', chars: prefix.length, head: head(prefix) });
    }

    const prompts = Array.isArray(snapshots[0].systemPrompt) ? snapshots[0].systemPrompt : [snapshots[0].systemPrompt];

    prompts.forEach((block, index) => {
      const text = str(block);

      system.push({ label: `systemPrompt[${index}]`, chars: text.length, head: head(text) });
    });
  } else {
    return null;
  }

  // Our prompt: the block the catalog recognizes; what follows our
  // instructions inside it is appended by the CLI (or the run's environment).
  for (const block of shapeBody && Array.isArray(shapeBody.system) ? shapeBody.system : (Array.isArray(snapshots[0]?.systemPrompt) ? snapshots[0]!.systemPrompt : [])) {
    const text = isObject(block) ? str(block.text) : str(block);

    if (agentByPrompt(text, 'claude')) {
      promptText = text;
    }
  }

  // The dynamic block (system-role attachments) and the reminders of the
  // first user message (user-role attachments).
  const dynamic: Element[] = [];
  const reminders: Element[] = [];
  const deferred: string[] = [];
  const skills: ClaudeMeasure['skills'] = [];
  const agentTypes: string[] = [];

  for (const record of attachments) {
    const attachment = record.attachment as Json;
    const kind = str(attachment.type);
    const role = str(record.renderedRole);
    const size = renderedChars(record);

    if (kind === 'deferred_tools_delta' && Array.isArray(attachment.addedNames)) {
      deferred.push(...attachment.addedNames.map(str));
    }

    if (kind === 'skill_listing') {
      const content = str(attachment.content);

      // A skill set to name-only lists as a bare `- name` line, no colon.
      for (const line of content.split(/\n(?=- )/)) {
        const match = /^- ([^\s:]+(?::[^\s:]+)?)(?::|\s*$)/.exec(line);

        if (match) {
          skills.push({ name: match[1]!, chars: line.length, origin: skillOrigin(match[1]!) });
        }
      }
    }

    if (kind === 'agent_listing_delta' && Array.isArray(attachment.addedTypes)) {
      agentTypes.push(...attachment.addedTypes.map(str));
    }

    if (!size) {
      continue; // bookkeeping attachments (prompt_snapshot, credential_org) render nothing
    }

    const element: Element = { kind, role, chars: size, head: head(renderedText(record).replace(/<\/?system-reminder>/g, '')) };

    if (kind === 'instructions' && Array.isArray(attachment.files)) {
      element.detail = attachment.files.map(entry => (isObject(entry) ? `${str(entry.type)} ${str(entry.path)} (${str(entry.content).length} chars)` : ''));
    }

    if (kind === 'session_context' && isObject(attachment.context)) {
      element.detail = Object.entries(attachment.context).map(([key, value]) => `${key} (${chars(value)} chars)`);
    }

    (role === 'user' ? reminders : dynamic).push(element);
  }

  // Tools as sent (the shape), else as the snapshot kept them.
  const toolSource: unknown[] = shapeBody && Array.isArray(shapeBody.tools) ? shapeBody.tools : Array.isArray(snapshotWithTools?.tools) ? snapshotWithTools!.tools : [];
  const tools: ToolDef[] = toolSource.map(tool => {
    // A snapshot entry wraps the wire definition in `schema`.
    const def = isObject(tool) ? (isObject(tool.schema) ? tool.schema : tool) : {};
    const flags = Object.entries(def)
      .filter(([key]) => !['name', 'description', 'input_schema'].includes(key))
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');

    return { name: str(def.name), chars: chars(def), flags };
  });

  // The messages of the request (blobs; CLI ≥ 2.1.3xx), else the first user
  // message from the transcript and the user-role reminders.
  const blobs = beforeReply.filter(record => record.type === 'api-request-blob' && isObject(record.message));
  const messages: ClaudeMeasure['messages'] = [];

  if (blobs.length) {
    for (const blob of blobs) {
      const message = blob.message as Json;
      const content = Array.isArray(message.content) ? message.content : [message.content];

      messages.push({
        role: str(message.role),
        blocks: content.map(block => (isObject(block) ? `${str(block.type)} ${chars(block)}` : `text ${chars(block)}`)),
        chars: chars(message.content),
      });
    }
  } else {
    const firstUser = beforeReply.find(record => record.type === 'user' && isObject(record.message));
    const text = firstUser ? chars((firstUser.message as Json).content) : 0;
    const reminderChars = reminders.reduce((sum, element) => sum + element.chars, 0);

    messages.push({ role: 'user', blocks: [`${reminders.length} reminders ${reminderChars}`, `prompt ${text}`], chars: reminderChars + text });

    const dynamicChars = dynamic.reduce((sum, element) => sum + element.chars, 0);

    messages.push({ role: 'system (dynamic block, from the attachments)', blocks: [`${dynamic.length} attachments`], chars: dynamicChars });
  }

  const cacheControl = request && Array.isArray(request.cacheControl) ? request.cacheControl : [];
  const usage = usageOf(assistantMessage);
  const systemChars = system.reduce((sum, block) => sum + block.chars, 0);
  const toolChars = tools.reduce((sum, tool) => sum + tool.chars, 0);
  const messageChars = messages.reduce((sum, message) => sum + message.chars, 0);
  const outputConfig = isObject(params.output_config) ? params.output_config : {};

  return {
    sdk: 'claude',
    sessionId,
    file,
    mtime: (await fs.stat(file)).mtime,
    version,
    cwd,
    model: str(params.model) || str(assistantMessage.model) || '?',
    effort: str(outputConfig.effort) || '?',
    timestamp: str(assistant.timestamp),
    source,
    system,
    dynamic,
    reminders,
    prompt: { text: promptText, chars: promptText.length },
    tools,
    deferred,
    skills,
    agentTypes,
    messages,
    request: {
      betas: Array.isArray(params.betas) ? params.betas.length : 0,
      maxTokens: Number(params.max_tokens ?? 0),
      cacheBreakpoints: cacheControl.map(entry => (isObject(entry) && Array.isArray(entry.path) ? entry.path.join('.') : JSON.stringify(entry))),
    },
    usage,
    totalChars: systemChars + toolChars + messageChars,
  };
}

// ---------------------------------------------------------------------------
// Codex: the first turn of a rollout.

type CodexMeasure = {
  sdk: 'codex';
  sessionId: string;
  file: string;
  mtime: Date;
  cwd: string;
  meta: Record<string, string>;
  base: number; // session_meta.base_instructions — the Codex system prompt
  items: Element[]; // developer and user items of the first turn, in order
  prompt: { text: string; chars: number };
  appended: number; // what Codex appended to our brief (<skills_instructions>)
  tools: ToolDef[];
  nested: string[]; // the tools callable from inside `exec`
  skills: { name: string; chars: number; origin: string }[];
  hashedParts: string[]; // world_state parts recorded as hashes only
  usage: { input: number; cached: number; output: number } | null;
  inventory: Map<string, number>;
  totalChars: number;
};

// The listing names each skill's file by an alias root (`r1/x/SKILL.md`);
// the roots table above the list maps the aliases to directories.
function codexSkillOrigin(location: string, roots: Map<string, string>): string {
  const alias = location.split('/')[0] ?? '';
  const root = roots.get(alias) ?? alias;

  if (root.endsWith('/.system')) {
    return 'Codex bundled (skills/.system)';
  }

  return `${root} (→ plugins/balabash/skills)`;
}

async function measureCodex(file: string): Promise<CodexMeasure | null> {
  const match = /-([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(file));
  const sessionId = match ? match[1]!.toLowerCase() : path.basename(file, '.jsonl');
  // The first turn: everything up to the first assistant item, then on to
  // its token usage record.
  let replied = false;
  const records = await readRecords(file, SCAN_LIMIT, record => {
    const payload = isObject(record.payload) ? record.payload : {};

    if (record.type === 'response_item' && (payload.role === 'assistant' || payload.type === 'reasoning' || payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
      replied = true;
    }

    return replied && (record.type === 'token_usage_record' || (record.type === 'event_msg' && payload.type === 'token_count'));
  });

  if (!records.some(record => record.type === 'session_meta')) {
    return null;
  }

  const inventory = new Map<string, number>();
  const meta: Record<string, string> = {};
  const items: Element[] = [];
  const tools: ToolDef[] = [];
  const nested: string[] = [];
  const skills: CodexMeasure['skills'] = [];
  const hashedParts: string[] = [];
  let cwd = '';
  let base = 0;
  let baseText = '';
  let prompt = '';
  let appended = 0;
  let usage: CodexMeasure['usage'] = null;

  for (const record of records) {
    const payload = isObject(record.payload) ? record.payload : {};
    const key = `${str(record.type)}${payload.type ? `/${str(payload.type)}` : ''}${payload.role ? ` ${str(payload.role)}` : ''}`;

    inventory.set(key, (inventory.get(key) ?? 0) + 1);

    if (record.type === 'session_meta') {
      cwd = str(payload.cwd);

      for (const field of ['cli_version', 'originator', 'source', 'model_provider', 'cwd']) {
        meta[field] = str(payload[field]);
      }

      const instructions = isObject(payload.base_instructions) ? payload.base_instructions : {};

      baseText = str(instructions.text);
      base = baseText.length;
      meta.base_instructions = `${fmt(base)} chars${isObject(instructions.provenance) ? ` (provenance: ${JSON.stringify(instructions.provenance)})` : ''}`;
    }

    if (record.type === 'turn_context') {
      for (const field of ['model', 'effort', 'approval_policy', 'sandbox_policy', 'permission_profile', 'multi_agent_version']) {
        if (payload[field] !== undefined) {
          meta[field] = typeof payload[field] === 'string' ? str(payload[field]) : JSON.stringify(payload[field]);
        }
      }
    }

    if (record.type === 'world_state' && isObject(payload.state)) {
      for (const [part, value] of Object.entries(payload.state)) {
        const text = JSON.stringify(value);

        if (/"[0-9a-f]{40}"/.test(text)) {
          hashedParts.push(`${part}: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`);
        }
      }
    }

    if (record.type === 'response_item' && payload.type === 'additional_tools' && Array.isArray(payload.tools)) {
      for (const namespace of payload.tools) {
        if (!isObject(namespace)) {
          continue;
        }

        const spaceName = str(namespace.name);
        const members = Array.isArray(namespace.tools) ? namespace.tools : [namespace];

        for (const tool of members) {
          if (!isObject(tool)) {
            continue;
          }

          tools.push({ name: `${spaceName}.${str(tool.name)}`, chars: chars(tool), flags: `type=${str(tool.type)}` });

          if (tool.name === 'exec') {
            for (const header of str(tool.description).matchAll(/^### `([^`]+)`/gm)) {
              nested.push(header[1]!);
            }
          }
        }
      }
    }

    if (record.type === 'response_item' && payload.type === 'message' && (payload.role === 'developer' || payload.role === 'user')) {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = content.map(block => (isObject(block) ? str(block.text) : str(block))).join('\n');
      let kind = `${str(payload.role)} message`;

      if (payload.role === 'developer' && text === baseText) {
        kind = 'developer: Codex system prompt (= base_instructions)';
      } else if (payload.role === 'developer' && agentByPrompt(text, 'codex')) {
        const cut = text.indexOf('<skills_instructions>');

        prompt = cut >= 0 ? text.slice(0, cut) : text;
        appended = text.length - prompt.length;
        kind = `developer: Balabash brief (${fmt(prompt.length)} chars)${appended ? ` + appended by Codex (${fmt(appended)} chars: <skills_instructions>)` : ''}`;

        const appendix = text.slice(cut >= 0 ? cut : text.length);
        const roots = new Map<string, string>();

        for (const root of appendix.matchAll(/^- `([a-z0-9]+)` = `([^`]+)`/gm)) {
          roots.set(root[1]!, root[2]!);
        }

        for (const line of appendix.split('\n')) {
          const skill = /^- ([^\s:]+(?::[^\s:]+)?): .*\(file: ([^)]+)\)\s*$/.exec(line);

          if (skill) {
            skills.push({ name: skill[1]!, chars: line.length, origin: codexSkillOrigin(skill[2]!, roots) });
          }
        }
      } else if (payload.role === 'user' && text.startsWith('<environment_context>')) {
        kind = 'user: <environment_context>';
      } else if (payload.role === 'user') {
        kind = 'user: the spawn prompt';
      } else {
        const tag = /^<([a-z_]+)>/.exec(text);

        kind = `developer: ${tag ? `<${tag[1]}>` : 'other'}`;
      }

      items.push({ kind, role: str(payload.role), chars: text.length, head: head(text) });
    }

    if (record.type === 'token_usage_record' && isObject(payload.usage) && !usage) {
      usage = { input: Number(payload.usage.input_tokens ?? 0), cached: Number(payload.usage.cached_input_tokens ?? 0), output: Number(payload.usage.output_tokens ?? 0) };
    }

    if (record.type === 'event_msg' && payload.type === 'token_count' && isObject(payload.info) && !usage) {
      const last = isObject(payload.info.last_token_usage) ? payload.info.last_token_usage : {};

      usage = { input: Number(last.input_tokens ?? 0), cached: Number(last.cached_input_tokens ?? 0), output: Number(last.output_tokens ?? 0) };
    }
  }

  const totalChars = items.reduce((sum, item) => sum + item.chars, 0) + tools.reduce((sum, tool) => sum + tool.chars, 0);

  return {
    sdk: 'codex',
    sessionId,
    file,
    mtime: (await fs.stat(file)).mtime,
    cwd,
    meta,
    base,
    items,
    prompt: { text: prompt, chars: prompt.length },
    appended,
    tools,
    nested,
    skills,
    hashedParts,
    usage,
    inventory,
    totalChars,
  };
}

// ---------------------------------------------------------------------------
// Attribution and selection.

type Measure = ClaudeMeasure | CodexMeasure;
type Attributed = { agent: string; threadId: string | null; how: string; measure: Measure };

function agentFromStateDir(cwd: string): string | null {
  const match = /[\\/]agent-state[\\/]([a-z_]+)-[0-9a-f-]{36}$/i.exec(cwd);

  return match ? match[1]! : null;
}

function attribute(measure: Measure, journal: Map<string, { agent: string; threadId: string }>): Attributed {
  const known = journal.get(measure.sessionId);

  if (known) {
    return { agent: known.agent, threadId: known.threadId, how: 'journal (session.sdk)', measure };
  }

  const byPrompt = measure.prompt.text ? agentByPrompt(measure.prompt.text, measure.sdk) : null;

  if (byPrompt) {
    return { agent: byPrompt.name, threadId: null, how: 'prompt head matches the catalog', measure };
  }

  const cwd = measure.cwd;
  const byDir = agentFromStateDir(cwd);

  if (byDir) {
    return { agent: byDir, threadId: null, how: 'agent-state directory', measure };
  }

  return { agent: 'unknown', threadId: null, how: 'not attributed', measure };
}

// Balabash's own Claude project directories: the agents' cwds under data/
// and the repository root (the scheduler's cwd — shared with the operator's
// own sessions there, hence the attribution by content).
async function claudeTranscripts(): Promise<string[]> {
  const prefixes = [
    `${claudeProjectDirName(path.resolve('data', 'workspace'))}-`,
    `${claudeProjectDirName(path.resolve('data', 'agent-state'))}-`,
  ];
  const exact = new Set([claudeProjectDirName(process.cwd())]);
  const projects = claudeProjectsDir();
  const files: string[] = [];
  let names: string[];

  try {
    names = await fs.readdir(projects);
  } catch {
    return [];
  }

  for (const name of names.filter(name => exact.has(name) || prefixes.some(prefix => name.startsWith(prefix)))) {
    const project = path.join(projects, name);

    for (const entry of await fs.readdir(project, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl') && UUID.test(entry.name.slice(0, -6))) {
        files.push(path.join(project, entry.name));
      }
    }
  }

  return files;
}

async function findSession(id: string): Promise<{ sdk: 'claude' | 'codex'; file: string } | null> {
  const wanted = id.toLowerCase();

  for (const file of await claudeTranscripts()) {
    if (path.basename(file, '.jsonl').toLowerCase() === wanted) {
      return { sdk: 'claude', file };
    }
  }

  // Any Claude project directory, not only ours: a session named explicitly.
  try {
    for (const name of await fs.readdir(claudeProjectsDir())) {
      const file = path.join(claudeProjectsDir(), name, `${wanted}.jsonl`);

      try {
        await fs.access(file);

        return { sdk: 'claude', file };
      } catch {
        /* not here */
      }
    }
  } catch {
    /* no projects dir */
  }

  const rollout = (await listCodexRollouts()).find(rollout => rollout.sdkSessionId === wanted);

  return rollout ? { sdk: 'codex', file: rollout.file } : null;
}

// ---------------------------------------------------------------------------
// Rendering.

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.map(cell => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`;

  return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

function renderClaude(entry: Attributed, measure: ClaudeMeasure): string {
  const usage = measure.usage;
  // Chars per token of this request: the real usage over everything sent.
  const ratio = usage && usage.total > 0 ? measure.totalChars / usage.total : 0;
  const tokens = (n: number) => (ratio ? `≈${fmt(Math.round(n / ratio))}` : '?');
  const sum = (elements: { chars: number }[]) => elements.reduce((total, element) => total + element.chars, 0);
  const sections: string[] = [];

  sections.push(
    [
      `# ${entry.agent} — Claude session ${measure.sessionId}`,
      '',
      `- attributed by: ${entry.how}${entry.threadId ? `; thread ${entry.threadId}` : ''}`,
      `- transcript: ${measure.file} (last written ${measure.mtime.toISOString()})`,
      `- CLI version: ${measure.version}; model: ${measure.model}; effort: ${measure.effort}; first request at ${measure.timestamp || '?'}`,
      `- cwd: ${measure.cwd || '?'}`,
      `- system blocks and tools read from: ${measure.source}`,
    ].join('\n'),
  );

  sections.push(
    [
      '## First request',
      '',
      usage
        ? `- tokens (usage of the first reply): **${fmt(usage.total)}** = ${fmt(usage.input)} input + ${fmt(usage.cacheWrite)} cache write + ${fmt(usage.cacheRead)} cache read`
        : '- tokens: no usage recorded',
      `- chars sent: ${fmt(measure.totalChars)} = system ${fmt(sum(measure.system))} + tools ${fmt(sum(measure.tools))} + messages ${fmt(sum(measure.messages))}`,
      ratio ? `- ${ratio.toFixed(2)} chars/token over the request — the ratio behind every ≈ below` : '- token estimates unavailable (no usage)',
      measure.request.cacheBreakpoints.length
        ? `- request: ${measure.request.betas} betas, max_tokens ${fmt(measure.request.maxTokens)}, cache breakpoints at ${measure.request.cacheBreakpoints.join(', ')}`
        : '- request parameters: not recorded by this CLI version (no api-request record)',
      '',
      table(
        ['part', 'chars', 'tokens', 'share'],
        [
          ['Balabash prompt (system block recognized by the catalog)', fmt(measure.prompt.chars), tokens(measure.prompt.chars), ratio ? `${((measure.prompt.chars / measure.totalChars) * 100).toFixed(0)}%` : ''],
          ['other system blocks (CLI prefix, appendices)', fmt(sum(measure.system) - measure.prompt.chars), tokens(sum(measure.system) - measure.prompt.chars), ''],
          ['dynamic block (system-role attachments)', fmt(sum(measure.dynamic)), tokens(sum(measure.dynamic)), ratio ? `${((sum(measure.dynamic) / measure.totalChars) * 100).toFixed(0)}%` : ''],
          ['reminders in the first user message', fmt(sum(measure.reminders)), tokens(sum(measure.reminders)), ''],
          ['native tool definitions', fmt(sum(measure.tools)), tokens(sum(measure.tools)), ratio ? `${((sum(measure.tools) / measure.totalChars) * 100).toFixed(0)}%` : ''],
        ],
      ),
    ].join('\n'),
  );

  sections.push(
    [
      '## System blocks',
      '',
      table(
        ['block', 'chars', 'tokens', 'head'],
        measure.system.map(block => [block.label + (block.chars === measure.prompt.chars && measure.prompt.chars ? ' — Balabash prompt' : ''), fmt(block.chars), tokens(block.chars), block.head]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      '## Dynamic block (system-role attachments, in order)',
      '',
      table(
        ['element', 'chars', 'tokens', 'head'],
        measure.dynamic.map(element => [element.kind, fmt(element.chars), tokens(element.chars), element.head]),
      ),
    ].join('\n'),
  );

  sections.push(
    [
      '## Reminders folded into the first user message',
      '',
      measure.reminders.length
        ? table(
            ['element', 'chars', 'tokens', 'detail / head'],
            measure.reminders.map(element => [element.kind, fmt(element.chars), tokens(element.chars), element.detail?.join('; ') || element.head]),
          )
        : '(none)',
    ].join('\n'),
  );

  sections.push(
    [
      `## Native tool definitions (${measure.tools.length})`,
      '',
      table(
        ['tool', 'chars', 'tokens', 'flags'],
        measure.tools.sort((a, b) => b.chars - a.chars).map(tool => [tool.name, fmt(tool.chars), tokens(tool.chars), tool.flags]),
      ),
    ].join('\n'),
  );

  const native = measure.deferred.filter(name => !name.startsWith('mcp__'));
  const mcp = measure.deferred.filter(name => name.startsWith('mcp__'));
  const byServer = new Map<string, number>();

  for (const name of mcp) {
    const server = name.split('__')[1] ?? '?';

    byServer.set(server, (byServer.get(server) ?? 0) + 1);
  }

  sections.push(
    [
      `## Deferred tools (${measure.deferred.length}; names only, loaded through ToolSearch)`,
      '',
      `- native (${native.length}): ${native.join(', ') || '—'}`,
      ...[...byServer.entries()].map(([server, count]) => `- mcp__${server}__ (${count}): ${mcp.filter(name => name.startsWith(`mcp__${server}__`)).map(name => name.slice(`mcp__${server}__`.length)).join(', ')}`),
    ].join('\n'),
  );

  sections.push(
    [
      `## Skills listed (${measure.skills.length})`,
      '',
      table(
        ['skill', 'chars', 'tokens', 'origin'],
        measure.skills.sort((a, b) => b.chars - a.chars).map(skill => [skill.name, fmt(skill.chars), tokens(skill.chars), skill.origin]),
      ),
    ].join('\n'),
  );

  sections.push(`## Sub-agent types listed (${measure.agentTypes.length})\n\n${measure.agentTypes.join(', ') || '—'}`);

  sections.push(
    [
      '## Messages of the first request',
      '',
      table(
        ['role', 'chars', 'tokens', 'blocks (type chars)'],
        measure.messages.map(message => [message.role, fmt(message.chars), tokens(message.chars), message.blocks.join('; ')]),
      ),
    ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}

function renderCodex(entry: Attributed, measure: CodexMeasure): string {
  const usage = measure.usage;
  const ratio = usage && usage.input > 0 ? measure.totalChars / usage.input : 0;
  const tokens = (n: number) => (ratio ? `≈${fmt(Math.round(n / ratio))}` : '?');
  const sum = (elements: { chars: number }[]) => elements.reduce((total, element) => total + element.chars, 0);
  const developer = measure.items.filter(item => item.role === 'developer');
  const user = measure.items.filter(item => item.role === 'user');
  const sections = [
    [
      `# ${entry.agent} — Codex session ${measure.sessionId}`,
      '',
      `- attributed by: ${entry.how}${entry.threadId ? `; thread ${entry.threadId}` : ''}`,
      `- rollout: ${measure.file} (last written ${measure.mtime.toISOString()})`,
      `- codex ${measure.meta.cli_version ?? '?'} (${measure.meta.originator ?? '?'}); model: ${measure.meta.model ?? '?'}; effort: ${measure.meta.effort ?? '?'}; approval ${measure.meta.approval_policy ?? '?'}, sandbox ${measure.meta.sandbox_policy ?? '?'}`,
      `- cwd: ${measure.cwd || '?'}`,
    ].join('\n'),
    [
      '## First request',
      '',
      usage
        ? `- tokens (first token_usage_record): **${fmt(usage.input)}** input (${fmt(usage.cached)} cached) + ${fmt(usage.output)} output`
        : '- tokens: no usage recorded in the scanned head',
      `- chars sent: ${fmt(measure.totalChars)} = developer messages ${fmt(sum(developer))} + user messages ${fmt(sum(user))} + tool definitions ${fmt(sum(measure.tools))}`,
      ratio ? `- ${ratio.toFixed(2)} chars/token over the request — the ratio behind every ≈ below` : '- token estimates unavailable',
      '',
      table(
        ['part', 'chars', 'tokens', 'share'],
        [
          ['Codex system prompt (base_instructions, developer message)', fmt(measure.base), tokens(measure.base), ratio ? `${((measure.base / measure.totalChars) * 100).toFixed(0)}%` : ''],
          ['Balabash brief (developer message, recognized by the catalog)', fmt(measure.prompt.chars), tokens(measure.prompt.chars), ratio ? `${((measure.prompt.chars / measure.totalChars) * 100).toFixed(0)}%` : ''],
          ['appended to the brief by Codex (<skills_instructions>)', fmt(measure.appended), tokens(measure.appended), ''],
          ['other developer messages', fmt(sum(developer) - measure.base - measure.prompt.chars - measure.appended), tokens(sum(developer) - measure.base - measure.prompt.chars - measure.appended), ''],
          ['user messages (<environment_context>, the spawn prompt)', fmt(sum(user)), tokens(sum(user)), ''],
          ['tool definitions (additional_tools)', fmt(sum(measure.tools)), tokens(sum(measure.tools)), ratio ? `${((sum(measure.tools) / measure.totalChars) * 100).toFixed(0)}%` : ''],
        ],
      ),
    ].join('\n'),
    [
      '## Developer and user items of the first turn, in order',
      '',
      table(['item', 'chars', 'tokens', 'head'], measure.items.map(item => [item.kind, fmt(item.chars), tokens(item.chars), item.head])),
    ].join('\n'),
    [
      `## Tool definitions (${measure.tools.length}; additional_tools, by namespace)`,
      '',
      table(['tool', 'chars', 'tokens', 'flags'], [...measure.tools].sort((a, b) => b.chars - a.chars).map(tool => [tool.name, fmt(tool.chars), tokens(tool.chars), tool.flags])),
      '',
      `Callable only from inside \`exec\` (described in its definition, ${measure.nested.length}): ${measure.nested.join(', ') || '—'}. The bridge's MCP tools (mcp__balabash__*) are not described anywhere in the request: the model discovers them at run time through \`ALL_TOOLS\` inside \`exec\`.`,
    ].join('\n'),
    [
      `## Skills listed (${measure.skills.length}; inside <skills_instructions>)`,
      '',
      measure.skills.length ? table(['skill', 'chars', 'tokens', 'origin'], measure.skills.map(skill => [skill.name, fmt(skill.chars), tokens(skill.chars), skill.origin])) : '(none)',
    ].join('\n'),
    [
      '## Parts the rollout records as hashes only (world_state)',
      '',
      measure.hashedParts.length ? measure.hashedParts.map(part => `- ${part}`).join('\n') : '(none)',
    ].join('\n'),
    ['## Session meta', '', table(['field', 'value'], Object.entries(measure.meta).map(([key, value]) => [key, value]))].join('\n'),
    ['## Records scanned (type/payload.type role: count)', '', [...measure.inventory.entries()].map(([key, count]) => `- ${key}: ${count}`).join('\n')].join('\n'),
  ];

  return `${sections.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------

const journal = await journalAttribution();

await loadSkillOrigins();

const selected: Attributed[] = [];

if (sessionArg) {
  const found = await findSession(sessionArg);

  if (!found) {
    console.error(`[measure-context] session ${sessionArg} not found in the Claude project directories or the Codex rollouts`);
    process.exit(1);
  }

  const measure = found.sdk === 'claude' ? await measureClaude(found.file) : await measureCodex(found.file);

  if (!measure) {
    console.error(`[measure-context] session ${sessionArg}: no first request recorded in ${found.file}`);
    process.exit(1);
  }

  selected.push(attribute(measure, journal));
} else {
  // Newest transcript first: the first session that attributes to an agent is
  // its newest; older ones are skipped unread beyond their head.
  const transcripts = await claudeTranscripts();
  const stats = await Promise.all(transcripts.map(async file => ({ file, mtime: (await fs.stat(file)).mtime.getTime() })));
  const rollouts = (await listCodexRollouts()).map(rollout => ({ file: rollout.file, mtime: rollout.mtime.getTime(), sdk: 'codex' as const }));
  const candidates = [...stats.map(stat => ({ ...stat, sdk: 'claude' as const })), ...rollouts].sort((a, b) => b.mtime - a.mtime);
  const seen = new Set<string>();
  let skipped = 0;

  for (const candidate of candidates) {
    const measure = candidate.sdk === 'claude' ? await measureClaude(candidate.file) : await measureCodex(candidate.file);

    if (!measure) {
      skipped += 1;

      continue;
    }

    const entry = attribute(measure, journal);
    const key = `${entry.agent}/${measure.sdk}`;

    if (entry.agent === 'unknown' || seen.has(key)) {
      skipped += 1;

      continue;
    }

    seen.add(key);
    selected.push(entry);
  }

  console.log(`[measure-context] ${candidates.length} sessions in the stores (${stats.length} Claude transcripts, ${rollouts.length} Codex rollouts); ${selected.length} newest per agent measured, ${skipped} skipped (older, unattributed or without a recorded first request)`);

  // Every repository agent, run()-based ones included: their sessions are
  // attributed by the journal or by their agent-state directory.
  const missing = getAgents().filter(agent => !isRemoteAgent(agent)).map(agent => agent.name).filter(name => !selected.some(entry => entry.agent === name));

  if (missing.length) {
    console.log(`[measure-context] no session found for: ${missing.join(', ')}`);
  }
}

await fs.mkdir(outDir, { recursive: true });

const written: string[] = [];
const summaryRows: (string | number)[][] = [];

for (const entry of selected.sort((a, b) => a.agent.localeCompare(b.agent))) {
  const measure = entry.measure;
  const name = sessionArg ? `${entry.agent}-${measure.sessionId}.md` : `${entry.agent}.md`;
  const file = path.join(outDir, name);

  await fs.writeFile(file, measure.sdk === 'claude' ? renderClaude(entry, measure) : renderCodex(entry, measure), 'utf8');
  written.push(file);

  if (measure.sdk === 'claude') {
    const sum = (elements: { chars: number }[]) => elements.reduce((total, element) => total + element.chars, 0);

    summaryRows.push([
      entry.agent,
      `claude ${measure.version}`,
      measure.sessionId.slice(0, 8),
      measure.timestamp.slice(0, 10),
      measure.usage ? fmt(measure.usage.total) : '?',
      fmt(measure.prompt.chars),
      fmt(sum(measure.dynamic)),
      fmt(sum(measure.reminders)),
      fmt(sum(measure.tools)),
      measure.tools.length,
      measure.deferred.length,
      measure.skills.length,
    ]);
  } else {
    summaryRows.push([
      entry.agent,
      `codex ${measure.meta.cli_version ?? ''}`.trim(),
      measure.sessionId.slice(0, 8),
      measure.mtime.toISOString().slice(0, 10),
      measure.usage ? fmt(measure.usage.input) : '?',
      fmt(measure.prompt.chars),
      // Everything developer-side that is not our brief: the Codex system
      // prompt, the skills appendix, the multi-agent notes.
      fmt(measure.items.filter(item => item.role === 'developer').reduce((sum, item) => sum + item.chars, 0) - measure.prompt.chars),
      fmt(measure.items.filter(item => item.role === 'user' && item.kind.includes('environment')).reduce((sum, item) => sum + item.chars, 0)),
      fmt(measure.tools.reduce((sum, tool) => sum + tool.chars, 0)),
      measure.tools.length,
      '—',
      measure.skills.length,
    ]);
  }
}

if (!sessionArg) {
  const summary = [
    `# Context measure — ${new Date().toISOString()}`,
    '',
    'The newest session of each agent: the first request\'s tokens (usage) and the sizes in chars of its parts — our prompt, the text the SDK adds around it (Claude: the dynamic block; Codex: its own system prompt and appendices), the reminders or environment context in the user turn, the tool definitions. Details per agent in the files beside.',
    '',
    table(['agent', 'sdk', 'session', 'date', 'first-request tokens', 'Balabash prompt', 'SDK-added text (dynamic block / Codex prompt)', 'reminders / environment', 'tool defs', 'tools', 'deferred', 'skills'], summaryRows),
    '',
  ].join('\n');
  const file = path.join(outDir, 'summary.md');

  await fs.writeFile(file, summary, 'utf8');
  written.push(file);
}

console.log(`[measure-context] written:\n${written.map(file => `  ${file}`).join('\n')}`);

await prisma.$disconnect();
process.exit(0);
