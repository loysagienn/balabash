// The tree of Balabash: the real vertices of the capability catalog, written
// over its core (src/catalog) — the root with its guide, the capabilities of
// the root and the nodes. The core stands on its own; here the definitions
// meet the app: an action takes its data from the app's own layers (the
// log, the threads, the storage).
//
// - index.ts — the root: its summary, its guide and its children;
// - events.ts — the type Event and `get_event`;
// - threads.ts — the node `threads` and the type Thread;
// - projects.ts — the node `projects` and the type Project;
// - files.ts — a stored file as a FileRef and the file capabilities of the
//   root: `export_file`, `import_file`, `get_file_url`, `view_file`;
// - thread-verbs.ts — the verbs of a thread: `send_message`, `end_thread`,
//   `spawn_agent`, `send_to_thread`, `finish_thread`, `cancel_thread`,
//   `fetch_thread_file`;
// - workspace.ts — the node `workspace` with `query` and `run_command`;
//   workspace-files.ts and workspace-apps.ts — its nodes `files` (with the
//   type WorkspaceFile) and `apps`;
// - file-area.ts — the workspace file area as the tree reaches it: the path
//   a caller names, the workbench a write needs;
// - web.ts — the node `web` with `get` and `download`; web-request.ts — a
//   GET to the public internet: the addresses it reaches, its redirects and
//   its time;
//   web-perplexity.ts — its node `perplexity`, an external MCP server on
//   the installation's key; capabilities/mcp-client.ts handles MCP exchanges;
// - authored-nodes.ts — written installation nodes from data/nodes;
// - connectors.ts and discovered-node.ts — installation nodes from MCP discovery;
// - gmail.ts — the node `gmail` over the Gmail API, on the access of the
//   user's account; gmail-mail.ts — a mail as a value and as the raw
//   message the API takes;
// - drive.ts — the node `drive` over the Drive API, on the same kind of
//   access; drive-file.ts — a file of Drive as a value and the export
//   formats of Google documents;
// - notion.ts — Notion MCP on the access of a workspace account;
// - google-api.ts — a request to an API of Google on the access of an
//   account, and a list Google pages itself;
// - connections.ts — the node `connections`; services.ts — the services the
//   nodes declare, told to the app's connections layer, and the connections
//   port of the catalog over that layer;
// - schedule.ts — the node `schedule`: the registry of scheduled tasks and
//   the journal of their runs, over the app's schedule (src/schedule);
// - system.ts — the node `system` with `request_restart`;
// - cursor.ts — the cursor of a list paged along the log;
// - transcript.ts — the course of a thread as text.
//
// A recipe of the root joins its guide together with the capability it
// names: the build lets no recipe through that requires what the tree does
// not have.

import {
  buildCatalog,
  countProgramCalls,
  countRunningPrograms,
  killRunningPrograms,
  type Catalog,
  type RootDefinition,
  type Node,
} from '../catalog/index.ts';
import { configureServers } from './configured-servers.ts';
import { readExternalServerConfigs, type ExternalServerConfig } from '../capabilities/server-config.ts';
import { reportSkippedExtension } from '../capabilities/extensions.ts';
import { getAccountService, getSecretService } from '../capabilities/connections/services.ts';
import type { ReportExtensionFailure } from '../capabilities/extensions.ts';
import { loadAuthoredNodes } from './authored-nodes.ts';
import { addressedTo } from '../capabilities/agent-catalog.ts';
import type { AgentPassport } from '../core/contract.ts';
import { startConnectors } from './connectors.ts';
import { getLoadedRemoteKinds } from '../capabilities/remote-agent-source.ts';
import { refreshSecretServices } from '../capabilities/connections/services.ts';
import { connections } from './connections.ts';
import { drive } from './drive.ts';
import { getEvent } from './events.ts';
import { fileCapabilities } from './files.ts';
import { gmail } from './gmail.ts';
import { notionNode } from './notion.ts';
import { projects } from './projects.ts';
import { journalProgramCall } from './call-journal.ts';
import { setProgramHost } from '../schedule/programs.ts';
import { schedule } from './schedule.ts';
import { connectionsPort, registerServices } from './services.ts';
import { system } from './system.ts';
import { threadVerbs } from './thread-verbs.ts';
import { threads } from './threads.ts';
import { web } from './web.ts';
import { countRunningCommands, killRunningCommands, workspace } from './workspace.ts';

export const root: RootDefinition = {
  summary: 'Everything Balabash can do for you.',
  guide: [
    {
      text: 'Capabilities form a tree. `describe` a node to get its guide and one line per child; `describe` a capability to get its full description and exact signature. Describe a capability before its first call unless its signature is already in your context.',
      requires: ['describe'],
    },
    { text: 'Pass exactly the fields of the signature and leave an optional field out.' },
    { text: 'Call a described capability through `call` by its full name.', requires: ['call'] },
    {
      text: 'With `run_program` you can chain calls and return just the result you need.',
      requires: ['run_program'],
    },
    {
      text: 'A failed call gives an error with a kind. invalid_input, unknown_capability, not_found, conflict: change the call. auth_required: follow the credential instructions in the error. external_error: the outside system refused; read its message. unavailable: no answer came and the outcome is unknown; before retrying a write, check whether it took effect. internal: a defect of Balabash; report it.',
    },
    {
      text: 'For lists with `nextCursor`, pass it as `cursor` for the next page; null means the list is complete.',
    },
    {
      text: "A node that works with the user's accounts lists them in `describe`; each of its capabilities takes `account`, the address of the account to act as.",
      requires: ['describe'],
    },
    {
      text: 'A file in a result is a reference, never content. Where an input asks for a file, pass the id of the reference.',
    },
    {
      text: 'To give a file to whoever you talk to, pass its id in the files of `send_message`.',
      requires: ['send_message'],
    },
    {
      text: 'To work with the content of a stored file, put it into the workspace file area with `import_file`.',
      requires: ['import_file'],
    },
    {
      text: 'A file you produced in the workspace file area becomes a reference with `export_file`.',
      requires: ['export_file'],
    },
    { text: 'To look at a stored image, PDF or text yourself, use `view_file`.', requires: ['view_file'] },
    {
      text: 'When something outside Balabash has to fetch a stored file itself, give it the address from `get_file_url`.',
      requires: ['get_file_url'],
    },
    {
      text: 'Drive a child thread with `send_to_thread`. When its work is done, `finish_thread` asks for its report; `cancel_thread` stops it at once without one.',
      requires: ['send_to_thread', 'finish_thread', 'cancel_thread'],
    },
    {
      text: 'A remote agent has no access to Balabash storage. A file reaches it only as an attachment of `spawn_agent` or `send_to_thread`; a file it produced comes back only through `fetch_thread_file`.',
      requires: ['spawn_agent', 'send_to_thread', 'fetch_thread_file'],
    },
    {
      text: "A reference handed to you names a thread and an event seq: read the event with `get_event` first. A thread's final report is its thread.completed event.",
      requires: ['get_event'],
    },
  ],
  children: [
    fileCapabilities.exportFile,
    fileCapabilities.importFile,
    fileCapabilities.getFileUrl,
    fileCapabilities.viewFile,
    threadVerbs.sendMessage,
    threadVerbs.endThread,
    threadVerbs.spawnAgent,
    threadVerbs.sendToThread,
    threadVerbs.finishThread,
    threadVerbs.cancelThread,
    threadVerbs.fetchThreadFile,
    getEvent,
    threads,
    projects,
    schedule,
    workspace,
    web,
    gmail,
    drive,
    notionNode(),
    connections,
    system,
  ],
};

let built: Catalog | null = null;

const installed = new Map<string, Node>();

const workspaceTrees = new Map<string, { nodes: Map<string, Node>; catalog: Catalog }>();

function buildTree(shared: Map<string, Node>, scoped?: Map<string, Node>) {
  const nodes = [...new Map([...shared, ...scoped ?? []]).values()].sort((a, b) => a.name.localeCompare(b.name));
  return buildCatalog({ ...root, children: [...root.children, ...nodes] }).catalog;
}

function publishNode(node: Node, workspaceId?: string): void {
  const { name } = node;
  const installation = node.installation!;
  if (workspaceId) {
    const current = workspaceTrees.get(workspaceId);
    const previous = current?.nodes.get(name) ?? installed.get(name);
    if (previous?.installation?.revision === installation.revision) return;
    const nodes = new Map(current?.nodes);
    if (installed.get(name)?.installation?.revision === installation.revision) nodes.delete(name);
    else nodes.set(name, node);
    if (nodes.size) workspaceTrees.set(workspaceId, { nodes, catalog: buildTree(installed, nodes) });
    else workspaceTrees.delete(workspaceId);
    return;
  }

  const previous = installed.get(name)?.installation;
  if (previous && previous.source !== installation.source) throw new Error(`Node "${name}" is already installed`);
  if (installation.source === 'discovered' && previous?.revision === installation.revision) return;
  const next = new Map(installed).set(name, node);
  const catalog = buildTree(next);
  const replacements = [...workspaceTrees.values()].map(tree => ({ tree, catalog: buildTree(next, tree.nodes) }));
  const subtree = catalog.vertices.get(name)!;
  if (subtree.kind !== 'node') throw new Error(`Expected node "${name}"`);
  if (installation.source === 'authored' || subtree.connection?.type === 'account') registerServices(subtree);
  installed.set(name, node);
  built = catalog;
  for (const replacement of replacements) replacement.tree.catalog = replacement.catalog;
}

// Agent cards show addressed nodes even before their credentials are in place.
const configuredRecipients = new Map<string, string[]>();
export function installationNamesFor(agent: AgentPassport): string[] {
  const names = new Set<string>();
  for (const [name, recipients] of configuredRecipients) {
    if (addressedTo(recipients, agent)) names.add(name);
  }
  for (const node of installed.values()) {
    if (addressedTo(node.installation!.recipients, agent)) names.add(node.name);
  }
  return [...names].sort();
}

export function catalog(workspaceId?: string): Catalog {
  const scoped = workspaceId && workspaceTrees.get(workspaceId);
  if (scoped) return scoped.catalog;
  built ??= buildCatalog(root).catalog;
  return built;
}

// What the app does with the tree when it starts, before anyone can ask for
// a service — the console, an OAuth callback, a task: the catalog is built,
// and the services its nodes declare are told to the connections layer.
// From then on they can be connected, and `connectionsPort()` (./services.ts)
// answers for them. The catalog owns definitions of its nodes' services. The schedule gets what its programs run against:
// this catalog and these connections.
export async function startTree(report?: ReportExtensionFailure): Promise<void> {
  registerServices(catalog().root);
  const configs = await readExternalServerConfigs(report);
  const names = new Set(Object.keys(configs));
  const remoteServices = new Set(getLoadedRemoteKinds().filter(remote => remote.secrets?.length).map(remote => remote.name));
  for (const name of remoteServices) names.add(name);
  const connectors: [string, Extract<ExternalServerConfig, { transport: 'claude-connector' }>][] = [];
  const servers: Parameters<typeof configureServers>[0] = [];
  for (const [name, config] of Object.entries(configs)) {
    if (catalog().vertices.has(name) || getAccountService(name) || getSecretService(name) || remoteServices.has(name)) {
      await reportSkippedExtension('mcp-servers', name + '.json', 'Name already belongs to a catalog vertex or service', report);
      continue;
    }
    configuredRecipients.set(name, config.recipients ?? []);
    if (config.transport === 'claude-connector') connectors.push([name, config]);
    else servers.push([name, config]);
  }
  await loadAuthoredNodes(publishNode, names, report);
  await configureServers(servers, publishNode, report);
  await startConnectors(connectors, publishNode);
  setProgramHost({ catalog, connections: connectionsPort(), traceCall: journalProgramCall });
  await refreshSecretServices();
}

// What the scheme has in flight that no turn of an agent answers for: the
// runs of programs, the calls a program started — to their own end, also
// after the run is over — and the commands called directly (a command of a
// program ends with its run). A restart waits while there is any. The runs
// and the commands are processes of their own and would outlive the app, so
// boot sweeps their recorded process groups after a crash. During graceful
// shutdown, stopRunningWork signals every active process and cancels any
// command still waiting to start.
export function hasRunningWork(): boolean {
  return countRunningPrograms() + countProgramCalls() + countRunningCommands() > 0;
}

export function stopRunningWork(): void {
  killRunningPrograms();
  killRunningCommands();
}
