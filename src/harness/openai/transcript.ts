// The transcript: turns a slice of the event log into the coordinator prompt.
// Port of v1 runner/transcript with v2 renderers: canonical thread-aware
// types, "who speaks" from the envelope actor and the identity in payload.
// The send-pair collapse and agentRunId machinery of v1 are gone by
// construction (design doc §1).
//
// Principles: events are never merged into one entry, only skipped whole;
// length is bounded by two mechanisms — a per-string limit decaying with
// depth into history, and a total char budget accumulated from the newest
// events. The format is worked out one event type at a time: a covered type
// has a renderer, uncovered ones spill into the envelope via the flat
// default.
//
// No internal module imports: the file must stay runnable standalone for
// transcript debugging scripts.

type TranscriptEvent = {
  seq: number | bigint;
  type: string;
  actor: string;
  agentName: string | null;
  threadId: string | null;
  targetThreadId: string | null;
  payload: unknown;
  createdAt: string | Date;
};

type JsonObject = Record<string, unknown>;

// Fields of one specific event type; null — the event stays out of the
// transcript.
type Renderer = (payload: JsonObject, event: TranscriptEvent) => JsonObject | null;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function isoDate(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}

// Drops null/undefined fields so that optional values do not add noise to
// the transcript.
function omitNullish(fields: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
}

// Truncation of long events: the JSON stays valid — the value is walked
// deeply and only string fields longer than the limit are cut, other types
// are untouched. An event with at least one cut string gets the flag
// truncated: true; the full content stays in the log behind get_event(seq).
const STRING_LIMIT_MAX = 8000;
const STRING_LIMIT_MIN = 200;
const STRING_LIMIT_DECAY = 0.97;

function stringLimitForPosition(distanceFromEnd: number): number {
  return Math.max(STRING_LIMIT_MIN, Math.round(STRING_LIMIT_MAX * STRING_LIMIT_DECAY ** distanceFromEnd));
}

const TRUNCATED_FLAG = 'truncated';

type TruncateResult = {
  value: unknown;
  truncated: boolean;
};

function truncateLongStrings(value: unknown, limit: number): TruncateResult {
  if (typeof value === 'string') {
    if (value.length <= limit) {
      return { value, truncated: false };
    }

    return { value: `${value.slice(0, limit)}…`, truncated: true };
  }

  if (Array.isArray(value)) {
    let truncated = false;
    const items = value.map(item => {
      const result = truncateLongStrings(item, limit);

      truncated ||= result.truncated;

      return result.value;
    });

    return { value: items, truncated };
  }

  if (value && typeof value === 'object') {
    let truncated = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const result = truncateLongStrings(item, limit);

      truncated ||= result.truncated;

      return [key, result.value];
    });

    return { value: Object.fromEntries(entries), truncated };
  }

  return { value, truncated: false };
}

// "Who speaks" for user messages: a compact display name from the identity
// payload — group transcripts are multi-voice (§6).
function renderIdentity(identity: unknown): string | null {
  const object = asObject(identity);
  const name = [object.firstName, object.lastName]
    .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    .join(' ');
  const username = typeof object.username === 'string' && object.username ? `@${object.username}` : null;

  if (name && username) {
    return `${name} (${username})`;
  }

  return name || username;
}

// Content blocks (§9) rendered compactly: text inline, binary refs by fileId.
function renderContentBlocks(content: unknown): { text: string | null; files: unknown[] } {
  const blocks = Array.isArray(content) ? content : [];
  const textParts: string[] = [];
  const files: unknown[] = [];

  for (const block of blocks) {
    const object = asObject(block);

    if (object.type === 'text' && typeof object.text === 'string') {
      textParts.push(object.text);
    } else if (object.type === 'image' || object.type === 'file') {
      files.push(omitNullish({ type: object.type, fileId: object.fileId }));
    } else if (object.type === 'resource_link') {
      files.push(omitNullish({ type: object.type, name: object.name, mimeType: object.mimeType, size: object.size }));
    }
  }

  return { text: textParts.length ? textParts.join('\n') : null, files };
}

const renderers: Record<string, Renderer> = {
  // payload: { text, blocks?, files?, identity }. The identity is collapsed
  // into a display name; file metadata rides along for the model.
  'user.message': payload =>
    omitNullish({
      from: renderIdentity(payload.identity),
      text: typeof payload.text === 'string' && payload.text ? payload.text : undefined,
      files: Array.isArray(payload.files) && payload.files.length ? payload.files : undefined,
    }),

  // payload: { content: ContentBlock[] } — the agent's own outgoing message.
  'agent.message': payload => {
    const { text, files } = renderContentBlocks(payload.content);

    return omitNullish({
      text,
      files: files.length ? files : undefined,
    });
  },

  // Tool calls: started/completed/failed are not correlated with each other.
  // callId is internal correlation and is not rendered.
  'tool.call.started': payload => ({
    functionName: payload.functionName,
    input: payload.input,
  }),

  // payload: { callId, functionName, serverName?, toolName?, result }. The
  // canonical result {content, structuredContent?} is compacted: structured
  // content as structure, text blocks inline, binary blocks as refs.
  'tool.call.completed': payload => {
    const result = asObject(payload.result);
    const { text, files } = renderContentBlocks(result.content);

    return omitNullish({
      functionName: payload.functionName,
      structured: result.structuredContent,
      text,
      files: files.length ? files : undefined,
    });
  },

  'tool.call.failed': payload => ({
    functionName: payload.functionName,
    error: payload.error,
  }),

  // Thread lifecycle (§5.1) as seen from a parent's transcript: the child's
  // threadId comes from the envelope — the model needs it for cancel_thread
  // and get_thread. Inputs and summaries stay whole; the decay/truncation
  // machinery bounds them like everything else.
  'thread.started': (payload, event) =>
    omitNullish({
      threadId: event.threadId,
      agent: payload.agent,
      title: payload.title,
      input: payload.input,
    }),

  'thread.progress': (payload, event) =>
    omitNullish({
      threadId: event.threadId,
      text: payload.text,
    }),

  // Addressed inter-thread message: for an outgoing message targetThreadId
  // names the child, for an incoming one threadId names the author. fileIds
  // are the message's file references — usable wherever fileIds are accepted.
  'thread.message': (payload, event) =>
    omitNullish({
      threadId: event.threadId,
      targetThreadId: event.targetThreadId,
      text: payload.text,
      fileIds: Array.isArray(payload.fileIds) && payload.fileIds.length ? payload.fileIds : undefined,
      redirectedFromThreadId: payload.redirectedFromThreadId,
    }),

  'thread.completed': (payload, event) =>
    omitNullish({
      threadId: event.threadId,
      summary: payload.summary,
    }),

  'thread.failed': (payload, event) =>
    omitNullish({
      threadId: event.threadId,
      error: payload.error,
      redirectedFromThreadId: payload.redirectedFromThreadId,
    }),

  'thread.cancelled': (payload, event) =>
    omitNullish({
      threadId: event.threadId,
      reason: payload.reason,
      requestedBy: payload.requestedBy,
    }),

  'thread.cancel': (payload, event) =>
    omitNullish({
      targetThreadId: event.targetThreadId,
      reason: payload.reason,
    }),

  'thread.notification': payload => ({
    level: payload.level,
    text: payload.text,
  }),

  'system.exception': payload =>
    omitNullish({
      error: payload.error,
      eventType: payload.eventType,
      consumerName: payload.consumerName,
    }),

  // Restart lifecycle: the request in the requester's transcript, the
  // completion delivered by the fresh process (redirected to main when the
  // requester thread already finished).
  'system.restart.requested': payload =>
    omitNullish({
      reason: payload.reason,
      force: payload.force,
      requestedBy: payload.requestedBy,
    }),

  'system.restart.completed': payload =>
    omitNullish({
      requestSeq: payload.requestSeq,
      reason: payload.reason,
      rolledBack: payload.rolledBack,
      rollbackReason: payload.rollbackReason,
      migrationsFailed: payload.migrationsFailed,
      redirectedFromThreadId: payload.redirectedFromThreadId,
    }),
};

type RenderedEvent = {
  at: string;
  envelope: JsonObject;
  fields: JsonObject;
};

// Builds the envelope and the event fields without truncation; null — the
// event stays out of the transcript. Truncation is applied separately, once
// the event's position among the included ones is known.
function renderEvent(event: TranscriptEvent): RenderedEvent | null {
  const renderer = renderers[event.type];
  const envelope: JsonObject = {
    seq: Number(event.seq),
    type: event.type,
    // The author is ambient (user messages carry identity, coordinator events
    // are its own) — only foreign agents are annotated.
    ...(event.actor === 'agent' && event.agentName && event.agentName !== 'coordinator'
      ? { agent: event.agentName }
      : {}),
  };

  let fields: JsonObject | null;

  if (renderer) {
    fields = renderer(asObject(event.payload), event);
  } else {
    // A type without a renderer (thread lifecycle of future children, domain
    // events of dynamic agents): the whole payload spills into the envelope.
    // seq/type/at/agent and truncated are ours; a same-named payload field is
    // not lost — it moves under the payload_ prefix.
    const payload = asObject(event.payload);

    fields = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key in envelope || key === TRUNCATED_FLAG || key === 'at' ? `payload_${key}` : key,
        value,
      ]),
    );
  }

  if (!fields) {
    return null;
  }

  return { at: isoDate(event.createdAt), envelope, fields };
}

function finalizeEvent({ envelope, fields }: RenderedEvent, stringLimit: number): JsonObject {
  const { value: truncatedFields, truncated } = truncateLongStrings(fields, stringLimit);

  return {
    ...envelope,
    ...(truncated ? { [TRUNCATED_FLAG]: true } : {}),
    ...(truncatedFields as JsonObject),
  };
}

// The total transcript budget in chars. Accumulated from the newest events
// back into history: an event that does not fit whole is dropped along with
// everything older than it.
const TRANSCRIPT_CHAR_LIMIT = 50_000;

// This many newest events always make the transcript, even when the budget
// is already exceeded: the model must not be left without its immediate
// context. String field truncation applies to them like to everything else.
const ALWAYS_INCLUDED_EVENTS = 10;

// Exact timestamps on every event mostly repeat the same moment and consume a
// meaningful part of the transcript. One marker anchors the first included
// event; another is inserted only when the visible timeline advances by at
// least this much.
const TIME_MARKER_GAP_MS = 30 * 60 * 1000;

type TranscriptLine = {
  at: string;
  event: string;
};

function timeMarker(at: string): string {
  return JSON.stringify({ type: 'system.time', at });
}

function hasTimeGap(previous: TranscriptLine, current: TranscriptLine): boolean {
  const previousMs = new Date(previous.at).getTime();
  const currentMs = new Date(current.at).getTime();

  return Number.isFinite(previousMs) && Number.isFinite(currentMs) && currentMs - previousMs >= TIME_MARKER_GAP_MS;
}

function renderLines(lines: TranscriptLine[]): string {
  const output: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;

    if (index === 0 || hasTimeGap(lines[index - 1]!, line)) {
      output.push(timeMarker(line.at));
    }

    output.push(line.event);
  }

  return output.join('\n');
}

export type Transcript = {
  text: string;
  // True when the char budget dropped the oldest events: the text does not
  // cover the whole input slice. Renderer omissions (null renders) are by
  // design and do not raise the flag.
  dropped: boolean;
};

export function buildTranscript(events: TranscriptEvent[]): Transcript {
  const rendered = events.map(event => renderEvent(event)).filter(item => item !== null);

  const lines = rendered.map((item, index) => ({
    at: item.at,
    event: JSON.stringify(finalizeEvent(item, stringLimitForPosition(rendered.length - 1 - index))),
  }));

  let included: TranscriptLine[] = [];

  for (let index = lines.length - 1; index >= 0; index--) {
    const mandatory = included.length < ALWAYS_INCLUDED_EVENTS;
    const candidate = [lines[index]!, ...included];

    if (!mandatory && renderLines(candidate).length > TRANSCRIPT_CHAR_LIMIT) {
      break;
    }

    included = candidate;
  }

  return {
    text: renderLines(included),
    dropped: included.length < lines.length,
  };
}
