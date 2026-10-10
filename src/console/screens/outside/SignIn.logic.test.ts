import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRoute } from '../../lib/router/routes.ts';
import { errorWords, isConsoleWord, loginDestination, submitLabel } from './SignIn.logic.ts';
import type { LoginDestination } from './SignIn.logic.ts';

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
    assert.equal(submitLabel({ kind: 'sign-in' }), 'Signing in');
    assert.equal(submitLabel({ kind: 'console-code' }), 'Requesting a code');
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

  // The whole chain of the door, as a link would run it: the URL of the
  // tab → the route's next → the destination → the origin the browser
  // would navigate to. The destination is the parsed form (a backslash
  // read as a slash, a control character between the slashes dropped), so
  // the check and the navigation never read two different URLs.
  it('never leads off this host, whatever the next looked like', () => {
    const HOST = 'https://console.test';
    const home = { kind: 'route', route: { key: 'home' }, hash: '' };
    const destinationOf = (url: string): LoginDestination => {
      const route = readRoute(url);

      assert.equal(route.key, 'login', url);

      return loginDestination(route.key === 'login' ? route.next : undefined);
    };
    const foreign = ['%2F%2Fevil.example%2Fx', '%2F%5Cevil.example%2Fx', '%2F%09%2Fevil.example%2Fx', '%2F%0A%2Fevil.example%2Fx', '%2F%0D%2Fevil.example%2Fx', '%2F%09%5Cevil.example%2Fx', '%2F%0A%5Cevil.example%2Fx', '%2F%0D%5Cevil.example%2Fx', '%2F%5C%5Cevil.example', '%2F%09%09%2F%2Fevil.example', 'https%3A%2F%2Fevil.example%2F', 'javascript%3Aalert(1)', 'evil.example', ''];

    for (const next of foreign) {
      assert.deepEqual(destinationOf(`/login?next=${next}`), home, next);
    }

    // A path the SPA does not serve, written with a control character or a
    // dot segment: the navigation is by the parsed path of this host.
    const local = ['%2Fapps%2Fnotes%3Ftab%3D1', '%2F%09apps%2Fnotes', '%2Fapps%2F.%2Fnotes%2F..%2Fother', '%2F%2525%2Fx', '%2Fconnect%2Fgmail%23top'];

    for (const next of local) {
      const destination = destinationOf(`/login?next=${next}`);

      assert.equal(destination.kind, 'url', next);

      if (destination.kind === 'url') {
        assert.equal(new URL(destination.url, HOST).origin, HOST, next);
      }
    }

    assert.deepEqual(destinationOf('/login?next=%2F%09apps%2Fnotes'), { kind: 'url', url: '/apps/notes' });
    assert.deepEqual(destinationOf('/login?next=%2Fapps%2F.%2Fnotes%2F..%2Fother'), { kind: 'url', url: '/apps/other' });
    assert.deepEqual(destinationOf('/login?next=%2Fthreads%3Fstatus%3Dactive%23row'), { kind: 'route', route: { key: 'threads', status: 'active' }, hash: '#row' });
    // The string itself, should a caller hand it over unparsed.
    assert.deepEqual(loginDestination('/\t/evil.example/x'), home);
    assert.deepEqual(loginDestination('/\n\\evil.example/x'), home);
  });
});
