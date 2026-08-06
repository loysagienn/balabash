// Canonical content (§9) → OpenAI Responses shapes. The only place where
// provider conversion happens on the OpenAI side: tool results are stored in
// the log as canonical blocks, and file references are materialized into
// presigned URLs here, at the moment the model actually needs them.

import type { ContentBlock, ToolResult } from '../../core/contract.ts';
import { getFile, getFileDownloadUrl } from '../../files/index.ts';

export type ModelContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; file_url: string; detail: 'auto' };

export type ModelOutput = string | ModelContentPart[];

async function toModelContent(block: ContentBlock): Promise<ModelContentPart> {
  switch (block.type) {
    case 'text':
      return { type: 'input_text', text: block.text };

    case 'image': {
      const { url } = await getFileDownloadUrl(block.fileId);

      return { type: 'input_image', image_url: url, detail: 'auto' };
    }

    case 'file': {
      const file = await getFile(block.fileId);
      const { url } = await getFileDownloadUrl(block.fileId);

      if (file.contentType?.toLowerCase().startsWith('image/')) {
        return { type: 'input_image', image_url: url, detail: 'auto' };
      }

      // No filename alongside file_url: the Responses API rejects the pair as
      // mutually exclusive (filename only accompanies file_data). The name
      // still reaches the model via the tool's structured metadata.
      return { type: 'input_file', file_url: url, detail: 'auto' };
    }

    case 'resource_link': {
      if (/^https?:\/\//i.test(block.uri) && block.mimeType?.toLowerCase().startsWith('image/')) {
        return { type: 'input_image', image_url: block.uri, detail: 'auto' };
      }

      if (/^https?:\/\//i.test(block.uri) && block.mimeType) {
        return { type: 'input_file', file_url: block.uri, detail: 'auto' };
      }

      return {
        type: 'input_text',
        text: JSON.stringify({ type: 'resource_link', uri: block.uri, name: block.name, mimeType: block.mimeType }),
      };
    }
  }
}

// Renders a canonical tool result for a function_call_output. Pure text
// results collapse into a single string; anything with binary content stays
// a content array so images actually enter the model context.
export async function toolResultToModelOutput(result: ToolResult): Promise<ModelOutput> {
  const parts: ModelContentPart[] = [];

  if (result.structuredContent !== undefined) {
    parts.push({ type: 'input_text', text: JSON.stringify(result.structuredContent) });
  }

  for (const block of result.content) {
    parts.push(await toModelContent(block));
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
