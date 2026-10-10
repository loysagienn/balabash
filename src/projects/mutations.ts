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

type Field = 'title' | 'slug' | 'description';

// A field as given: a string trimmed, an absent or null one empty. Any other
// type is the caller's mistake and a refusal — a wrong type must not pass as
// "not given" (a PATCH with `title: 42` would then read as a touch).
function text(field: Field, value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw new ProjectError('bad_request', `${field} must be a string`);
  }

  return value.trim();
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
  const title = text('title', raw.title);
  const slug = text('slug', raw.slug);
  const description = text('description', raw.description);

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
  const title = text('title', raw.title) || null;
  const description = text('description', raw.description) || null;
  const slug = text('slug', raw.slug) || null;

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

  try {
    const project = await registryMutation(async (tx, journal) => {
      // The row first: of two creations of one slug at once the second
      // insert waits on the unique index for the first to commit and then
      // fails — so only the creation that owns the row reaches the disk,
      // and the seed carries its title and description, never the loser's.
      // A failure on the disk rolls the row back; what the loser leaves
      // behind is nothing.
      const created = await tx.project.create({ data: { userId, title, slug, description } });

      // What this creation puts on the disk, to take back if its
      // transaction fails: the folder when mkdir made it, and the files its
      // own wx wrote — an adopted folder's existing files are someone's
      // work, never on the list and never overwritten.
      const written: string[] = [];
      let madeDir = false;

      // The library anatomy (the law in agents/gardener.ts), seeded only
      // where the folder has none.
      const seed = async (name: string, content: string) => {
        try {
          await fs.writeFile(path.join(dir, name), content, { flag: 'wx' });
          written.push(name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
          }
        }
      };

      try {
        // mkdir recursive doubles as lazy provisioning of the file area
        // itself; it answers the first path it created, undefined when the
        // folder was already there.
        madeDir = (await fs.mkdir(dir, { recursive: true })) !== undefined;
        await seed(
          'AGENTS.md',
          `# ${title}\n\n${description}\n\n## Map\n\n- inbox.md — append anything new worth keeping: results, decisions, learned facts; dated, with the "why". A gardener agent consolidates later.\n- journal.md — dated history of the project, maintained by the gardener.\n\n(Keep this file the entry point: the map of the folder plus the project's identity and stable frame.)\n`,
        );
        await seed('inbox.md', '# Inbox\n\nAppend new material here freely — dated, with the "why". Drained by the gardener.\n');
        await seed('journal.md', '# Journal\n\nDated events and decisions, newest first. Written by the gardener.\n');

        await journal('project.created', projectRecord(created), by);
      } catch (error) {
        // Taken back here, inside the transaction — before its rollback
        // releases the slug to a concurrent creation, which would otherwise
        // adopt this one's header as existing work. Only what was written
        // above; the folder only when empty (rmdir), so anything that
        // appeared beside the seed stays. A failure at the commit itself
        // is past this point: the files stay for the next creation to
        // adopt.
        for (const name of written) {
          await fs.rm(path.join(dir, name), { force: true }).catch((cause: unknown) => console.error('[projects] seed left behind:', cause));
        }

        if (madeDir) {
          await fs.rmdir(dir).catch(() => {});
        }

        throw error;
      }

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

// renamedFrom — the previous slug when the folder was renamed, null
// otherwise; touched — nothing differed from the row, only updatedAt moved.
export type UpdatedProject = { project: ProjectModel; renamedFrom: string | null; touched: boolean };

export async function updateProject(userId: string, id: string, patch: ProjectPatch, by: RegistryAuthor): Promise<UpdatedProject> {
  const project = await requireProject(userId, id);
  // A field equal to the row's value is "keep", like an absent one — so a
  // repeated call is idempotent and the answer says what really changed.
  const title = patch.title !== project.title ? patch.title : null;
  const description = patch.description !== project.description ? patch.description : null;
  const slug = patch.slug !== project.slug ? patch.slug : null;

  if (title) {
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

    return { project: updated, renamedFrom: slug ? project.slug : null, touched: !title && !description && !slug };
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
// then (the goal is met, the log records changes only). Archiving stamps
// archivedAt with the moment, unarchiving clears it — the row tells since
// when a project is in the archive, not only that it is.
export type FlaggedProject = { project: ProjectModel; changed: boolean };

async function setArchived(userId: string, id: string, archived: boolean, by: RegistryAuthor): Promise<FlaggedProject> {
  const project = await requireProject(userId, id);

  if (project.archived === archived) {
    return { project, changed: false };
  }

  // The flag read above is not a lock: two calls at once both see a project
  // still to flip. The flip is conditional on the row being the other way
  // when the update takes the row lock (postgres re-checks the condition on
  // the row as committed by then), so the second of two finds nothing to
  // flip — the first date stays, no second event — and answers the row as
  // it is (api.test.ts holds the first flip uncommitted under the second).
  return registryMutation(async (tx, journal) => {
    const { count } = await tx.project.updateMany({ where: { id: project.id, archived: !archived }, data: { archived, archivedAt: archived ? new Date() : null } });
    const row = await tx.project.findUniqueOrThrow({ where: { id: project.id } });

    if (count === 0) {
      return { project: row, changed: false };
    }

    await journal(archived ? 'project.archived' : 'project.unarchived', projectRecord(row), by);

    return { project: row, changed: true };
  });
}

export function archiveProject(userId: string, id: string, by: RegistryAuthor): Promise<FlaggedProject> {
  return setArchived(userId, id, true, by);
}

export function unarchiveProject(userId: string, id: string, by: RegistryAuthor): Promise<FlaggedProject> {
  return setArchived(userId, id, false, by);
}
