// The inner loop of one model turn over the Anthropic Messages API (§8.1) —
// the twin of src/harness/openai/turn.ts under the same contract
// (../turn-contract.ts), with the differences the API dictates:
//
// - tool_choice is 'auto': the current Claude models reject forced tool use
//   (`any` returns 400), so the model may answer in text, and the turn ends
//   when a response carries no tool calls (stop_reason end_turn). A text
//   block in a response IS the model's message to the user — delivered
//   through `deliverText` (the coordinator journals it as its agent.message,
//   exactly what send_message does) before the response's tool calls are
//   dispatched. An 'end' dispatch (do_nothing, when the catalog still
//   offers it) ends the turn too.
// - Iterations are stateless: every request carries the whole conversation
//   — the prompt's chunks, then the status, then each response's content
//   echoed back verbatim (thinking blocks included, the API needs them
//   unchanged) followed by all its tool results in one user message.
// - The prompt cache is a prefix match at explicit breakpoints: one on the
//   instructions (the end of the static head: tools + system), one on the
//   last frozen chunk — both with the 1-hour TTL (backend.ts). The status
//   rides after the chunks as a mid-conversation system message, so its
//   change every turn costs nothing cached. The prewarm ping is the same
//   request with max_tokens: 0 — the API runs prefill, writes or refreshes
//   the breakpoints and generates nothing. The two share one request
//   builder on purpose — any parameter that differs between them would be a
//   different cache entry.

import type Anthropic from '@anthropic-ai/sdk';
import type { EffortLevel } from '../../core/contract.ts';
import { config } from '../../config/index.ts';
import { MAX_TURN_ITERATIONS } from '../turn-contract.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition, RequestHead, TurnOutcome, TurnPrompt } from '../turn-contract.ts';
import { getAnthropicClient } from './client.ts';
import { toolResultToContent } from './content.ts';
import type { startLlmRequestMetrics } from './llm-metrics.ts';

// Room for the thinking and the tool calls of one response; a response cut
// here is a failure (its tool inputs may be truncated), not a retry point.
const MAX_OUTPUT_TOKENS = 16_000;

// The one breakpoint shape of the thread's prefix. The longer TTL must come
// first in the request, and both breakpoints share it.
const CACHE_BREAKPOINT: Anthropic.CacheControlEphemeral = { type: 'ephemeral', ttl: '1h' };

type Head = RequestHead & { effort: EffortLevel };

// What the loop needs of the Anthropic client — the SDK client satisfies
// it, a scripted fake in tests too.
export type AnthropicTurnClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

// Strict mode compiles the schemas server-side and caps union-typed
// parameters (type arrays, anyOf) at 16 across the whole request — the
// catalog's nullable optionals (`type: ['array', 'null']`, the Responses
// API's strict idiom) exceed that at once. So a tool is strict only when its
// schema has no unions; the others keep their schema and lose only the
// server-side argument guarantee (an invalid call is still rejected by the
// dispatcher and seen by the model).
function hasUnionTypes(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some(hasUnionTypes);
  }

  if (!schema || typeof schema !== 'object') {
    return false;
  }

  const node = schema as Record<string, unknown>;

  if (Array.isArray(node.type) || Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    return true;
  }

  return Object.values(node).some(hasUnionTypes);
}

function toTool(definition: FunctionDefinition): Anthropic.Tool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.parameters as Anthropic.Tool.InputSchema,
    strict: definition.strict && !hasUnionTypes(definition.parameters),
  };
}

// The prompt in Messages API shape: each frozen chunk a user message (the
// last one carrying the cache breakpoint), the volatile status a system
// message after them — it must follow a user message and be last or be
// followed by an assistant turn, which the loop's echoes satisfy.
function toMessages({ chunks, statusText }: TurnPrompt): Anthropic.MessageParam[] {
  return [
    ...chunks.map((text, index) => ({
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text,
          ...(index === chunks.length - 1 ? { cache_control: CACHE_BREAKPOINT } : {}),
        },
      ],
    })),
    { role: 'system' as const, content: statusText },
  ];
}

// The request parameters shared by every call of a thread: the prompt-cache
// prefix depends on them (model, instructions, tools, effort), so turns and
// prewarm pings must agree byte for byte. Thinking stays at the model's
// own default (adaptive, always on for the current models), depth through
// effort.
function baseRequest({ model, instructions, tools, effort }: Head, messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: instructions, cache_control: CACHE_BREAKPOINT }],
    tools: tools.map(toTool),
    tool_choice: { type: 'auto' },
    output_config: { effort },
    messages,
  };
}

type RunTurnOptions = RequestHead & {
  prompt: TurnPrompt;
  metrics: ReturnType<typeof startLlmRequestMetrics>;
  dispatch: (call: FunctionCall) => Promise<DispatchResult>;
  // A text block of a response: the model's message to the user, delivered
  // before the tool calls of the same response are dispatched.
  deliverText: (text: string) => Promise<void>;
  // Test seam: the client and the effort, the configured ones by default.
  deps?: {
    client?: AnthropicTurnClient;
    effort?: EffortLevel;
  };
};

function describeStop(message: Anthropic.Message): string {
  const details = message.stop_details;

  return details ? `${message.stop_reason} (${details.category ?? 'uncategorized'}: ${details.explanation ?? 'no explanation'})` : String(message.stop_reason);
}

export async function runTurn({ model, instructions, tools, prompt, metrics, dispatch, deliverText, deps }: RunTurnOptions): Promise<TurnOutcome> {
  const client: AnthropicTurnClient = deps?.client ?? getAnthropicClient();
  const head: Head = { model, instructions, tools, effort: deps?.effort ?? config.coordinatorEffort };

  const messages: Anthropic.MessageParam[] = toMessages(prompt);
  let firstResponseId: string | undefined;

  for (let iteration = 1; ; iteration += 1) {
    if (iteration > MAX_TURN_ITERATIONS) {
      throw new Error(`turn did not end within ${MAX_TURN_ITERATIONS} iterations (the model kept calling tools)`);
    }

    const response = await metrics.measure(() => client.messages.create(baseRequest(head, messages)));

    firstResponseId ??= response.id;

    // A cut response may carry truncated tool inputs; a refusal carries
    // nothing to act on. Both are the turn's failure, journaled by the
    // coordinator.
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal' || response.stop_reason === 'model_context_window_exceeded') {
      throw new Error(`Anthropic response ${response.id} stopped: ${describeStop(response)}`);
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (text) {
      await deliverText(text);
    }

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');

    // No calls: the model has said what it had to say (or nothing) — the
    // turn is over.
    if (!toolUses.length) {
      return { firstResponseId };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let ended = false;

    for (const toolUse of toolUses) {
      const outcome = await dispatch({
        callId: toolUse.id,
        name: toolUse.name,
        arguments: JSON.stringify(toolUse.input ?? {}),
      });

      switch (outcome.kind) {
        case 'sync':
          results.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: toolResultToContent(outcome.result, toolUse.name),
            ...(outcome.result.isError ? { is_error: true } : {}),
          });
          break;

        case 'async':
          results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: 'accepted' });
          break;

        case 'rejected':
          // The model must see the rejection and gets the chance to recover
          // within the same turn.
          results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: `rejected: ${outcome.error}`, is_error: true });
          break;

        case 'end':
          ended = true;
          break;
      }
    }

    if (ended) {
      return { firstResponseId };
    }

    // The response echoed back verbatim (thinking blocks included), then all
    // its tool results in one user message — the shape the API expects.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
  }
}

type PrewarmOptions = RequestHead & {
  prompt: TurnPrompt;
  metrics: ReturnType<typeof startLlmRequestMetrics>;
};

/**
 * Refreshes the prompt-cache prefix of a thread: the same request as a
 * turn's first one with max_tokens: 0 — the API runs prefill, writes or
 * reads the breakpoints and generates nothing. On a warm prefix this is a
 * cache read that restarts the TTL; on a cold one it writes the prefix,
 * which the next real turn then finds warm. Returns the message id.
 */
export async function prewarmPrompt({ model, instructions, tools, prompt, metrics }: PrewarmOptions): Promise<string> {
  const client = getAnthropicClient();
  const head: Head = { model, instructions, tools, effort: config.coordinatorEffort };

  const response = await metrics.measure(() => client.messages.create({ ...baseRequest(head, toMessages(prompt)), max_tokens: 0 }));

  return response.id;
}
