// In-process MCP bridge (§8.2): exposes the run's ToolsApi bundle plus the
// agent's bridge-only tools to the inner SDK session. Port of the v1
// discussion bridge with the conversion simplified under the canon (§9):
// canonical ContentBlocks map straight to MCP content, file references are
// materialized from files on demand — the v1 MCP→OpenAI→MCP round-trip is
// gone.

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  ContentBlock,
  FilesApi,
  JsonObject,
  SdkBridgeTool,
  ToolDefinition,
  ToolResult,
  ToolsApi,
} from '../../core/contract.ts';

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inputSchema(parameters: Record<string, unknown>) {
  return z.fromJSONSchema(parameters as never);
}

// Images are inlined as base64 for the inner model; other binary refs become
// text references with a presigned URL the model can relay. Materialization
// is lazy by construction: it happens only when a tool result actually
// reaches the session.
const IMAGE_INLINE_LIMIT_BYTES = 5 * 1024 * 1024;

async function blockToMcpContent(block: ContentBlock, files: FilesApi): Promise<McpContent> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'image': {
      try {
        const info = await files.getInfo(block.fileId);

        if (info.sizeBytes !== null && info.sizeBytes > IMAGE_INLINE_LIMIT_BYTES) {
          throw new Error(`image is too large to inline (${info.sizeBytes} bytes)`);
        }

        const url = await files.getDownloadUrl(block.fileId);
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`download failed: HTTP ${response.status}`);
        }

        const data = Buffer.from(await response.arrayBuffer()).toString('base64');

        return { type: 'image', data, mimeType: info.contentType ?? 'image/png' };
      } catch (error) {
        return { type: 'text', text: `[image fileId=${block.fileId}: ${getErrorMessage(error)}]` };
      }
    }

    case 'file': {
      try {
        const info = await files.getInfo(block.fileId);
        const url = await files.getDownloadUrl(block.fileId);

        return {
          type: 'text',
          text: `[file${info.filename ? ` ${info.filename}` : ''} fileId=${block.fileId}] ${url}`,
        };
      } catch (error) {
        return { type: 'text', text: `[file fileId=${block.fileId}: ${getErrorMessage(error)}]` };
      }
    }

    case 'resource_link':
      return { type: 'text', text: `[${block.name ?? 'resource'}] ${block.uri}` };
  }
}

async function toMcpResult(result: ToolResult, files: FilesApi) {
  const content = await Promise.all(result.content.map(block => blockToMcpContent(block, files)));

  if (!content.length && !result.structuredContent) {
    content.push({ type: 'text', text: '(empty result)' });
  }

  return {
    content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

async function bridgeOutputToMcpContent(output: string | ContentBlock[], files: FilesApi): Promise<McpContent[]> {
  if (typeof output === 'string') {
    return [{ type: 'text', text: output || '(empty result)' }];
  }

  const content = await Promise.all(output.map(block => blockToMcpContent(block, files)));

  return content.length ? content : [{ type: 'text', text: '(empty result)' }];
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
  files: FilesApi;
  extraTools: SdkBridgeTool[];
};

export async function createBridgeServer({ tools, files, extraTools }: BridgeOptions): Promise<BridgeServer> {
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

  const run = async (action: () => Promise<{ content: McpContent[]; structuredContent?: JsonObject }>) => {
    try {
      return await action();
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${getErrorMessage(error)}` }],
        isError: true,
      };
    }
  };

  // Bridge-only tools are fixed for the session's lifetime and shadow
  // same-named catalog tools.
  for (const tool of extraTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: inputSchema(tool.inputSchema) },
      args =>
        run(async () => ({
          content: await bridgeOutputToMcpContent(await tool.handler(args as JsonObject), files),
        })),
    );
  }

  // Handlers dispatch by name at call time, so a definition update between
  // syncs keeps working without re-registration.
  const callBridgeTool = async (name: string, args: JsonObject) => {
    if (!entries.has(name)) {
      throw new Error(`Tool "${name}" is no longer available`);
    }

    return toMcpResult(await tools.call(name, args), files);
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
          args => run(() => callBridgeTool(name, args as JsonObject)),
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
