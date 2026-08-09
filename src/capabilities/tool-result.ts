// The birth wrapper of the tool-result contour (§9): our tools return data
// or throw; this platform wrapper shapes the outgoing result. Structured
// only: an object travels as structuredContent verbatim, a primitive/array
// wraps as {result: value}, a thrown error becomes {error: {message,
// details?}} with isError — no text mirroring, no content blocks, no bytes.
// Lives in capabilities, not core/contract.ts: the contract is types-only
// (the bundle/ESM boundary).

import type { JsonObject, JsonValue } from '../core/contract.ts';

// A structured result never carries content blocks. The literal `content: []`
// type keeps the shape assignable both to the platform's ToolResult and to
// the MCP SDK's CallToolResult in local tool servers (tools/*.ts).
export type StructuredToolResult = {
  content: [];
  structuredContent: JsonObject;
  isError?: boolean;
};

// A deliberate tool error with optional structured details for the model.
// Plain Error works too — it just has no details.
export class ToolError extends Error {
  override name = 'ToolError';
  details?: JsonValue;

  constructor(message: string, details?: JsonValue) {
    super(message);

    if (details !== undefined) {
      this.details = details;
    }
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The data the author returned, as the wire result. The author owns the
// shape; the wrapper only guarantees "structuredContent is an object".
export function toStructuredResult(data: unknown): StructuredToolResult {
  return {
    content: [],
    structuredContent: isPlainObject(data) ? data : { result: (data ?? null) as JsonValue },
  };
}

// The error the author threw, as a structured error result. ToolError is
// detected structurally, not by instanceof: dynamic capabilities (native
// import world) may carry a second copy of the class.
export function toErrorResult(error: unknown): StructuredToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof Error && error.name === 'ToolError' && 'details' in error
      ? (error as ToolError).details
      : undefined;

  return {
    content: [],
    structuredContent: { error: { message, ...(details !== undefined ? { details } : {}) } },
    isError: true,
  };
}

// Runs one tool handler under the birth contract: data or throw in, a
// structured result out — errors included ("the tool answered, albeit with an
// error"). Breakage of the call itself (unknown tool, transport) stays a
// throw at the call site, outside the handler.
export async function runToolHandler(handler: () => unknown): Promise<StructuredToolResult> {
  try {
    return toStructuredResult(await handler());
  } catch (error) {
    return toErrorResult(error);
  }
}
