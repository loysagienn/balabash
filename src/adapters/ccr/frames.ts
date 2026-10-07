// Frame builders and inbound parsing for the CCR plane. The Claude app
// renders a live stream of SDKMessage frames; on the outbound side we
// synthesize the minimal shapes its UI needs (a system/init opener and
// assistant text frames), on the inbound side we read the user frames the
// app produces. Shapes verified live against the real backend (fork spike,
// 2026-08-11, SDK 0.3.223).

import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel } from '../../core/contract.ts';

// The model label shown by the app for our synthesized frames. Cosmetic —
// the agent's real model is a harness concern, not a frame concern.
const FRAME_MODEL = 'balabash';

/** Minimal assistant text frame; session_id is injected by the handle. */
export function assistantTextFrame(text: string): SDKMessage {
  const frame = {
    type: 'assistant',
    message: {
      id: `msg_bb_${randomUUID().slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      model: FRAME_MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: '',
  };

  return frame as unknown as SDKMessage;
}

/**
 * Minimal system/init frame — what a fresh CLI process emits first.
 *
 * `effort` is what the app shows as the session's reasoning effort: it reads
 * the newest init frame of the session. The inner CLI's own init (stamped
 * with the effort in sdk-session.ts) is emitted ~0.3s after spawn — before
 * the CCR session exists (0.4–1.3s) — so the mirror drops it and this frame,
 * written right after the session is created, is the one the app sees.
 * Without the field the app falls back to its own default (medium).
 */
export function systemInitFrame(cwd: string, effort?: EffortLevel): SDKMessage {
  const frame = {
    type: 'system',
    subtype: 'init',
    ...(effort ? { effort } : {}),
    apiKeySource: 'none',
    claude_code_version: 'balabash',
    cwd,
    tools: [],
    mcp_servers: [],
    model: FRAME_MODEL,
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: '',
  };

  return frame as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Inbound: user frames as the app sends them. Attachments arrive as
// references (file_uuid) with an empty content — bytes are fetched
// separately (attachments.ts).

export type InboundAttachment = {
  fileUuid: string;
  fileName: string;
  isImage: boolean;
};

export type InboundUserMessage = {
  text: string | null;
  attachments: InboundAttachment[];
};

export function parseInboundUserMessage(msg: SDKMessage): InboundUserMessage | null {
  const raw = msg as unknown as {
    type?: string;
    message?: { content?: unknown };
    file_attachments?: Array<{ file_uuid?: string; file_name?: string; is_image?: boolean }>;
  };

  if (raw.type !== 'user') {
    return null;
  }

  const content = raw.message?.content;
  let text: string | null = null;

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((block): block is { type: 'text'; text: string } => (block as { type?: string }).type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  const attachments: InboundAttachment[] = (raw.file_attachments ?? [])
    .filter(att => typeof att.file_uuid === 'string')
    .map(att => ({
      fileUuid: att.file_uuid!,
      fileName: att.file_name ?? att.file_uuid!,
      isImage: att.is_image === true,
    }));

  if (!text && !attachments.length) {
    return null;
  }

  return { text: text || null, attachments };
}
