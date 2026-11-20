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
//   dispatched.
// - Iterations are stateless: every request carries the whole conversation
//   — the prompt's chunks, then the status, then each response's content
//   echoed back verbatim (thinking blocks included, the API needs them
//   unchanged) followed by all its tool results in one user message.
// - The prompt cache is a prefix match at explicit breakpoints: one on the
//   instructions (the end of the static head: tools + system), the last
//   two chunks and any trailing opening, all with the 1-hour TTL. The status
//   rides after the chunks as a mid-conversation system message, so its
//   change every turn costs nothing cached. The prewarm ping is the same
//   request without the status and with max_tokens: 0 — the API runs
//   prefill, writes or refreshes the breakpoints and generates nothing. The
//   two share one request builder on purpose — any parameter that differs
//   between them ahead of the last breakpoint would be a different cache
//   entry; the status after it is the one thing a ping leaves out.

import type Anthropic from '@anthropic-ai/sdk';
import type { EffortLevel } from '../../core/contract.ts';
import { config } from '../../config/index.ts';
import { MAX_TURN_ITERATIONS } from '../turn-contract.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition, PrewarmPrompt, RequestHead, TurnOutcome, TurnPrompt } from '../turn-contract.ts';
import { getAnthropicClient } from './client.ts';
import { catalogBlocks, openingBlocks } from './content.ts';
import type { startLlmRequestMetrics } from './llm-metrics.ts';

// Room for the thinking and the tool calls of one response; a response cut
// here is a failure (its tool inputs may be truncated), not a retry point.
const MAX_OUTPUT_TOKENS = 16_000;

// All breakpoints of the thread's prefix share a TTL.
const CACHE_BREAKPOINT: Anthropic.CacheControlEphemeral = { type: 'ephemeral', ttl: '1h' };

type Head = RequestHead & { effort: EffortLevel };

// What the loop needs of the Anthropic client — the SDK client satisfies
// it, a scripted fake in tests too.
export type AnthropicTurnClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
};

function toTool(definition: FunctionDefinition): Anthropic.Tool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.parameters as Anthropic.Tool.InputSchema,
  };
}

export function deferredTool(definition: FunctionDefinition): Anthropic.Tool {
  return { ...toTool(definition), defer_loading: true };
}

// The turn snapshot contains only earlier openings. This turn's original
// tool_use is echoed live and first replayed in a later turn or keepalive.
function toMessages({ chunks, openings = [], statusText }: PrewarmPrompt & { statusText?: string }): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let tail: Anthropic.TextBlockParam | undefined;
  for (const [index, text] of chunks.entries()) {
    tail = { type: 'text', text };
    // The previous turn wrote its last chunk. Look it up directly even
    // when the replayed openings put it outside the API's 20-block window.
    if (index >= chunks.length - 2) tail.cache_control = CACHE_BREAKPOINT;
    messages.push({ role: 'user', content: [tail] });
    for (const opening of openings.filter(entry => entry.afterChunk === index + 1)) {
      const { callId, definition: { name } } = opening;
      const { result, note } = openingBlocks(callId, name, opening.text);
      messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'describe', input: { name } }] },
        { role: 'user', content: [result, note] },
      );
      tail = note;
    }
  }
  if (tail) tail.cache_control = CACHE_BREAKPOINT;
  if (statusText !== undefined) messages.push({ role: 'system', content: statusText });
  return messages;
}

// The request parameters shared by every call of a thread: the prompt-cache
// prefix depends on them (model, instructions, tools, effort), so turns and
// prewarm pings must agree byte for byte. Thinking stays at the model's
// own default (adaptive, always on for the current models), depth through
// effort.
function baseRequest({ model, instructions, tools, deferredTools = [], effort }: Head, messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: instructions, cache_control: CACHE_BREAKPOINT }],
    tools: [...tools.map(toTool), ...deferredTools.map(deferredTool)],
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

export async function runTurn({ model, instructions, tools, deferredTools, prompt, metrics, dispatch, deliverText, deps }: RunTurnOptions): Promise<TurnOutcome> {
  const client: AnthropicTurnClient = deps?.client ?? getAnthropicClient();
  const head: Head = { model, instructions, tools, deferredTools, effort: deps?.effort ?? config.coordinatorEffort };

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
    const notes: Anthropic.TextBlockParam[] = [];

    for (const toolUse of toolUses) {
      const outcome = await dispatch({
        callId: toolUse.id,
        name: toolUse.name,
        arguments: JSON.stringify(toolUse.input ?? {}),
      });

      if (outcome.kind !== 'catalog') throw new Error(`Unexpected Anthropic dispatch result: ${outcome.kind}`);
      const { result, note } = catalogBlocks(toolUse.id, outcome);
      results.push(result);
      if (note) notes.push(note);
    }

    // The response echoed back verbatim (thinking blocks included), then all
    // its tool results in one user message — the shape the API expects.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: [...results, ...notes] });
  }
}

type PrewarmOptions = RequestHead & {
  prompt: PrewarmPrompt;
  metrics: ReturnType<typeof startLlmRequestMetrics>;
  // Test seam: the client and the effort, the configured ones by default.
  deps?: {
    client?: AnthropicTurnClient;
    effort?: EffortLevel;
  };
};

/**
 * Refreshes the prompt-cache prefix of a thread: the same request as a
 * turn's first one up to the last breakpoint (the status after it is not
 * part of the prefix and stays home) with max_tokens: 0 — the API runs
 * prefill, writes or reads the breakpoints and generates nothing. On a warm prefix this is a
 * cache read that restarts the TTL; on a cold one it writes the prefix,
 * which the next real turn then finds warm. Returns the message id.
 */
export async function prewarmPrompt({ model, instructions, tools, deferredTools, prompt, metrics, deps }: PrewarmOptions): Promise<string> {
  const client: AnthropicTurnClient = deps?.client ?? getAnthropicClient();
  const head: Head = { model, instructions, tools, deferredTools, effort: deps?.effort ?? config.coordinatorEffort };

  const response = await metrics.measure(() => client.messages.create({ ...baseRequest(head, toMessages(prompt)), max_tokens: 0 }));

  return response.id;
}
