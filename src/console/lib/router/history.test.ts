// The history process over a fake window: what the route and its fragment
// become in history, what a popstate brings back, and the scroll place an
// entry keeps while it is away.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Api } from '../api/index.ts';
import { createStore } from '../../store/index.ts';
import { routeTo } from '../../store/router/actions.ts';
import { connectStoreToHistory, urlOf } from './history.ts';
import { readRoute } from './routes.ts';

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

// The entry's state is the route and an id; the id is the process's own.
function stateOf(entry: Entry): { route: unknown; entry: string } {
  const state = entry.state as { route: unknown; entry: unknown };

  assert.equal(typeof state.entry, 'string');

  return state as { route: unknown; entry: string };
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
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.method, 'replace');
    assert.equal(entries[0]!.url, '/workspace/a.md#top');
    assert.deepEqual(stateOf(entries[0]!).route, { key: 'files', path: 'a.md' });

    const first = stateOf(entries[0]!);

    // A link to a section of another file: one push, fragment and all, a new entry.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#part' }));
    assert.equal(entries[1]!.method, 'push');
    assert.equal(entries[1]!.url, '/projects/proj/files/next.md#part');
    assert.deepEqual(stateOf(entries[1]!).route, { key: 'project', slug: 'proj', path: 'next.md' });
    assert.notEqual(stateOf(entries[1]!).entry, first.entry);

    // Another section of the same file: a new entry of the same route.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#other' }));
    assert.equal(entries[2]!.method, 'push');
    assert.equal(entries[2]!.url, '/projects/proj/files/next.md#other');
    assert.notEqual(stateOf(entries[2]!).entry, stateOf(entries[1]!).entry);

    // The same route and fragment again: nothing to write.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { hash: '#other' }));
    assert.equal(entries.length, 3);

    // A replace keeps the entry (the same page); a route without a fragment drops it from the URL.
    store.dispatch(routeTo({ key: 'project', slug: 'proj', path: 'next.md' }, { replace: true }));
    assert.equal(entries[3]!.method, 'replace');
    assert.equal(entries[3]!.url, '/projects/proj/files/next.md');
    assert.equal(stateOf(entries[3]!).entry, stateOf(entries[2]!).entry);

    // Back to the first entry: the route from its state, the fragment from the location; nothing written.
    Object.assign(location, { pathname: '/workspace/a.md', search: '', hash: '#top' });
    pop(first);
    assert.deepEqual(store.getState().router, { route: { key: 'files', path: 'a.md' }, source: 'history', replace: false, hash: '#top', scroll: null });
    assert.equal(entries.length, 4);

    // An entry without a state (the browser's own fragment navigation): the route from the location.
    Object.assign(location, { pathname: '/agents/engineer', search: '?q=en', hash: '#x' });
    pop(null);
    assert.deepEqual(store.getState().router.route, { key: 'agents', name: 'engineer', q: 'en' });
    assert.equal(store.getState().router.hash, '#x');
    assert.equal(store.getState().router.scroll, null);
    assert.equal(entries.length, 4);

    disconnect();
    store.dispatch(routeTo({ key: 'home' }));
    assert.equal(entries.length, 4);
  });

  it('keeps the scroll place of an entry while it is away and brings it back with the popstate', () => {
    const { win, entries, location, pop } = fakeWindow('/threads');

    (globalThis as { window?: unknown }).window = win;

    let place: number | null = 0;
    const store = createStore({ api: {} as Api, initialRoute: { key: 'threads' } });
    const disconnect = connectStoreToHistory(store, { readScroll: () => place });
    const list = stateOf(entries[0]!);

    // The list is left at 480 for a thread; the thread at 1200 for the project.
    place = 480;
    store.dispatch(routeTo({ key: 'thread', id: 't1' }));
    const thread = stateOf(entries[1]!);

    place = 1200;
    store.dispatch(routeTo({ key: 'project', slug: 'p' }));
    const project = stateOf(entries[2]!);

    // Back to the thread: its place comes with the route; the project's own place (90) is kept.
    place = 90;
    Object.assign(location, { pathname: '/threads/t1', search: '', hash: '' });
    pop(thread);
    assert.deepEqual(store.getState().router, { route: { key: 'thread', id: 't1' }, source: 'history', replace: false, hash: '', scroll: 1200 });

    // Back again to the list: 480. The thread is left at 15 this time.
    place = 15;
    Object.assign(location, { pathname: '/threads', search: '', hash: '' });
    pop(list);
    assert.equal(store.getState().router.scroll, 480);

    // Forward twice: the thread at 15 (not 1200), the project at 90.
    Object.assign(location, { pathname: '/threads/t1', search: '', hash: '' });
    pop(thread);
    assert.equal(store.getState().router.scroll, 15);
    Object.assign(location, { pathname: '/projects/p', search: '', hash: '' });
    pop(project);
    assert.equal(store.getState().router.scroll, 90);

    // A replace is the same page: the place kept under the entry survives it.
    store.dispatch(routeTo({ key: 'project', slug: 'p', path: 'docs' }, { replace: true }));
    assert.equal(stateOf(entries[3]!).entry, project.entry);
    place = 300;
    store.dispatch(routeTo({ key: 'home' }));
    Object.assign(location, { pathname: '/projects/p/files/docs', search: '', hash: '' });
    pop(stateOf(entries[3]!));
    assert.equal(store.getState().router.scroll, 300);

    // No body to read (no shell on the screen): nothing new kept, the place known before stays.
    place = null;
    store.dispatch(routeTo({ key: 'home' }));
    Object.assign(location, { pathname: '/projects/p/files/docs', search: '', hash: '' });
    pop(stateOf(entries[3]!));
    assert.equal(store.getState().router.scroll, 300);

    // An entry the process did not write has no id: nothing is kept for it
    // and nothing brought back; the entry left for it keeps its place as ever.
    place = 50;
    Object.assign(location, { pathname: '/agents', search: '', hash: '' });
    pop(null);
    assert.equal(store.getState().router.scroll, null);
    place = 70;
    Object.assign(location, { pathname: '/projects/p/files/docs', search: '', hash: '' });
    pop(stateOf(entries[3]!));
    assert.equal(store.getState().router.scroll, 50);
    Object.assign(location, { pathname: '/agents', search: '', hash: '' });
    pop(null);
    assert.equal(store.getState().router.scroll, null);

    disconnect();
  });

  it('tells two entries of one URL apart: each brings back its own place', () => {
    // A filtered list (A), the section's own link (B), the filter chosen again
    // on B — a replace gives B the URL of A, under its own id.
    const { win, entries, location, pop } = fakeWindow('/threads', '?agent=engineer');

    (globalThis as { window?: unknown }).window = win;

    let place: number | null = 0;
    const store = createStore({ api: {} as Api, initialRoute: readRoute('/threads?agent=engineer') });
    const disconnect = connectStoreToHistory(store, { readScroll: () => place });
    const a = stateOf(entries[0]!);

    place = 600;
    store.dispatch(routeTo({ key: 'threads' }));
    assert.equal(entries[1]!.method, 'push');
    assert.equal(entries[1]!.url, '/threads');

    store.dispatch(routeTo(readRoute('/threads?agent=engineer'), { replace: true }));
    assert.equal(entries[2]!.method, 'replace');
    assert.equal(entries[2]!.url, '/threads?agent=engineer');

    const b = stateOf(entries[2]!);

    assert.equal(b.entry, stateOf(entries[1]!).entry);
    assert.notEqual(b.entry, a.entry);

    // Back from B (left at 200) to A: the URL does not change, the state does — with A's 600.
    place = 200;
    const onB = store.getState().router;

    pop(a);

    const onA = store.getState().router;

    assert.notEqual(onA, onB);
    assert.equal(onA.route, onB.route);
    assert.deepEqual(onA, { route: { key: 'threads', agent: 'engineer' }, source: 'history', replace: false, hash: '', scroll: 600 });
    assert.equal(entries.length, 3);

    // The reader moves A to 100; Forward brings B's own 200, not A's place.
    place = 100;
    pop(b);
    assert.notEqual(store.getState().router, onA);
    assert.equal(store.getState().router.scroll, 200);

    // Both entries left at 200: Back and Forward bring equal places as two states.
    place = 200;
    pop(a);

    const backAgain = store.getState().router;

    assert.equal(backAgain.scroll, 100);
    place = 200;
    pop(b);

    const forwardAgain = store.getState().router;

    assert.equal(forwardAgain.scroll, 200);
    pop(a);
    assert.equal(store.getState().router.scroll, 200);
    assert.notEqual(store.getState().router, forwardAgain);
    assert.deepEqual(store.getState().router, forwardAgain);
    assert.equal(location.search, '?agent=engineer');

    disconnect();
  });

  it('composes the URL of an entry from the route and the fragment', () => {
    assert.equal(urlOf({ key: 'files', path: 'a b.md' }, '#part'), '/workspace/a%20b.md#part');
    assert.equal(urlOf({ key: 'home' }, ''), '/');
  });
});
