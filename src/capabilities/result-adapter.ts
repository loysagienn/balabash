// MCP call result → canonical ToolResult (§9): one representation for the
// log, the transcript and the harness. Binary blocks are materialized into
// files here — before the result reaches the log (§4.3).
//
// structuredContent dedup (§15 п.9): per the MCP spec a server returning
// structuredContent SHOULD repeat it as a serialized text block for backwards
// compatibility. Those text blocks are an alternative representation, not
// additional output — with structuredContent present they are dropped.
// Non-text blocks remain independent modalities (e.g. a file's structured
// metadata alongside its resource_link) and are preserved.

import type { ContentBlock, JsonObject, ToolResult } from '../core/contract.ts';
import { ingestFile } from '../files/index.ts';

type RawContentBlock = {
  type: string;
  text?: string;
  // image / audio: base64 payload
  data?: string;
  mimeType?: string;
  // resource_link
  uri?: string;
  name?: string;
  size?: number;
  // embedded resource
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
};

type MaterializeContext = {
  // The workspace that owns the materialized files — the calling run's user.
  userId: string;
  serverName: string;
  toolName: string;
};

function extensionFromMimeType(mimeType: string | undefined): string {
  const subtype = mimeType?.split('/')[1]?.split(';')[0]?.trim();

  return subtype && /^[a-z0-9.+-]+$/i.test(subtype) ? `.${subtype.replace(/\+.*$/, '')}` : '';
}

async function materializeBinary(
  data: string,
  mimeType: string | undefined,
  ctx: MaterializeContext,
): Promise<ContentBlock> {
  const body = Buffer.from(data, 'base64');
  const isImage = Boolean(mimeType?.toLowerCase().startsWith('image/'));
  const file = await ingestFile({
    body,
    contentType: mimeType ?? null,
    sizeBytes: body.byteLength,
    originalFilename: `${ctx.serverName}-${ctx.toolName}${extensionFromMimeType(mimeType)}`,
    scope: 'tool-result',
    userId: ctx.userId,
  });

  return isImage ? { type: 'image', fileId: file.id } : { type: 'file', fileId: file.id };
}

async function toCanonicalBlock(block: RawContentBlock, ctx: MaterializeContext): Promise<ContentBlock> {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }

  if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
    return materializeBinary(block.data, block.mimeType, ctx);
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    return {
      type: 'resource_link',
      uri: block.uri,
      ...(typeof block.name === 'string' ? { name: block.name } : {}),
      ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
      ...(typeof block.size === 'number' ? { size: block.size } : {}),
    };
  }

  if (block.type === 'resource' && block.resource) {
    const { resource } = block;

    if (typeof resource.text === 'string') {
      return { type: 'text', text: resource.text };
    }

    if (typeof resource.blob === 'string') {
      return materializeBinary(resource.blob, resource.mimeType, ctx);
    }
  }

  return { type: 'text', text: `[${block.type} content]` };
}

export async function toCanonicalToolResult(
  raw: Record<string, unknown>,
  ctx: MaterializeContext,
): Promise<ToolResult> {
  const rawBlocks = Array.isArray(raw.content) ? (raw.content as RawContentBlock[]) : [];
  const structured = raw.structuredContent !== undefined ? (raw.structuredContent as JsonObject) : undefined;
  const selected = structured === undefined ? rawBlocks : rawBlocks.filter(block => block.type !== 'text');

  const content: ContentBlock[] = [];

  for (const block of selected) {
    content.push(await toCanonicalBlock(block, ctx));
  }

  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

// The error text of an isError result: the model sees it as a thrown tool
// error, journaled as tool.call.failed.
export function extractErrorText(raw: Record<string, unknown>): string {
  const rawBlocks = Array.isArray(raw.content) ? (raw.content as RawContentBlock[]) : [];
  const text = rawBlocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();

  return text || 'Tool call failed';
}
