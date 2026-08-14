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
