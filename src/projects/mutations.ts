// The changes of the project registry — one implementation behind the
// tools of the agents (tools.ts) and the console's endpoints (src/api):
// create (the row plus its folder in the workspace file area), update
// (title, description, slug — a slug change renames the folder in step; no
// fields is a "touch"), archive and unarchive (a flag flip, nothing is ever
// deleted). Every change journals its project.* event in the transaction
// of the row (registryMutation), authored by whoever asked: an agent's
// thread or the operator. Refusals are ProjectError with a code the API
// maps to a status; the parsing of the input is pure (tested).

import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db/client.ts';
import { registryMutation } from '../core/registry-events.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import { workspaceFilesDir } from '../workspace/layout.ts';
import { getProject, projectRecord } from './store.ts';
import type { ProjectModel } from './store.ts';

export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SLUG_MAX_LENGTH = 64;
// The longest title and description the registry takes (the description
// is a ~300-char scent; the cap only keeps a runaway body out).
export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2_000;

// bad_request — the input itself; not_found — no such project in this
// workspace (a foreign one answers the same); conflict — the title, the
// slug or the folder path is taken.
export type ProjectErrorCode = 'bad_request' | 'not_found' | 'conflict';

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ProjectInput = { title: string; slug: string; description: string };
// null — keep the current value; a slug equal to the current one is a
// no-op, not an error (retries are idempotent).
export type ProjectPatch = { title: string | null; description: string | null; slug: string | null };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function checkSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    throw new ProjectError('bad_request', `slug must match ${String(SLUG_PATTERN)} and be at most ${SLUG_MAX_LENGTH} chars`);
  }
}

function checkTitle(title: string): void {
  if (title.length > TITLE_MAX_LENGTH) {
    throw new ProjectError('bad_request', `title must be at most ${TITLE_MAX_LENGTH} chars`);
  }
}

function checkDescription(description: string): void {
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new ProjectError('bad_request', `description must be at most ${DESCRIPTION_MAX_LENGTH} chars`);
  }
}

// The input of a creation, trimmed and checked: every field required.
export function parseProjectInput(raw: { title?: unknown; slug?: unknown; description?: unknown }): ProjectInput {
  const title = text(raw.title);
  const slug = text(raw.slug);
  const description = text(raw.description);

  if (!title) {
    throw new ProjectError('bad_request', 'a non-empty title is required');
  }

  checkTitle(title);
  checkSlug(slug);

  if (!description) {
    throw new ProjectError('bad_request', 'a non-empty description is required — it is how agents match conversations to the project');
  }

  checkDescription(description);

  return { title, slug, description };
}

// The input of an update: an absent, null or blank field keeps the current
// value; a given one is checked. All three absent is a touch.
export function parseProjectPatch(raw: { title?: unknown; slug?: unknown; description?: unknown }): ProjectPatch {
  const title = text(raw.title) || null;
  const description = text(raw.description) || null;
  const slug = text(raw.slug) || null;

  if (title) {
    checkTitle(title);
  }

  if (description) {
    checkDescription(description);
  }

  if (slug) {
    checkSlug(slug);
  }

  return { title, description, slug };
}

export function isTouch(patch: ProjectPatch): boolean {
  return patch.title === null && patch.description === null && patch.slug === null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

// Same error for a foreign and a missing id: existence outside the
// workspace is not leaked.
export async function requireProject(userId: string, id: string): Promise<ProjectModel> {
  const project = await getProject(userId, id.trim());

  if (!project) {
    throw new ProjectError('not_found', `Project "${id}" not found in this workspace`);
  }

  return project;
}

function takenBy(field: 'title' | 'slug', value: string, clash: ProjectModel): ProjectError {
  return new ProjectError('conflict', `${field} "${value}" is already taken by project ${clash.id}${clash.archived ? ` (archived — ${field}s stay reserved)` : ''}`);
}

export type CreatedProject = { project: ProjectModel; adopted: boolean };

export async function createProject(userId: string, input: ProjectInput, by: RegistryAuthor): Promise<CreatedProject> {
  const { title, slug, description } = input;

  // Friendly uniqueness errors ahead of the write; the db constraints stay
  // the last word (the race window is covered by the P2002 catch below).
  const clash = await prisma.project.findFirst({ where: { userId, OR: [{ title }, { slug }] } });

  if (clash) {
    throw clash.title === title ? takenBy('title', title, clash) : takenBy('slug', slug, clash);
  }

  // The folder. An existing directory is adopted as the project's library —
  // workbench agents create per-task directories at the same root, and
  // turning such a directory into a project is a feature. A file in the way
  // is an error: nothing is ever deleted or moved.
  const dir = path.join(workspaceFilesDir(userId), slug);
  const existing = await fs.stat(dir).catch(() => null);

  if (existing && !existing.isDirectory()) {
    throw new ProjectError('conflict', `the path "${slug}" in the workspace file area is taken by a file — pick another slug`);
  }

  const adopted = existing !== null;

  // mkdir recursive doubles as lazy provisioning of the file area itself.
  await fs.mkdir(dir, { recursive: true });

  // The library anatomy (the law in agents/gardener.ts), seeded only where
  // the folder has none — an adopted folder's existing files are someone's
  // work and are never overwritten.
  const seed = async (name: string, content: string) => {
    await fs.writeFile(path.join(dir, name), content, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      // A concurrent writer beat us to it — their file wins.
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
  };

  await seed(
    'AGENTS.md',
    `# ${title}\n\n${description}\n\n## Map\n\n- inbox.md — append anything new worth keeping: results, decisions, learned facts; dated, with the "why". A gardener agent consolidates later.\n- journal.md — dated history of the project, maintained by the gardener.\n\n(Keep this file the entry point: the map of the folder plus the project's identity and stable frame.)\n`,
  );
  await seed('inbox.md', '# Inbox\n\nAppend new material here freely — dated, with the "why". Drained by the gardener.\n');
  await seed('journal.md', '# Journal\n\nDated events and decisions, newest first. Written by the gardener.\n');

  try {
    const project = await registryMutation(async (tx, journal) => {
      const created = await tx.project.create({ data: { userId, title, slug, description } });

      await journal('project.created', projectRecord(created), by);

      return created;
    });

    return { project, adopted };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ProjectError('conflict', `title "${title}" or slug "${slug}" is already taken — check the projects list`);
    }

    throw error;
  }
}

// The previous slug when the folder was renamed, null otherwise.
export type UpdatedProject = { project: ProjectModel; renamedFrom: string | null };

export async function updateProject(userId: string, id: string, patch: ProjectPatch, by: RegistryAuthor): Promise<UpdatedProject> {
  const project = await requireProject(userId, id);
  const title = patch.title;
  const description = patch.description;
  const slug = patch.slug && patch.slug !== project.slug ? patch.slug : null;

  if (title && title !== project.title) {
    const clash = await prisma.project.findFirst({ where: { userId, title, id: { not: project.id } } });

    if (clash) {
      throw takenBy('title', title, clash);
    }
  }

  if (slug) {
    const clash = await prisma.project.findFirst({ where: { userId, slug, id: { not: project.id } } });

    if (clash) {
      throw takenBy('slug', slug, clash);
    }
  }

  // The folder moves ahead of the row update and is moved back if the write
  // fails — the registry row stays the source of truth for the path.
  let movedFromDir: string | null = null;

  if (slug) {
    const filesDir = workspaceFilesDir(userId);
    const oldDir = path.join(filesDir, project.slug);
    const newDir = path.join(filesDir, slug);

    if (await fs.stat(newDir).catch(() => null)) {
      throw new ProjectError('conflict', `the path "${slug}" in the workspace file area is already taken — nothing is ever deleted or overwritten; pick another slug`);
    }

    const existing = await fs.stat(oldDir).catch(() => null);

    if (existing?.isDirectory()) {
      await fs.rename(oldDir, newDir);
      movedFromDir = oldDir;
    } else {
      // The library folder is missing (never provisioned or lost) — the
      // rename provisions the new location instead of failing.
      await fs.mkdir(newDir, { recursive: true });
    }
  }

  try {
    const updated = await registryMutation(async (tx, journal) => {
      const row = await tx.project.update({
        where: { id: project.id },
        // With no fields given the call is a "touch": prisma writes nothing on
        // empty data, so updatedAt is set explicitly.
        data:
          title || description || slug
            ? { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(slug ? { slug } : {}) }
            : { updatedAt: new Date() },
      });

      await journal('project.updated', projectRecord(row), by);

      return row;
    });

    return { project: updated, renamedFrom: slug ? project.slug : null };
  } catch (error) {
    if (movedFromDir && slug) {
      // Roll the folder back so disk keeps matching the (unchanged) row.
      await fs.rename(path.join(workspaceFilesDir(userId), slug), movedFromDir).catch(() => {});
    }

    if (isUniqueViolation(error)) {
      throw new ProjectError('conflict', `title "${title}" or slug "${slug}" is already taken — check the projects list`);
    }

    throw error;
  }
}

// changed: false — the project already was in the asked state; no event
// then (the goal is met, the log records changes only).
export type FlaggedProject = { project: ProjectModel; changed: boolean };

async function setArchived(userId: string, id: string, archived: boolean, by: RegistryAuthor): Promise<FlaggedProject> {
  const project = await requireProject(userId, id);

  if (project.archived === archived) {
    return { project, changed: false };
  }

  const updated = await registryMutation(async (tx, journal) => {
    const row = await tx.project.update({ where: { id: project.id }, data: { archived } });

    await journal(archived ? 'project.archived' : 'project.unarchived', projectRecord(row), by);

    return row;
  });

  return { project: updated, changed: true };
}

export function archiveProject(userId: string, id: string, by: RegistryAuthor): Promise<FlaggedProject> {
  return setArchived(userId, id, true, by);
}

export function unarchiveProject(userId: string, id: string, by: RegistryAuthor): Promise<FlaggedProject> {
  return setArchived(userId, id, false, by);
}
