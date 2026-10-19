// The reading rule of the tool-result contour (§9), projection "main-agent
// context", rendered for the Messages API: structuredContent is primary —
// when it is present the content blocks are not read at all; without it the
// raw MCP content blocks are rendered (text, image{data,mimeType} as a
// base64 image, resource_link, resource). Renderers know ONLY the raw MCP
// form — no compatibility with the canonical image{fileId}/file{fileId}
// blocks of old history (accepted: old events may render poorly or drop
// out). The twin of src/harness/openai/content.ts: same rule, Anthropic's
// block shapes — where OpenAI takes any file by URL (input_file), the
// Messages API takes images (by URL or base64) and PDF documents by URL;
// any other file reaches the model as its URL in text.
//
// On top of the rule sits the same small "tool × projection" registry:
// storage_get_file feeds its presigned url into context as the actual
// image/document.

import type Anthropic from '@anthropic-ai/sdk';
import type { JsonObject, ToolResult } from '../../core/contract.ts';

export type ToolResultContent = NonNullable<Anthropic.ToolResultBlockParam['content']>;
type ToolResultBlock = Exclude<ToolResultContent, string>[number];

type Base64ImageMediaType = Anthropic.Base64ImageSource['media_type'];

const IMAGE_MEDIA_TYPES: readonly Base64ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function text(value: string): ToolResultBlock {
  return { type: 'text', text: value };
}

// A base64 image block, when the MIME type is one the API accepts; null
// otherwise (the caller falls back to a text marker).
function base64Image(data: string, mimeType: unknown): ToolResultBlock | null {
  const mediaType = typeof mimeType === 'string' ? mimeType.toLowerCase() : 'image/png';

  if (!IMAGE_MEDIA_TYPES.includes(mediaType as Base64ImageMediaType)) {
    return null;
  }

  return { type: 'image', source: { type: 'base64', media_type: mediaType as Base64ImageMediaType, data } };
}

// A file behind an http(s) URL: images and PDFs enter the context as
// themselves, anything else as its URL (the model can hand it on).
function urlBlock(url: string, mimeType: string, fallback: () => ToolResultBlock): ToolResultBlock {
  const lower = mimeType.toLowerCase();

  if (!/^https?:\/\//i.test(url)) {
    return fallback();
  }

  if (lower.startsWith('image/')) {
    return { type: 'image', source: { type: 'url', url } };
  }

  if (lower === 'application/pdf') {
    return { type: 'document', source: { type: 'url', url } };
  }

  return fallback();
}

// One raw MCP content block → Messages API block. Structural on purpose:
// the renderer reads the raw form only.
function rawBlockToContent(rawBlock: unknown): ToolResultBlock {
  const block = asObject(rawBlock);

  if (block.type === 'text' && typeof block.text === 'string') {
    return text(block.text);
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    return base64Image(block.data, block.mimeType) ?? text(`[image ${String(block.mimeType ?? 'unknown')} content]`);
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : '';

    return urlBlock(block.uri, mimeType, () =>
      text(JSON.stringify({ type: 'resource_link', uri: block.uri, name: block.name, mimeType: block.mimeType })),
    );
  }

  if (block.type === 'resource') {
    const resource = asObject(block.resource);

    if (typeof resource.text === 'string') {
      return text(resource.text);
    }

    if (typeof resource.blob === 'string') {
      const mimeType = typeof resource.mimeType === 'string' && resource.mimeType ? resource.mimeType : '';

      if (mimeType.toLowerCase().startsWith('image/')) {
        const image = base64Image(resource.blob, mimeType);

        if (image) {
          return image;
        }
      }

      return text(JSON.stringify({ type: 'resource', uri: resource.uri, mimeType: resource.mimeType }));
    }
  }

  // An unknown or malformed block: a marker instead of silence — the full
  // event is recoverable via get_event(seq).
  return text(`[${typeof block.type === 'string' ? block.type : 'unknown'} content]`);
}

// The "tool × projection" registry for this projection: extras appended
// after the structured JSON. storage_get_file returns the one FileRef plus
// its ephemeral presigned url — the url enters context as the actual content
// where the API takes it (images, PDFs); other files are already named by
// their url in the structured JSON.
type ProjectionExtra = (structured: JsonObject) => ToolResultBlock | null;

const contextExtras: Record<string, ProjectionExtra> = {
  storage_get_file: structured => {
    const url = typeof structured.url === 'string' ? structured.url : null;

    if (!url) {
      return null;
    }

    const contentType = typeof structured.contentType === 'string' ? structured.contentType : '';
    const block = urlBlock(url, contentType, () => text(''));

    return block.type === 'text' ? null : block;
  },
};

// Renders a tool result for a tool_result block under the strict reading
// rule. Pure text collapses into a single string; anything binary stays a
// block array so images actually enter the model context.
export function toolResultToContent(result: ToolResult, functionName?: string): ToolResultContent {
  const blocks: ToolResultBlock[] = [];

  if (result.structuredContent !== undefined) {
    // structuredContent is primary: content blocks are not read at all.
    blocks.push(text(JSON.stringify(result.structuredContent)));

    const extra = functionName ? contextExtras[functionName]?.(asObject(result.structuredContent)) : null;

    if (extra) {
      blocks.push(extra);
    }
  } else {
    for (const block of result.content ?? []) {
      blocks.push(rawBlockToContent(block));
    }
  }

  if (blocks.some(block => block.type !== 'text')) {
    return blocks;
  }

  const joined = blocks
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim();

  return joined || 'OK';
}
