// The instruction-layer showcase: materializes, per model, what that model
// actually sees — the assembled system prompt and the descriptions of its
// real tool bundle — into one readable markdown file per agent plus one for
// the coordinator (the secretary). The showcase is the verification
// instrument for any work on prompts and tool descriptions: run it before
// and after a change and diff the output.
//
// The catalog ports build the same headers and definitions as a live turn.
//
// Usage: npm run build && npm run render-context [-- <workspaceId>]
//   Output: data/showcase/<name>.md (overwritten on every run).
//   With no workspaceId the single workspace is used; with several workspaces the
//   script lists them and exits.
//
// Read-only by intent: it renders texts and never journals events, spawns
// threads or calls capabilities.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDeclaration, RemoteAgentDeclaration } from '../src/core/contract.ts';
import type { FunctionDefinition } from '../src/harness/turn-contract.ts';
import { prisma } from '../src/db/client.ts';
import { extensionFilesApi } from '../src/files/index.ts';
import { getAgents, isRemoteAgent, loadAgents, repositoryAgentNames, startable } from '../src/capabilities/agent-catalog.ts';
import { loadRemoteAgents } from '../src/capabilities/remote-agent-source.ts';
import { createRemoteDriverContext } from '../src/capabilities/remote-agent-secrets.ts';
import { buildStatusText } from '../src/coordinator/index.ts';
import { createClaudePort } from '../src/harness/claude-sdk/bridge.ts';
import { createCodexPort } from '../src/harness/codex-sdk/catalog-bridge.ts';
import { deferredTool } from '../src/harness/anthropic/turn.ts';
import { openingBlocks } from '../src/harness/anthropic/content.ts';
import { coordinatorPort } from '../src/coordinator/port.ts';
import { getMainThread } from '../src/core/threads.ts';
import { startTree } from '../src/tree/index.ts';

const OUT_DIR = path.resolve('data', 'showcase');

// ---------------------------------------------------------------------------
// Placeholder for initialMessage templates: every agent's spawn input is one
// text prompt, so one placeholder shows any template's real shape.

const SAMPLE_PROMPT = '<prompt>';

// ---------------------------------------------------------------------------
// Rendering

function renderTool(tool: FunctionDefinition): string {
  return [
    `### ${tool.name}`,
    '',
    tool.description,
    '',
    '```json',
    JSON.stringify(tool.parameters, null, 2),
    '```',
  ].join('\n');
}

function renderSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

async function renderAgent(declaration: AgentDeclaration, workspaceId: string): Promise<string> {
  const children = startable(declaration.name).map(agent => agent.name);
  const header = [
    `# Agent: ${declaration.name}`,
    '',
    `- sdk: ${declaration.sdk}`,
    ...(children.length ? [`- spawnable sub-agents: ${children.join(', ')}`] : []),
    ...(declaration.defaultMode === 'headless' ? ['- headless: no user-facing thread, talks only to its operator'] : []),
    ...(declaration.session.model ? [`- model: ${declaration.session.model}`] : []),
    ...(declaration.session.effort ? [`- effort: ${declaration.session.effort}`] : []),
    ...(declaration.session.preset ? [`- preset: ${declaration.session.preset}`] : []),
  ].join('\n');

  const spawnSurface = renderSection(
    'Spawn surface (what the spawner reads: agent.description; the input is one text prompt)',
    declaration.description,
  );

  const sections: string[] = [header, spawnSurface];

  const makePort = declaration.sdk === 'codex' ? createCodexPort : createClaudePort;
  const port = await makePort(declaration, workspaceId, 'showcase');
  sections.push(renderSection('System prompt', declaration.session.instructions + '\n\n' + port.instructions));

  if (declaration.session.environment) {
    sections.push(
      renderSection(
        'Environment addendum',
        `(the declaration's environment starts per run — a browser, a server — and may append the facts that exist only ` +
          `then (an address, a path) to the prompt above; see agents/${declaration.name}.ts)`,
      ),
    );
  }

  sections.push(
    renderSection(
      `Initial message (${declaration.session.initialMessage ? 'declaration template' : 'platform default: the prompt verbatim'}, rendered with a placeholder prompt)`,
      declaration.session.initialMessage ? declaration.session.initialMessage(SAMPLE_PROMPT) : SAMPLE_PROMPT,
    ),
  );

  const definitions = port.tools.map(tool => [
    `### ${tool.name}`, tool.description, '\`\`\`json',
    JSON.stringify({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, _meta: tool._meta }, null, 2), '\`\`\`',
  ].join('\n'));
  sections.push(renderSection(declaration.sdk === 'codex' ? 'Catalog functions in exec (ALL_TOOLS)' : 'MCP catalog (alwaysLoad actions and deferred capabilities)', definitions.join('\n\n')));
  const samples: string[] = [];
  for await (const { name, result } of port.sampleOpenings()) {
    samples.push([`### ${name || '(root)'}`, '```json', JSON.stringify(result, null, 2), '```'].join('\n'));
  }
  sections.push(renderSection('First opening of each granted vertex', samples.join('\n\n')));
  return `${sections.join('\n\n')}\n`;
}

// A remote agent kind: the spawner reads the description and the options
// schema of the external system; there is no prompt and no bundle of ours.
function renderRemoteAgent(declaration: RemoteAgentDeclaration): string {
  const header = [
    `# Agent: ${declaration.name}`,
    '',
    '- kind: remote (the session runs in an external system; the thread mirrors it — src/remote/engine.ts)',
    `- modes: ${declaration.modes.join(', ')} (default: ${declaration.defaultMode})`,
    `- recipients: ${declaration.recipients?.join(', ') || '(none)'}`,
    ...(declaration.secrets?.length ? [`- secrets: ${declaration.secrets.join(', ')}`] : []),
    ...(declaration.notification ? [`- notification: ${declaration.notification}`] : []),
  ].join('\n');

  const sections = [
    header,
    renderSection('Spawn surface (what the spawner reads: description; the input is a prompt or a session to adopt)', declaration.description),
    renderSection(
      'Launch options (the schema the driver declares; every field optional)',
      declaration.options ? `\`\`\`json\n${JSON.stringify(declaration.options, null, 2)}\n\`\`\`` : '(none)',
    ),
  ];

  return `${sections.join('\n\n')}\n`;
}

async function renderCoordinator(workspaceId: string): Promise<string> {
  const main = await getMainThread(workspaceId);
  if (!main) throw new Error('The workspace has no main thread');
  const { head, sampleOpenings } = await coordinatorPort(workspaceId, main.id);
  const sections = [
    '# Coordinator (the secretary)',
    renderSection('Instructions (prompt-cache head)', head.instructions),
    renderSection(
      'Status tail (format sample, rendered fresh every turn)',
      `\`\`\`\n${buildStatusText([], [], workspaceId)}\n\`\`\``,
    ),
  ];

  const functionsSection = head.tools.map(renderTool).join('\n\n');
  sections.push(renderSection('Functions available at the start of the turn', functionsSection));

  const samples: string[] = [];
  for await (const { name, result } of sampleOpenings()) {
    const anthropic = 'deferredTools' in head;
    const parts = [`### ${name || '(root)'}`];
    if (anthropic && result.definition) {
      const { result: reference, note } = openingBlocks('describe', name, result.text);
      parts.push(JSON.stringify(reference.content), note.text);
    } else {
      parts.push(result.text);
    }
    if (result.definition) {
      const tool = anthropic ? deferredTool(result.definition) : result.definition;
      parts.push('```json\n' + JSON.stringify(tool, null, 2) + '\n```');
    }
    samples.push(parts.join('\n\n'));
  }
  sections.push(renderSection('First opening of each granted vertex', samples.join('\n\n')));

  return `${sections.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------

async function resolveWorkspaceId(): Promise<string> {
  const fromArgv = process.argv[2]?.trim();

  if (fromArgv) {
    return fromArgv;
  }

  const workspaces = await prisma.workspace.findMany({ select: { id: true } });

  if (workspaces.length === 1) {
    return workspaces[0].id;
  }

  if (!workspaces.length) {
    throw new Error('no workspaces in the database — pass a workspaceId explicitly');
  }

  throw new Error(`several workspaces in the database — pass one explicitly: ${workspaces.map(workspace => workspace.id).join(', ')}`);
}

const workspaceId = await resolveWorkspaceId();

// The installation's remote agent kinds join the catalog as at boot; a kind
// that fails to load is reported here, not journaled.
loadAgents(
  await loadRemoteAgents({
    context: kind => createRemoteDriverContext(kind, extensionFilesApi),
    repositoryAgents: repositoryAgentNames(),
  }),
);

await startTree();

await mkdir(OUT_DIR, { recursive: true });

const written: string[] = [];

const coordinatorPath = path.join(OUT_DIR, 'coordinator.md');

await writeFile(coordinatorPath, await renderCoordinator(workspaceId), 'utf8');
written.push(coordinatorPath);

for (const declaration of getAgents()) {
  const filePath = path.join(OUT_DIR, `${declaration.name}.md`);

  await writeFile(filePath, isRemoteAgent(declaration) ? renderRemoteAgent(declaration) : await renderAgent(declaration, workspaceId), 'utf8');
  written.push(filePath);
}

console.log(`[render-context] workspace ${workspaceId}; written:\n${written.map(file => `  ${file}`).join('\n')}`);

await prisma.$disconnect();
