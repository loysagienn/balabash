// The model view of a catalog result. Messages requires all tool_result
// blocks first, with the notes for newly referenced definitions after them.
import type Anthropic from '@anthropic-ai/sdk';
import type { CatalogResult } from '../turn-contract.ts';

export function openingBlocks(callId: string, name: string, text: string) {
  const result: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: callId,
    content: [{ type: 'tool_reference', tool_name: name }],
  };
  const note: Anthropic.TextBlockParam = { type: 'text', text: `Opened: ${name}\n${text}` };

  return { result, note };
}

export function catalogBlocks(callId: string, outcome: CatalogResult): {
  result: Anthropic.ToolResultBlockParam;
  note?: Anthropic.TextBlockParam;
} {
  if (outcome.definition) return openingBlocks(callId, outcome.definition.name, outcome.text);

  const { attachment } = outcome;
  const result: Anthropic.ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: callId,
    content: outcome.text,
    ...(outcome.isError ? { is_error: true } : {}),
  };
  if (attachment) {
    const source = { type: 'url' as const, url: attachment.url };
    result.content = [
      { type: 'text', text: outcome.text },
      attachment.kind === 'image' ? { type: 'image', source } : { type: 'document', source },
    ];
  }
  return { result };
}
