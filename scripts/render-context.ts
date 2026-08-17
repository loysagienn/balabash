// The instruction-layer showcase: materializes, per model, what that model
// actually sees — the assembled system prompt and the descriptions of its
// real tool bundle — into one readable markdown file per agent plus one for
// the coordinator (the secretary). The showcase is the verification
// instrument for any work on prompts and tool descriptions: run it before
// and after a change and diff the output.
//
// It walks the same code paths as the live app (agent catalog, tool-manager
// bundles, session-run base verbs, coordinator function definitions), so the
// output is the truth, not a retelling. Connecting per-user servers (gmail,
// notion) may hit the network; a server that fails to connect is reported in
// the output instead of failing the run.
//
// Usage: npm run build && npm run render-context [-- <userId>]
//   Output: data/showcase/<name>.md (overwritten on every run).
//   With no userId the single workspace user is used; with several users the
//   script lists them and exits.
//
// Read-only by intent: it renders texts and never journals events, spawns
// threads or calls tools. (Connecting user-auth servers may refresh their
// OAuth tokens through the shared connections layer — same as any app turn.)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDeclaration, ToolDefinition } from '../src/core/contract.ts';
import { prisma } from '../src/db/client.ts';
import { getFile, getFileDownloadUrl, ingestFile, openFileContent } from '../src/files/index.ts';
import { getAgents, loadAgents } from '../src/capabilities/agent-catalog.ts';
import { createAuthToolServer } from '../src/capabilities/auth-tools.ts';
import { createEventsToolServer, createStorageToolServer } from '../src/capabilities/builtin-tools.ts';
import { createRestartToolServer } from '../src/capabilities/restart-tools.ts';
import { describeSessionBridgeTools } from '../src/capabilities/session-run.ts';
import {
  getServerToolFunctions,
  loadToolServers,
  registerBuiltinToolServer,
  type ToolBundle,
} from '../src/capabilities/tool-manager.ts';
import { createScheduleToolServer } from '../src/schedule/tools.ts';
import { createProjectsToolServer } from '../src/projects/tools.ts';
import { buildStatusText } from '../src/coordinator/index.ts';
import { COORDINATOR_INSTRUCTIONS } from '../src/coordinator/instructions.ts';
import { getCoordinatorFunctionDefinitions } from '../src/coordinator/functions.ts';

const OUT_DIR = path.resolve('data', 'showcase');

// ---------------------------------------------------------------------------
// Placeholder for initialMessage templates: every agent's spawn input is one
// text prompt, so one placeholder shows any template's real shape.

const SAMPLE_PROMPT = '<prompt>';

// ---------------------------------------------------------------------------
// Rendering

function renderTool(tool: ToolDefinition & { serverName?: string }): string {
  return [
    `### ${tool.name}${tool.serverName ? `  _(server: ${tool.serverName})_` : ''}`,
    '',
    tool.description,
    '',
    '```json',
    JSON.stringify(tool.inputSchema, null, 2),
    '```',
  ].join('\n');
}

function renderSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

async function renderBundleTools(userId: string, bundle: ToolBundle): Promise<string> {
  const functions = await getServerToolFunctions(userId, bundle);

  if (!functions.length) {
    return '(no server tools in this bundle)';
  }

  return functions
    .map(fn =>
      renderTool({
        name: fn.functionName,
        serverName: fn.serverName,
        description: fn.description,
        inputSchema: fn.inputSchema as ToolDefinition['inputSchema'],
      }),
    )
    .join('\n\n');
}

async function renderAgent(declaration: AgentDeclaration, userId: string): Promise<string> {
  const bundle: ToolBundle = {
    declared: declaration.tools,
  };

  const header = [
    `# Agent: ${declaration.name}`,
    '',
    `- sdk: ${declaration.sdk}`,
    `- tools bundle: ${JSON.stringify(declaration.tools)}`,
    ...(declaration.agents?.length ? [`- spawnable sub-agents: ${declaration.agents.join(', ')}`] : []),
    ...(declaration.headless ? ['- headless: no forum topic, talks only to its operator'] : []),
    ...(declaration.session?.model ? [`- model: ${declaration.session.model}`] : []),
    ...(declaration.session?.effort ? [`- effort: ${declaration.session.effort}`] : []),
    ...(declaration.session?.preset ? [`- preset: ${declaration.session.preset}`] : []),
  ].join('\n');

  const spawnSurface = renderSection(
    'Spawn surface (what the spawner reads: agent.description; the input is one text prompt)',
    declaration.description,
  );

  const sections: string[] = [header, spawnSurface];

  if (declaration.session) {
    sections.push(renderSection('System prompt (session.instructions)', declaration.session.instructions));

    sections.push(
      renderSection(
        `Initial message (${declaration.session.initialMessage ? 'declaration template' : 'platform default: the prompt verbatim'}, rendered with a placeholder prompt)`,
        declaration.session.initialMessage ? declaration.session.initialMessage(SAMPLE_PROMPT) : SAMPLE_PROMPT,
      ),
    );
    sections.push(
      renderSection(
        'Bridge base verbs (session-run)',
        describeSessionBridgeTools(declaration).map(renderTool).join('\n\n'),
      ),
    );
  } else {
    sections.push(
      renderSection(
        'System prompt',
        `(imperative run() agent — its instructions are assembled at run start inside agents/${declaration.name}.ts ` +
          'and are not renderable offline; in-run tools like the Playwright surface come from live connections)',
      ),
    );
  }

  let bundleTools: string;

  try {
    bundleTools = await renderBundleTools(userId, bundle);
  } catch (error) {
    bundleTools = `(failed to assemble the bundle: ${error instanceof Error ? error.message : String(error)})`;
  }

  sections.push(renderSection('Tool bundle (tool-manager)', bundleTools));

  return `${sections.join('\n\n')}\n`;
}

async function renderCoordinator(userId: string): Promise<string> {
  const sections = [
    '# Coordinator (the secretary)',
    renderSection('Instructions (prompt-cache head)', COORDINATOR_INSTRUCTIONS),
    renderSection(
      'Status tail (format sample, rendered fresh every turn)',
      `\`\`\`\n${buildStatusText([], [])}\n\`\`\``,
    ),
  ];

  let functionsSection: string;

  try {
    const definitions = await getCoordinatorFunctionDefinitions(userId);

    functionsSection = definitions
      .map(definition =>
        renderTool({
          name: definition.name,
          description: definition.description ?? '',
          inputSchema: definition.parameters as ToolDefinition['inputSchema'],
        }),
      )
      .join('\n\n');
  } catch (error) {
    functionsSection = `(failed to assemble the function catalog: ${error instanceof Error ? error.message : String(error)})`;
  }

  sections.push(renderSection('Function catalog (static + agent spawns + tool servers)', functionsSection));

  return `${sections.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------

async function resolveUserId(): Promise<string> {
  const fromArgv = process.argv[2]?.trim();

  if (fromArgv) {
    return fromArgv;
  }

  const users = await prisma.user.findMany({ select: { id: true } });

  if (users.length === 1) {
    return users[0].id;
  }

  if (!users.length) {
    throw new Error('no users in the database — pass a userId explicitly');
  }

  throw new Error(`several users in the database — pass one explicitly: ${users.map(user => user.id).join(', ')}`);
}

const userId = await resolveUserId();

loadAgents();

registerBuiltinToolServer(createAuthToolServer());
registerBuiltinToolServer(createRestartToolServer());
registerBuiltinToolServer(createStorageToolServer());
registerBuiltinToolServer(createEventsToolServer());
registerBuiltinToolServer(createScheduleToolServer());
registerBuiltinToolServer(createProjectsToolServer());

await loadToolServers({
  filesApi: {
    ingest: input => ingestFile(input),
    get: fileId => getFile(fileId),
    getDownloadUrl: (fileId, options) => getFileDownloadUrl(fileId, options),
    open: fileId => openFileContent(fileId),
  },
});

await mkdir(OUT_DIR, { recursive: true });

const written: string[] = [];

const coordinatorPath = path.join(OUT_DIR, 'coordinator.md');

await writeFile(coordinatorPath, await renderCoordinator(userId), 'utf8');
written.push(coordinatorPath);

for (const declaration of getAgents()) {
  const filePath = path.join(OUT_DIR, `${declaration.name}.md`);

  await writeFile(filePath, await renderAgent(declaration, userId), 'utf8');
  written.push(filePath);
}

console.log(`[render-context] user ${userId}; written:\n${written.map(file => `  ${file}`).join('\n')}`);

await prisma.$disconnect();

// Local tool servers keep loopback HTTP servers alive; the render is done.
process.exit(0);
