// In-process MCP bridge (§8.2): exposes the run's ToolsApi bundle plus the
// agent's bridge-only tools to the inner SDK session. The bridge is a
// pass-through, not a projection (§9): a live tool result goes to the inner
// session exactly as the server produced it — raw MCP content, base64 and
// isError included, nothing re-encoded or padded. Bridge-only tools follow
// the birth contract (data or throw) and are shaped by the platform wrapper.

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { JsonObject, SdkBridgeTool, ToolDefinition, ToolsApi } from '../../core/contract.ts';
import { runToolHandler, toErrorResult } from '../../capabilities/tool-result.ts';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inputSchema(parameters: Record<string, unknown>) {
  return z.fromJSONSchema(parameters as never);
}

type BridgeEntry = {
  definition: ToolDefinition;
  registered: RegisteredTool;
};

function definitionFingerprint(definition: ToolDefinition): string {
  return JSON.stringify({ description: definition.description, parameters: definition.inputSchema });
}

export type BridgeServer = {
  server: McpServer;
  // Re-diff the exposed set against ToolsApi; serialized, never rejects.
  syncTools: () => Promise<void>;
};

type BridgeOptions = {
  tools: ToolsApi;
  extraTools: SdkBridgeTool[];
};

export async function createBridgeServer({ tools, extraTools }: BridgeOptions): Promise<BridgeServer> {
  const server = new McpServer({ name: 'balabash', version: '2.0.0' }, { capabilities: { tools: {} } });
  const entries = new Map<string, BridgeEntry>();
  const extraNames = new Set(extraTools.map(tool => tool.name));
  const warnedNames = new Set<string>();

  const warnOnce = (name: string, message: string) => {
    if (!warnedNames.has(name)) {
      warnedNames.add(name);
      console.warn(`[sdk-bridge] ${message}`);
    }
  };

  // Bridge-only tools are fixed for the session's lifetime and shadow
  // same-named catalog tools. Their handlers follow the birth contract (data
  // or throw); the platform wrapper shapes the structured result, errors
  // included.
  for (const tool of extraTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: inputSchema(tool.inputSchema) },
      args => runToolHandler(() => tool.handler(args as JsonObject)),
    );
  }

  // Handlers dispatch by name at call time, so a definition update between
  // syncs keeps working without re-registration. Pass-through: the live
  // result goes to the inner session as-is; breakage of the call itself
  // becomes the same structured error convert.
  const callBridgeTool = async (name: string, args: JsonObject) => {
    if (!entries.has(name)) {
      throw new Error(`Tool "${name}" is no longer available`);
    }

    const result = await tools.call(name, args);

    // The cast is the pass-through: the verbatim result crosses into the MCP
    // SDK's stricter static shape unchanged.
    return { ...result, content: result.content ?? [] } as CallToolResult;
  };

  const listDesired = async (): Promise<Map<string, ToolDefinition>> => {
    const desired = new Map<string, ToolDefinition>();

    for (const definition of await tools.list()) {
      if (extraNames.has(definition.name)) {
        warnOnce(definition.name, `catalog tool "${definition.name}" is shadowed by a bridge tool and not exposed`);
        continue;
      }

      desired.set(definition.name, definition);
    }

    return desired;
  };

  // A schema this MCP SDK cannot express must not kill the session: every
  // register/update is isolated per tool, and a broken tool is skipped or
  // hidden until its definition changes again.
  const applyDesired = (desired: Map<string, ToolDefinition>) => {
    for (const [name, entry] of entries) {
      const next = desired.get(name);

      if (!next) {
        if (entry.registered.enabled) {
          entry.registered.disable();
        }
        continue;
      }

      desired.delete(name);

      try {
        if (definitionFingerprint(entry.definition) !== definitionFingerprint(next)) {
          entry.registered.update({
            description: next.description,
            paramsSchema: inputSchema(next.inputSchema) as never,
            enabled: true,
          });
          entry.definition = next;
        } else if (!entry.registered.enabled) {
          entry.registered.enable();
        }
      } catch (error) {
        console.error(`[sdk-bridge] failed to update bridge tool "${name}": ${getErrorMessage(error)}`);
        try {
          entry.registered.disable();
        } catch {
          // A tool that cannot even be disabled is left as-is.
        }
      }
    }

    for (const [name, next] of desired) {
      try {
        const registered = server.registerTool(
          name,
          { description: next.description, inputSchema: inputSchema(next.inputSchema) },
          args => callBridgeTool(name, args as JsonObject).catch(error => toErrorResult(error)),
        );

        entries.set(name, { definition: next, registered });
      } catch (error) {
        console.error(`[sdk-bridge] skipping bridge tool "${name}": ${getErrorMessage(error)}`);
      }
    }
  };

  // Serialized: concurrent syncs would race on registration. Errors are
  // swallowed after logging, so the returned promise never rejects and the
  // chain never sticks in a rejected state.
  let syncChain = Promise.resolve();
  const syncTools = (): Promise<void> => {
    syncChain = syncChain
      .then(async () => applyDesired(await listDesired()))
      .catch(error => console.error(`[sdk-bridge] tool sync failed: ${getErrorMessage(error)}`));
    return syncChain;
  };

  // The initial population is strict on purpose: per-tool errors are still
  // skipped, but a catalog that cannot be listed at all fails the run start
  // loudly instead of opening a session with no tools.
  applyDesired(await listDesired());

  return { server, syncTools };
}
