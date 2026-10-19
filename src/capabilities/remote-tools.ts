// The 'remote' builtin tool server: what an agent may ask of a remote
// agent's thread beyond the dialogue — today remote_fetch_file, a file of
// the session by path, stored in the workspace and shown in the thread
// (src/remote/engine.ts fetchRemoteFile). Granted to the coordinator and to
// the agents that may spawn remote kinds; the caller must own the thread
// (its parent, or the thread itself).

import type { JsonObject, JsonValue, ToolDefinition } from '../core/contract.ts';
import { fetchRemoteFile } from '../remote/engine.ts';
import type { ToolFunction } from './mcp-client.ts';
import type { BuiltinToolServer } from './tool-manager.ts';

export const REMOTE_SERVER_NAME = 'remote';

const REMOTE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'remote_fetch_file',
    description:
      'Fetch a file out of a remote agent’s session by its absolute path there: the file is stored in Balabash ' +
      'file storage and appears in the remote thread; the result names its fileId. Only for an active remote ' +
      'thread you own (your child). Fails while the session is asleep or when the path does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'The remote child thread whose session holds the file.' },
        path: { type: 'string', description: 'The absolute path of the file inside the session.' },
      },
      required: ['threadId', 'path'],
      additionalProperties: false,
    },
  },
];

export function createRemoteToolServer(): BuiltinToolServer {
  const functions: ToolFunction[] = REMOTE_TOOL_DEFINITIONS.map(tool => ({
    functionName: tool.name,
    serverName: REMOTE_SERVER_NAME,
    toolName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));

  return {
    name: REMOTE_SERVER_NAME,
    functionNames: REMOTE_TOOL_DEFINITIONS.map(tool => tool.name),
    getFunctions: async () => functions,
    call: async (toolName: string, args: JsonObject, ctx): Promise<JsonValue> => {
      if (toolName !== 'remote_fetch_file') {
        throw new Error(`Unknown ${REMOTE_SERVER_NAME} tool "${toolName}"`);
      }

      const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
      const path = typeof args.path === 'string' ? args.path.trim() : '';

      if (!threadId || !path) {
        throw new Error('remote_fetch_file requires threadId and path');
      }

      const file = await fetchRemoteFile(threadId, path, { workspaceId: ctx.workspaceId, threadId: ctx.threadId });

      return { fileId: file.id, name: file.originalFilename, contentType: file.contentType, sizeBytes: file.sizeBytes };
    },
  };
}
