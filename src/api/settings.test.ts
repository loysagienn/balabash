import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NAME_MAX_LENGTH, SettingsError, parseSettingsPatch, parseUserPatch } from './settings.ts';

describe('parseSettingsPatch', () => {
  it('leaves an absent field alone and keeps only the field it knows', () => {
    assert.deepEqual(parseSettingsPatch({}), {});
    assert.deepEqual(parseSettingsPatch({ workspaceName: 'Home', displayName: 'Vladimir', other: 1 }), { workspaceName: 'Home' });
  });

  it('trims a name and clears on null, empty and blank', () => {
    assert.deepEqual(parseSettingsPatch({ workspaceName: '  Personal ' }), { workspaceName: 'Personal' });
    assert.deepEqual(parseSettingsPatch({ workspaceName: null }), { workspaceName: null });
    assert.deepEqual(parseSettingsPatch({ workspaceName: '' }), { workspaceName: null });
    assert.deepEqual(parseSettingsPatch({ workspaceName: '   ' }), { workspaceName: null });
  });

  it('refuses another type and a name over the cap', () => {
    assert.throws(() => parseSettingsPatch({ workspaceName: 42 }), (error: unknown) => error instanceof SettingsError && error.message === 'workspaceName must be a string');
    assert.throws(() => parseSettingsPatch({ workspaceName: ['x'] }), SettingsError);
    assert.deepEqual(parseSettingsPatch({ workspaceName: 'a'.repeat(NAME_MAX_LENGTH) }), { workspaceName: 'a'.repeat(NAME_MAX_LENGTH) });
    assert.throws(() => parseSettingsPatch({ workspaceName: 'a'.repeat(NAME_MAX_LENGTH + 1) }), (error: unknown) => error instanceof SettingsError && error.message === `workspaceName must be at most ${NAME_MAX_LENGTH} chars`);
  });
});

describe('parseUserPatch', () => {
  it('reads the user’s name by the same rule', () => {
    assert.deepEqual(parseUserPatch({}), {});
    assert.deepEqual(parseUserPatch({ workspaceName: 'Home' }), {});
    assert.deepEqual(parseUserPatch({ displayName: ' Vladimir ' }), { displayName: 'Vladimir' });
    assert.deepEqual(parseUserPatch({ displayName: '   ' }), { displayName: null });
    assert.deepEqual(parseUserPatch({ displayName: null }), { displayName: null });
    assert.throws(() => parseUserPatch({ displayName: 42 }), (error: unknown) => error instanceof SettingsError && error.message === 'displayName must be a string');
    assert.throws(() => parseUserPatch({ displayName: 'a'.repeat(NAME_MAX_LENGTH + 1) }), SettingsError);
  });
});
