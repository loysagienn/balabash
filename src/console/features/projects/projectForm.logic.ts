// The rules of the project form, shared by "New project" and "Edit
// project": the folder derived from the name, the checks the server makes
// (src/projects/mutations.ts — the caps and the slug rule are the server's
// law, repeated here so a mistake shows under the field before the call),
// which field a server refusal belongs to, the patch of an edit. Pure,
// tested.

import type { ProjectView, UpdateProjectRequest } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { ProjectFormState } from '../../store/projects/reducer.ts';

export const TITLE_MAX_LENGTH = 200;
export const SLUG_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 2_000;
export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export type ProjectFormValues = { title: string; slug: string; description: string };
export type ProjectFormField = keyof ProjectFormValues;
export type ProjectFormErrors = Partial<Record<ProjectFormField, string>>;

// Cyrillic letters to Latin for the folder name (a Russian title is the
// usual case; the rest of Unicode is dropped by the slug rule).
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
};

// "Bathroom renovation" → "bathroom-renovation", "Ремонт ванной" →
// "remont-vannoy": lowercase, letters and digits, one dash between words,
// a letter first (the slug rule), at most 64 characters, never ending in
// a dash.
export function slugFromTitle(title: string): string {
  // Cyrillic first: NFD would split й and ё into a base letter and a mark.
  const latin = title
    .toLowerCase()
    .replace(/[\u0400-\u04ff]/g, letter => CYRILLIC[letter] ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const words = latin.replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '');

  return words.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
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

// One submit of a dialog is an attempt: the store's accepted count at the
// moment of the submit. The attempt is over when the count moved (the
// dialog closes — that very call was accepted) or when the store holds a
// refusal and no call is in flight (the dialog shows it). Input typed
// while the call is still running belongs to the same attempt — its
// answer is still owed, a refusal must show; input typed after a refusal
// dismisses it (a new attempt begins with the next submit).
export type FormAttempt = { done: number };

export function attemptAccepted(attempt: FormAttempt | null, form: Pick<ProjectFormState, 'done'>): boolean {
  return attempt !== null && form.done !== attempt.done;
}

export function attemptRefusal(attempt: FormAttempt | null, form: Pick<ProjectFormState, 'pending' | 'error'>): ApiFailure | null {
  return attempt !== null && !form.pending ? form.error : null;
}

export function attemptAfterInput(attempt: FormAttempt | null, form: Pick<ProjectFormState, 'pending'>): FormAttempt | null {
  return form.pending ? attempt : null;
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
