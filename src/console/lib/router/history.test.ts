// The history process over a fake window: what the route and its fragment
// become in history, and what a popstate brings back.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Api } from '../api/index.ts';
import { createStore } from '../../store/index.ts';
import { routeTo } from '../../store/router/actions.ts';
import { connectStoreToHistory, urlOf } from './history.ts';

type Entry = { method: 'push' | 'replace'; state: unknown; url: string };

// The pieces of window the process touches: history writes, the location
// and the popstate listener.
function fakeWindow(pathname: string, search = '', hash = '') {
  const entries: Entry[] = [];
  const listeners = new Set<(event: { state: unknown }) => void>();
  const location = { pathname, search, hash };
  const win = {
    history: {
      pushState: (state: unknown, _title: string, url: string) => {
        entries.push({ method: 'push', state, url });
        const parsed = new URL(url, 'https://console.test');
        Object.assign(location, { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
      },
      replaceState: (state: unknown, _title: string, url: string) => {
        entries.push({ method: 'replace', state, url });
        const parsed = new URL(url, 'https://console.test');
        Object.assign(location, { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash });
      },
    },
    location,
    addEventListener: (_type: string, listener: (event: { state: unknown }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { state: unknown }) => void) => listeners.delete(listener),
  };

  return { win, entries, location, pop: (state: unknown) => listeners.forEach(listener => listener({ state })) };
}

describe('router — the history process', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('writes the route’s URL with its fragment and reads the fragment back on popstate', () => {
    const { win, entries, location, pop } = fakeWindow('/workspace/a.md', '', '#top');

    (globalThis as { window?: unknown }).window = win;

    const store = createStore({ api: {} as Api, initialRoute: { key: 'files', path: 'a.md' }, initialHash: '#top' });
    const disconnect = connectStoreToHistory(store);

    // The first entry: the route in state, the fragment the tab opened with kept.
    assert.deepEqual(entries, [{ method: 'replace', state: { route: { key: 'files', path: 'a.md' } }, url: '/workspace/a.md#top' }]);

    // A link to a section of another file: one push, fragment and all.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#part' }));
    assert.deepEqual(entries[1], { method: 'push', state: { route: { key: 'project', slug: 'proj', path: 'next.md' } }, url: '/projects/proj/files/next.md#part' });

    // Another section of the same file: a new entry of the same route.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#other' }));
    assert.deepEqual(entries[2], { method: 'push', state: { route: { key: 'project', slug: 'proj', path: 'next.md' } }, url: '/projects/proj/files/next.md#other' });

    // The same route and fragment again: nothing to write.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#other' }));
    assert.equal(entries.length, 3);

    // A replace keeps the entry; a route without a fragment drops it from the URL.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { replace: true }));
    assert.deepEqual(entries[3], { method: 'replace', state: { route: { key: 'project', slug: 'proj', path: 'next.md' } }, url: '/projects/proj/files/next.md' });

    // Back to the first entry: the route from its state, the fragment from the location; nothing written.
    Object.assign(location, { pathname: '/workspace/a.md', search: '', hash: '#top' });
    pop({ route: { key: 'files', path: 'a.md' } });
    assert.deepEqual(store.getState().router, { route: { key: 'files', path: 'a.md' }, source: 'history', replace: false, hash: '#top' });
    assert.equal(entries.length, 4);

    // An entry without a state (the browser's own fragment navigation): the route from the location.
    Object.assign(location, { pathname: '/agents/engineer', search: '?q=en', hash: '#x' });
    pop(null);
    assert.deepEqual(store.getState().router.route, { key: 'agents', name: 'engineer', q: 'en' });
    assert.equal(store.getState().router.hash, '#x');
    assert.equal(entries.length, 4);

    disconnect();
    store.dispatch(routeTo({ key: 'home' }));
    assert.equal(entries.length, 4);
  });

  it('composes the URL of an entry from the route and the fragment', () => {
    assert.equal(urlOf({ key: 'files', path: 'a b.md' }, '#part'), '/workspace/a%20b.md#part');
    assert.equal(urlOf({ key: 'home' }, ''), '/');
  });
});
