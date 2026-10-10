import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorWords, isConsoleWord, loginDestination, submitLabel } from './SignIn.logic.ts';

describe('sign-in logic', () => {
  it('knows the word that asks for a code', () => {
    assert.ok(isConsoleWord('console'));
    assert.ok(isConsoleWord(' Console '));
    assert.ok(isConsoleWord('CONSOLE'));
    assert.equal(isConsoleWord('K7QM2X'), false);
    assert.equal(isConsoleWord('console1'), false);
  });

  it('names what the button waits for', () => {
    assert.equal(submitLabel(null), 'Sign in');
    assert.equal(submitLabel('sign-in'), 'Signing in');
    assert.equal(submitLabel('console-code'), 'Requesting a code');
  });

  it('words a refused code and passes the server on anything else', () => {
    assert.equal(errorWords({ status: 401, code: 'invalid_code', message: 'The code is invalid or expired — request a new one' }), 'Invalid or expired code.');
    assert.equal(errorWords({ status: 429, code: 'rate_limited', message: 'A login code was printed moments ago — look at the server log' }), 'A login code was printed moments ago — look at the server log');
    assert.equal(errorWords({ status: 0, code: 'network', message: 'Failed to fetch' }), 'Failed to fetch');
  });

  it('leads the signed-in door on', () => {
    const home = { kind: 'route', route: { key: 'home' }, hash: '' };

    assert.deepEqual(loginDestination(undefined), home);
    assert.deepEqual(loginDestination('//evil.example/'), home);
    assert.deepEqual(loginDestination('/login?next=%2Fthreads'), home);
    assert.deepEqual(loginDestination('/threads?status=active'), { kind: 'route', route: { key: 'threads', status: 'active' }, hash: '' });
    assert.deepEqual(loginDestination('/workspace/notes.md#plan'), { kind: 'route', route: { key: 'files', path: 'notes.md' }, hash: '#plan' });
    assert.deepEqual(loginDestination('/apps/notes?tab=1'), { kind: 'url', url: '/apps/notes?tab=1' });
    assert.deepEqual(loginDestination('/connect/gmail'), { kind: 'url', url: '/connect/gmail' });
  });
});
