// The node `projects`: the registry of the user's projects. A project is
// addressed by its slug — the name of its folder — in every capability; the
// changes themselves are the registry's own (src/projects/mutations.ts, one
// implementation for every way a project changes), authored by the calling
// thread.

import { z } from 'zod';
import { CapabilityError, WorkspacePath, capability, namedType, node, type Caller, type ErrorKind } from '../catalog/index.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import {
  DESCRIPTION_MAX_LENGTH,
  ProjectError,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  TITLE_MAX_LENGTH,
  archiveProject,
  createProject,
  parseProjectInput,
  parseProjectPatch,
  unarchiveProject,
  updateProject,
  type ProjectErrorCode,
} from '../projects/mutations.ts';
import { getProjectBySlug, listProjects, type ProjectModel } from '../projects/store.ts';

export const Project = namedType(
  'Project',
  { description: 'One project of the workspace: its registry record and the place of its library.' },
  z.strictObject({
    id: z.string().describe('Immutable id of the record; capabilities address a project by its slug.'),
    title: z.string().describe('Unique within the workspace, archived projects included.'),
    slug: z.string().describe("Name of the project's folder and the address of the project."),
    description: z.string().describe('What the project is, top level only: the text a conversation is matched against.'),
    archived: z.boolean(),
    folder: WorkspacePath.describe("The project's library; AGENTS.md inside is its entry point."),
    createdAt: z.string().describe('ISO 8601.'),
    updatedAt: z
      .string()
      .describe('ISO 8601. Moves when the record changes and when a thread of the project starts or completes.'),
  }),
);

export type ProjectValue = z.input<typeof Project>;

export function projectValue(project: ProjectModel): ProjectValue {
  return {
    id: project.id,
    title: project.title,
    slug: project.slug,
    description: project.description,
    archived: project.archived,
    // The folder lies at the root of the workspace file area under the slug.
    folder: project.slug,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

const slugOfProject = z.string().describe('Slug of the project.');
const title = z.string().min(1).max(TITLE_MAX_LENGTH);
const description = z.string().min(1).max(DESCRIPTION_MAX_LENGTH);
const slug = z.string().max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN);

// A project of the caller's workspace by its slug.
async function workspaceProject(caller: Caller, projectSlug: string): Promise<ProjectModel> {
  const project = await getProjectBySlug(caller.workspaceId, projectSlug);

  if (!project) {
    throw new CapabilityError('not_found', `There is no project with the slug "${projectSlug}" in the workspace.`);
  }

  return project;
}

// A change of the registry is authored by the thread that asked for it.
function author(caller: Caller): RegistryAuthor {
  return { kind: 'thread', workspaceId: caller.workspaceId, threadId: caller.threadId };
}

const REFUSALS: Record<ProjectErrorCode, ErrorKind> = {
  bad_request: 'invalid_input',
  not_found: 'not_found',
  conflict: 'conflict',
};

// A refusal of the registry in the kinds of the catalog; anything else is a
// defect and stays what it is. A taken title or slug names its holder by
// the slug — the address a caller can read the project by.
async function registry<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    if (error instanceof ProjectError) {
      const { clash } = error;

      throw new CapabilityError(
        REFUSALS[error.code],
        clash
          ? `The ${clash.field} "${clash.value}" is taken by the project "${clash.project.slug}"${clash.project.archived ? `, which is archived: an archived project keeps its ${clash.field}` : ''}. Pick another ${clash.field}.`
          : error.message,
      );
    }

    throw error;
  }
}

const list = capability({
  name: 'list',
  summary: 'List all projects of the workspace',
  description:
    'List all projects of the workspace: live ones first, the most recently worked on at the top, archived ones after.',
  input: z.strictObject({}),
  output: z.strictObject({ projects: z.array(Project) }),
  async run(_input, { caller }) {
    return { projects: (await listProjects(caller.workspaceId)).map(projectValue) };
  },
});

const get = capability({
  name: 'get',
  summary: 'Read one project',
  description: 'Read one project: its registry record with the path of its folder.',
  input: z.strictObject({ project: slugOfProject }),
  output: Project,
  async run({ project }, { caller }) {
    return projectValue(await workspaceProject(caller, project));
  },
});

const create = capability({
  name: 'create',
  summary: 'Create a project: a registry record and its folder',
  description:
    'Create a project: a registry record and its folder in the workspace file area, named by the slug. An existing folder is adopted with its contents untouched; AGENTS.md is written only when the folder has none.',
  input: z.strictObject({
    title: title.describe('Unique within the workspace, archived projects included.'),
    slug: slug.describe('Name of the folder and the address of the project.'),
    description: description.describe('What the project is, top level only, in about 300 characters.'),
  }),
  output: z.strictObject({
    project: Project,
    adopted: z.boolean().describe('true: the folder already existed.'),
  }),
  async run(input, { caller }) {
    const { project, adopted } = await registry(() =>
      createProject(caller.workspaceId, parseProjectInput(input), author(caller)),
    );

    return { project: projectValue(project), adopted };
  },
});

const update = capability({
  name: 'update',
  summary: "Change a project's title, description or slug",
  description:
    "Change a project's title, description or slug; a field left out keeps its value. A new slug renames the project's folder, and the address of the project changes with it.",
  input: z.strictObject({
    project: slugOfProject,
    title: title.optional(),
    description: description.optional(),
    slug: slug.describe('The new slug.').optional(),
  }),
  inputRules: [{ atLeastOne: ['title', 'description', 'slug'] }],
  output: z.strictObject({
    project: Project,
    renamedFrom: WorkspacePath.nullable().describe('Previous path of the folder, when this call renamed it.'),
  }),
  async run({ project: projectSlug, ...fields }, { caller }) {
    // The registry reads a blank field as "keep"; here a field that is given
    // carries a value.
    for (const [field, value] of Object.entries(fields)) {
      if (value !== undefined && !value.trim()) {
        throw new CapabilityError('invalid_input', `${field} is blank: pass a value or leave the field out.`);
      }
    }

    const current = await workspaceProject(caller, projectSlug);
    const { project, renamedFrom } = await registry(() =>
      updateProject(caller.workspaceId, current.id, parseProjectPatch(fields), author(caller)),
    );

    return { project: projectValue(project), renamedFrom };
  },
});

const archive = capability({
  name: 'archive',
  summary: 'Archive a project without deleting anything',
  description: 'Archive a project: it leaves the live list, while its record and its folder stay untouched.',
  input: z.strictObject({ project: slugOfProject }),
  output: z.strictObject({
    project: Project,
    changed: z.boolean().describe('false: it was already archived.'),
  }),
  async run({ project: projectSlug }, { caller }) {
    const current = await workspaceProject(caller, projectSlug);
    const { project, changed } = await registry(() => archiveProject(caller.workspaceId, current.id, author(caller)));

    return { project: projectValue(project), changed };
  },
});

const unarchive = capability({
  name: 'unarchive',
  summary: 'Bring an archived project back to the live list',
  description: 'Bring an archived project back to the live list.',
  input: z.strictObject({ project: slugOfProject }),
  output: z.strictObject({
    project: Project,
    changed: z.boolean().describe('false: it was not archived.'),
  }),
  async run({ project: projectSlug }, { caller }) {
    const current = await workspaceProject(caller, projectSlug);
    const { project, changed } = await registry(() => unarchiveProject(caller.workspaceId, current.id, author(caller)));

    return { project: projectValue(project), changed };
  },
});

export const projects = node({
  name: 'projects',
  summary:
    "The registry of the user's projects: long-lived work contexts, each with a folder that is its library. Come here to find, create, rename or archive a project.",
  guide: [
    {
      text: "A project is not a unit of work: it has no status or progress. Match a conversation to a project by the descriptions in `projects_list`. The project's folder is its library and AGENTS.md in it is the entry point: read it before work that concerns the project.",
    },
    {
      text: 'The registry record is identity, not a log: change it only when it stopped matching reality. The description says what the project is, top level only, in about 300 characters; details, the course of work and status live in the folder.',
    },
    { text: 'Nothing is ever deleted. Archive a project, or change its slug, only on an explicit request of the user.' },
  ],
  children: [list, get, create, update, archive, unarchive],
});
