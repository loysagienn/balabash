// The reading rule of the tool-result contour (§9), projection "main-agent
// context": structuredContent is primary — when it is present the content
// blocks are not read at all; without it the raw MCP content blocks are
// rendered (text, image{data,mimeType} as a data URL, resource_link,
// resource). Renderers know ONLY the raw MCP form — no compatibility with
// the canonical image{fileId}/file{fileId} blocks of old history (accepted:
// old events may render poorly or drop out).
//
// On top of the rule sits a small "tool × projection" registry: per-tool
// extras for this projection (storage_get_file feeds its presigned url into
// context as the actual image/file).

import type { JsonObject, ToolResult } from '../../core/contract.ts';

export type ModelContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; file_url: string; detail: 'auto' };

export type ModelOutput = string | ModelContentPart[];

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

// One raw MCP content block → model input. Structural on purpose: until the
// verbatim-record step the static type still says canonical blocks, and after
// it the union is the raw MCP one — the renderer reads the raw form only.
function rawBlockToModelContent(rawBlock: unknown): ModelContentPart {
  const block = asObject(rawBlock);

  if (block.type === 'text' && typeof block.text === 'string') {
    return { type: 'input_text', text: block.text };
  }

  if (block.type === 'image' && typeof block.data === 'string') {
    const mimeType = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : 'image/png';

    return { type: 'input_image', image_url: `data:${mimeType};base64,${block.data}`, detail: 'auto' };
  }

  if (block.type === 'resource_link' && typeof block.uri === 'string') {
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';

    if (/^https?:\/\//i.test(block.uri) && mimeType.startsWith('image/')) {
      return { type: 'input_image', image_url: block.uri, detail: 'auto' };
    }

    if (/^https?:\/\//i.test(block.uri) && mimeType) {
      return { type: 'input_file', file_url: block.uri, detail: 'auto' };
    }

    return {
      type: 'input_text',
      text: JSON.stringify({ type: 'resource_link', uri: block.uri, name: block.name, mimeType: block.mimeType }),
    };
  }

  if (block.type === 'resource') {
    const resource = asObject(block.resource);

    if (typeof resource.text === 'string') {
      return { type: 'input_text', text: resource.text };
    }

    if (typeof resource.blob === 'string') {
      const mimeType = typeof resource.mimeType === 'string' && resource.mimeType ? resource.mimeType : '';

      if (mimeType.toLowerCase().startsWith('image/')) {
        return { type: 'input_image', image_url: `data:${mimeType};base64,${resource.blob}`, detail: 'auto' };
      }

      return {
        type: 'input_text',
        text: JSON.stringify({ type: 'resource', uri: resource.uri, mimeType: resource.mimeType }),
      };
    }
  }

  // An unknown or malformed block: a marker instead of silence — the full
  // event is recoverable via get_event(seq).
  return { type: 'input_text', text: `[${typeof block.type === 'string' ? block.type : 'unknown'} content]` };
}

// The "tool × projection" registry for this projection: extras appended
// after the structured JSON. storage_get_file returns the one FileRef plus
// its ephemeral presigned url — the url enters context as the actual content.
type ProjectionExtra = (structured: JsonObject) => ModelContentPart | null;

const contextExtras: Record<string, ProjectionExtra> = {
  storage_get_file: structured => {
    const url = typeof structured.url === 'string' ? structured.url : null;

    if (!url) {
      return null;
    }

    const contentType = typeof structured.contentType === 'string' ? structured.contentType : '';

    return contentType.toLowerCase().startsWith('image/')
      ? { type: 'input_image', image_url: url, detail: 'auto' }
      : { type: 'input_file', file_url: url, detail: 'auto' };
  },
};

// Renders a tool result for a function_call_output under the strict reading
// rule. Pure text collapses into a single string; anything binary stays a
// content array so images actually enter the model context.
export async function toolResultToModelOutput(result: ToolResult, functionName?: string): Promise<ModelOutput> {
  const parts: ModelContentPart[] = [];

  if (result.structuredContent !== undefined) {
    // structuredContent is primary: content blocks are not read at all.
    parts.push({ type: 'input_text', text: JSON.stringify(result.structuredContent) });

    const extra = functionName ? contextExtras[functionName]?.(asObject(result.structuredContent)) : null;

    if (extra) {
      parts.push(extra);
    }
  } else {
    for (const block of result.content ?? []) {
      parts.push(rawBlockToModelContent(block));
    }
  }

  const hasNonText = parts.some(part => part.type !== 'input_text');

  if (hasNonText) {
    return parts;
  }

  const text = parts
    .map(part => (part.type === 'input_text' ? part.text : ''))
    .join('\n')
    .trim();

  return text || 'OK';
}
