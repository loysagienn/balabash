// The rules of the project form, shared by "New project" and "Edit
// project": the folder derived from the name, the checks the server makes
// (src/projects/mutations.ts — the caps and the slug rule are the server's
// law, repeated here so a mistake shows under the field before the call),
// which field a server refusal belongs to, the patch of an edit. Pure,
// tested.

import type { ProjectView, UpdateProjectRequest } from '../../../api/contract.ts';
import { capSlug, slugWords } from '../../lib/text/slug.ts';

export const TITLE_MAX_LENGTH = 200;
export const SLUG_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 2_000;
export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export type ProjectFormValues = { title: string; slug: string; description: string };
export type ProjectFormField = keyof ProjectFormValues;
export type ProjectFormErrors = Partial<Record<ProjectFormField, string>>;

// "Bathroom renovation" → "bathroom-renovation", "Ремонт ванной" →
// "remont-vannoy" (lib/text/slug.ts: Latin words, one dash between them),
// a letter first (the slug rule), at most 64 characters, never ending in
// a dash.
export function slugFromTitle(title: string): string {
  return capSlug(slugWords(title).replace(/^[^a-z]+/, ''), SLUG_MAX_LENGTH);
}

// What a form shows under its fields before the call: the same rules as
// parseProjectInput / parseProjectPatch of the server. Editing keeps the
// slug as it is (the folder is not renamed from the console), so only the
// title and the description are checked there.
export function validateProjectForm(values: ProjectFormValues, mode: 'create' | 'edit'): ProjectFormErrors {
  const errors: ProjectFormErrors = {};
  const title = values.title.trim();
  const description = values.description.trim();

  if (!title) {
    errors.title = 'A name is required.';
  } else if (title.length > TITLE_MAX_LENGTH) {
    errors.title = `At most ${TITLE_MAX_LENGTH} characters.`;
  }

  if (mode === 'create') {
    const slug = values.slug.trim();

    if (!slug) {
      errors.slug = 'A folder name is required.';
    } else if (!SLUG_PATTERN.test(slug)) {
      errors.slug = 'Lowercase letters, digits and dashes, starting with a letter.';
    } else if (slug.length > SLUG_MAX_LENGTH) {
      errors.slug = `At most ${SLUG_MAX_LENGTH} characters.`;
    }
  }

  if (!description) {
    errors.description = 'A description is required — it is how agents match conversations to the project.';
  } else if (description.length > DESCRIPTION_MAX_LENGTH) {
    errors.description = `At most ${DESCRIPTION_MAX_LENGTH} characters.`;
  }

  return errors;
}

// The field a server refusal is about, by its words ("title must be at
// most 200 chars", "slug must match …", "the path "x" … is taken"); a
// refusal naming two fields at once or none is the form's own line.
export function fieldOfFailure(message: string): ProjectFormField | null {
  const text = message.toLowerCase();
  const fields: ProjectFormField[] = [];

  if (text.includes('title')) fields.push('title');
  if (text.includes('slug') || text.includes('path')) fields.push('slug');
  if (text.includes('description')) fields.push('description');

  return fields.length === 1 ? (fields[0] as ProjectFormField) : null;
}

// The patch of an edit: only the fields the operator changed against the
// values the form opened with (its base), trimmed; null when none did (no
// call then). The base, not the row of the moment: while the dialog is
// open the row may change from the tail (an agent renames the project),
// and a field the operator never touched must not go back carrying the
// old value. A field they did change is sent as typed — the operator's
// word wins over a change that came meanwhile; the server treats a value
// equal to the row's as "keep".
export function projectPatch(base: Pick<ProjectFormValues, 'title' | 'description'>, values: ProjectFormValues): UpdateProjectRequest | null {
  const patch: UpdateProjectRequest = {};
  const title = values.title.trim();
  const description = values.description.trim();

  if (title !== base.title) patch.title = title;
  if (description !== base.description) patch.description = description;

  return Object.keys(patch).length > 0 ? patch : null;
}

// The search of the Projects screen looks through the name, the folder
// and the description.
export function projectMatches(project: Pick<ProjectView, 'title' | 'slug' | 'description'>, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return [project.title, project.slug, project.description].some(text => text.toLowerCase().includes(needle));
}
