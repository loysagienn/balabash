// The settings patch of the console (PATCH /api/settings): the workspace's
// own name and the operator's name. Pure: the transport (src/api/api.ts)
// reads the body and answers the status, the row is written there too.
//
// A field absent from the body is left alone; a null, empty or blank field
// clears the stored value (the workspace then goes by the bound Telegram
// group's title again, the operator has no name); a string is trimmed and
// capped — a field of another type is a refusal, never a "keep".

export const NAME_MAX_LENGTH = 100;

export type SettingsPatch = {
  workspaceName?: string | null;
  operatorName?: string | null;
};

export type SettingsField = keyof SettingsPatch;

export const SETTINGS_FIELDS: readonly SettingsField[] = ['workspaceName', 'operatorName'];

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

function name(field: SettingsField, value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new SettingsError(`${field} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length > NAME_MAX_LENGTH) {
    throw new SettingsError(`${field} must be at most ${NAME_MAX_LENGTH} chars`);
  }

  return trimmed || null;
}

export function parseSettingsPatch(raw: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};

  for (const field of SETTINGS_FIELDS) {
    const value = name(field, raw[field]);

    if (value !== undefined) {
      patch[field] = value;
    }
  }

  return patch;
}
