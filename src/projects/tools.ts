// The projects tool server — a builtin, NON-consent server: it rides into
// every 'all' bundle, so the coordinator and any workbench agent can see and
// maintain the project registry. A project is a passive library: a named
// long-lived work context owned by the user — identity in the registry
// (title + description + slug), knowledge in its folder in the workspace
// file area (<slug>/ at the file-area root, AGENTS.md as the entry point).
// Projects are not units of work (no status or progress) and own no
// resources; threads and tasks are never linked to them — an agent matches a
// conversation to a project by its description and goes to the library
// itself. Nothing is ever deleted: archive flips a flag, folders never move.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { JsonObject, JsonValue } from '../core/contract.ts';
import { prisma } from '../db/client.ts';
import type { ToolFunction } from '../capabilities/mcp-client.ts';
import type { BuiltinServerCallContext, BuiltinToolServer } from '../capabilities/tool-manager.ts';
import { workspaceFilesDir } from '../workspace/layout.ts';
import { getProject, listProjects } from './store.ts';
import type { ProjectModel } from './store.ts';

export const PROJECTS_SERVER_NAME = 'projects';

const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
const SLUG_MAX_LENGTH = 64;

const FUNCTIONS: ToolFunction[] = [
  {
    functionName: 'projects_list',
    serverName: PROJECTS_SERVER_NAME,
    toolName: 'projects_list',
    description:
      'List ALL projects of this workspace — named long-lived work contexts (passive libraries), each with a ' +
      'folder in the workspace file area. No filters or pagination: live projects first (most recently ' +
      'touched on top), archived ones after. The description of each project is the scent to match a ' +
      'conversation against; projects_get returns one project with its folder path.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    functionName: 'projects_get',
    serverName: PROJECTS_SERVER_NAME,
    toolName: 'projects_get',
    description:
      'Read one project by id: the full registry record plus the path of its folder relative to the ' +
      'workspace file area root (for workbench agents that is their working directory). The folder is the ' +
      "project's library; read its AGENTS.md yourself — it is the entry point.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The project id, e.g. from projects_list.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'projects_create',
    serverName: PROJECTS_SERVER_NAME,
    toolName: 'projects_create',
    description:
      'Create a project: a registry record plus its folder <slug>/ in the workspace file area. The slug ' +
      `names the folder and is FIXED FOREVER (renaming the title never moves the folder): ${String(SLUG_PATTERN)}, ` +
      `at most ${SLUG_MAX_LENGTH} chars. If the folder already ` +
      'exists it is ADOPTED as the project library (adopted: true in the result); a fresh AGENTS.md entry ' +
      'point is written only when the folder has none. The description is required — it is how agents and ' +
      'the secretary match a conversation to the project, so make it a dense ~300-char scent of the topic.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable project title, unique within the workspace (archived projects included).' },
        slug: {
          type: 'string',
          description: `Folder name in the workspace file area, ${String(SLUG_PATTERN)}, at most ${SLUG_MAX_LENGTH} chars; unique and immutable.`,
        },
        description: {
          type: 'string',
          description: 'What the project is about (~300 chars) — the scent used to match conversations to it.',
        },
      },
      required: ['title', 'slug', 'description'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'projects_update',
    serverName: PROJECTS_SERVER_NAME,
    toolName: 'projects_update',
    description:
      'Update a project: change the title and/or the description (the slug and the folder NEVER change). ' +
      'A call with only the id is a "touch": it bumps updatedAt — "work touched this project just now" — ' +
      'and moves the project up the list. Touch the project when finishing work on it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The project id.' },
        title: { type: ['string', 'null'], description: 'New title, or null to keep the current one.' },
        description: { type: ['string', 'null'], description: 'New description, or null to keep the current one.' },
      },
      required: ['id', 'title', 'description'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'projects_archive',
    serverName: PROJECTS_SERVER_NAME,
    toolName: 'projects_archive',
    description:
      'Archive a project — ONLY on an explicit user request, never on your own initiative. The project ' +
      'drops out of the live list but nothing is deleted: the record stays (its title keeps blocking ' +
      'reuse), the folder stays untouched, and projects_unarchive brings it back.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The project id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'projects_unarchive',
    serverName: PROJECTS_SERVER_NAME,
    toolName: 'projects_unarchive',
    description: 'Bring an archived project back to the live list. The folder was never touched.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The project id.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function projectToJson(project: ProjectModel): JsonObject {
  return {
    id: project.id,
    title: project.title,
    slug: project.slug,
    description: project.description,
    archived: project.archived,
    updatedAt: project.updatedAt.toISOString(),
  };
}

function requireId(args: JsonObject): string {
  const id = typeof args.id === 'string' ? args.id.trim() : '';

  if (!id) {
    throw new Error('a non-empty project id is required');
  }

  return id;
}

// Same error for a foreign and a missing id: existence outside the workspace
// is not leaked.
async function requireProject(id: string, ctx: BuiltinServerCallContext): Promise<ProjectModel> {
  const project = await getProject(ctx.userId, id);

  if (!project) {
    throw new Error(`Project "${id}" not found in this workspace`);
  }

  return project;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

async function executeList(ctx: BuiltinServerCallContext): Promise<JsonValue> {
  const projects = await listProjects(ctx.userId);

  return { projects: projects.map(projectToJson) };
}

async function executeGet(args: JsonObject, ctx: BuiltinServerCallContext): Promise<JsonValue> {
  const project = await requireProject(requireId(args), ctx);

  return {
    project: {
      ...projectToJson(project),
      createdAt: project.createdAt.toISOString(),
      // The library, as a path relative to the workspace file area root —
      // for workbench agents that root is their cwd. AGENTS.md inside is the
      // entry point; the caller reads it itself.
      folder: `${project.slug}/`,
    },
  };
}

async function executeCreate(args: JsonObject, ctx: BuiltinServerCallContext): Promise<JsonValue> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
  const description = typeof args.description === 'string' ? args.description.trim() : '';

  if (!title) {
    throw new Error('a non-empty title is required');
  }

  if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    throw new Error(`slug must match ${String(SLUG_PATTERN)} and be at most ${SLUG_MAX_LENGTH} chars`);
  }

  if (!description) {
    throw new Error('a non-empty description is required — it is how agents match conversations to the project');
  }

  // Friendly uniqueness errors ahead of the write; the db constraints stay
  // the last word (the race window is covered by the P2002 catch below).
  const clash = await prisma.project.findFirst({ where: { userId: ctx.userId, OR: [{ title }, { slug }] } });

  if (clash) {
    throw new Error(
      clash.title === title
        ? `title "${title}" is already taken by project ${clash.id}${clash.archived ? ' (archived — titles stay reserved)' : ''}`
        : `slug "${slug}" is already taken by project ${clash.id}${clash.archived ? ' (archived — slugs stay reserved)' : ''}`,
    );
  }

  // The folder. An existing directory is adopted as the project's library —
  // workbench agents create per-task directories at the same root, and
  // turning such a directory into a project is a feature. A file in the way
  // is an error: nothing is ever deleted or moved.
  const dir = path.join(workspaceFilesDir(ctx.userId), slug);
  let adopted = false;

  const existing = await fs.stat(dir).catch(() => null);

  if (existing && !existing.isDirectory()) {
    throw new Error(`the path "${slug}" in the workspace file area is taken by a file — pick another slug`);
  }

  adopted = existing !== null;

  // mkdir recursive doubles as lazy provisioning of the file area itself.
  await fs.mkdir(dir, { recursive: true });

  // The entry point, only when the folder has none — an adopted folder's
  // existing AGENTS.md is someone's work and is never overwritten.
  const agentsMd = path.join(dir, 'AGENTS.md');
  const hasAgentsMd = await fs.stat(agentsMd).then(
    stat => stat.isFile(),
    () => false,
  );

  if (!hasAgentsMd) {
    await fs.writeFile(
      agentsMd,
      `# ${title}\n\n${description}\n\n## Working notes\n\n(Filled in as the work goes — keep this file the current entry point: what lives where in this folder, decisions made, how to continue.)\n`,
      { flag: 'wx' },
    ).catch((error: NodeJS.ErrnoException) => {
      // A concurrent writer beat us to it — their AGENTS.md wins.
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  }

  let project: ProjectModel;

  try {
    project = await prisma.project.create({
      data: { userId: ctx.userId, title, slug, description },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(`title "${title}" or slug "${slug}" is already taken — check projects_list`);
    }

    throw error;
  }

  return {
    project: projectToJson(project),
    folder: `${slug}/`,
    adopted,
    ...(adopted
      ? { note: 'the folder already existed and was adopted as the project library; its contents are untouched' }
      : {}),
  };
}

async function executeUpdate(args: JsonObject, ctx: BuiltinServerCallContext): Promise<JsonValue> {
  const project = await requireProject(requireId(args), ctx);

  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : null;
  const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : null;

  if (title && title !== project.title) {
    const clash = await prisma.project.findFirst({
      where: { userId: ctx.userId, title, id: { not: project.id } },
    });

    if (clash) {
      throw new Error(
        `title "${title}" is already taken by project ${clash.id}${clash.archived ? ' (archived — titles stay reserved)' : ''}`,
      );
    }
  }

  let updated: ProjectModel;

  try {
    updated = await prisma.project.update({
      where: { id: project.id },
      // With no fields given the call is a "touch": prisma writes nothing on
      // empty data, so updatedAt is set explicitly.
      data:
        title || description
          ? { ...(title ? { title } : {}), ...(description ? { description } : {}) }
          : { updatedAt: new Date() },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(`title "${title}" is already taken — check projects_list`);
    }

    throw error;
  }

  return {
    project: projectToJson(updated),
    ...(title || description ? {} : { note: 'touched — updatedAt bumped, nothing else changed' }),
  };
}

async function executeArchive(args: JsonObject, ctx: BuiltinServerCallContext): Promise<JsonValue> {
  const project = await requireProject(requireId(args), ctx);

  if (project.archived) {
    return `Project "${project.title}" is already archived.`;
  }

  await prisma.project.update({ where: { id: project.id }, data: { archived: true } });

  return `Project "${project.title}" archived. Nothing was deleted: the record and the folder "${project.slug}/" stay; projects_unarchive brings it back.`;
}

async function executeUnarchive(args: JsonObject, ctx: BuiltinServerCallContext): Promise<JsonValue> {
  const project = await requireProject(requireId(args), ctx);

  if (!project.archived) {
    return `Project "${project.title}" is not archived.`;
  }

  await prisma.project.update({ where: { id: project.id }, data: { archived: false } });

  return `Project "${project.title}" is back on the live list. Its folder "${project.slug}/" was never touched.`;
}

export function createProjectsToolServer(): BuiltinToolServer {
  return {
    name: PROJECTS_SERVER_NAME,
    consent: false,
    functionNames: FUNCTIONS.map(fn => fn.functionName),

    getFunctions: async () => FUNCTIONS,

    call: async (toolName, args, ctx) => {
      switch (toolName) {
        case 'projects_list':
          return executeList(ctx);
        case 'projects_get':
          return executeGet(args, ctx);
        case 'projects_create':
          return executeCreate(args, ctx);
        case 'projects_update':
          return executeUpdate(args, ctx);
        case 'projects_archive':
          return executeArchive(args, ctx);
        case 'projects_unarchive':
          return executeUnarchive(args, ctx);
        default:
          throw new Error(`Unknown projects tool "${toolName}"`);
      }
    },
  };
}
