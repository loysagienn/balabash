import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NAME_MAX_LENGTH, SettingsError, parseSettingsPatch } from './settings.ts';

describe('parseSettingsPatch', () => {
  it('leaves an absent field alone and keeps only the fields it knows', () => {
    assert.deepEqual(parseSettingsPatch({}), {});
    assert.deepEqual(parseSettingsPatch({ operatorName: 'Vladimir', other: 1 }), { operatorName: 'Vladimir' });
  });

  it('trims a name and clears on null, empty and blank', () => {
    assert.deepEqual(parseSettingsPatch({ workspaceName: '  Personal ' }), { workspaceName: 'Personal' });
    assert.deepEqual(parseSettingsPatch({ workspaceName: null, operatorName: '' }), { workspaceName: null, operatorName: null });
    assert.deepEqual(parseSettingsPatch({ operatorName: '   ' }), { operatorName: null });
  });

  it('refuses another type and a name over the cap', () => {
    assert.throws(() => parseSettingsPatch({ workspaceName: 42 }), (error: unknown) => error instanceof SettingsError && error.message === 'workspaceName must be a string');
    assert.throws(() => parseSettingsPatch({ operatorName: ['x'] }), SettingsError);
    assert.deepEqual(parseSettingsPatch({ operatorName: 'a'.repeat(NAME_MAX_LENGTH) }), { operatorName: 'a'.repeat(NAME_MAX_LENGTH) });
    assert.throws(() => parseSettingsPatch({ operatorName: 'a'.repeat(NAME_MAX_LENGTH + 1) }), (error: unknown) => error instanceof SettingsError && error.message === `operatorName must be at most ${NAME_MAX_LENGTH} chars`);
  });
});
