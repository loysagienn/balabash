// Project registry queries. A project is a passive library: the row is
// identity only (title + description + slug of the folder), all knowledge
// lives in the folder in the workspace file area. Nothing is deleted here —
// archiving is a flag flip.

import { prisma } from '../db/client.ts';
import type { ProjectModel } from '../../prisma-generated/models.ts';

export type { ProjectModel };

// Live projects first, most recently touched on top; archived tail after.
export function listProjects(userId: string, options?: { archived?: boolean }): Promise<ProjectModel[]> {
  return prisma.project.findMany({
    where: {
      userId,
      ...(options?.archived !== undefined ? { archived: options.archived } : {}),
    },
    orderBy: [{ archived: 'asc' }, { updatedAt: 'desc' }],
  });
}

// Workspace-scoped lookup: a foreign id resolves to null exactly like a
// missing one — existence outside the workspace is not leaked.
export async function getProject(userId: string, id: string): Promise<ProjectModel | null> {
  const project = id ? await prisma.project.findUnique({ where: { id } }) : null;

  return project && project.userId === userId ? project : null;
}

// Workspace-scoped lookup by slug — the address agents name a project by
// (spawn options, prompts). Same leak rule as getProject.
export async function getProjectBySlug(userId: string, slug: string): Promise<ProjectModel | null> {
  return slug ? prisma.project.findUnique({ where: { userId_slug: { userId, slug } } }) : null;
}

// The project link of a spawn: a slug named by the spawner becomes the
// {id, slug} pair thread.started records. An unknown slug rejects the spawn
// loudly — a silent null would quietly lose the link the spawner asked for.
export async function resolveSpawnProject(userId: string, slug: string | undefined): Promise<{ id: string; slug: string } | undefined> {
  if (slug === undefined) {
    return undefined;
  }

  const trimmed = slug.trim();

  if (!trimmed) {
    return undefined;
  }

  const project = await getProjectBySlug(userId, trimmed);

  if (!project) {
    throw new Error(`Unknown project "${trimmed}" — name an existing project slug or omit the project`);
  }

  return { id: project.id, slug: project.slug };
}
