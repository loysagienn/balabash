import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appLink, appTitle, appUrlText } from './appLink.ts';

describe('app links', () => {
  it('shows the address without the scheme', () => {
    assert.equal(appUrlText('https://apps.example/kcal'), 'apps.example/kcal');
    assert.equal(appUrlText('http://localhost/a/kcal'), 'localhost/a/kcal');
  });

  it('opens a published app with a valid manifest, keeps the address of a broken one without opening it', () => {
    assert.deepEqual(appLink({ slug: 'kcal', manifestError: null }, 'https://apps.example'), { address: 'https://apps.example/kcal', href: 'https://apps.example/kcal' });
    assert.deepEqual(appLink({ slug: 'kcal', manifestError: 'bad' }, 'https://apps.example'), { address: 'https://apps.example/kcal', href: null });
    assert.deepEqual(appLink({ slug: null, manifestError: null }, 'https://apps.example'), { address: null, href: null });
    assert.deepEqual(appLink({ slug: null, manifestError: 'Invalid manifest' }, 'https://apps.example'), { address: null, href: null });
    assert.deepEqual(appLink({ slug: 'a b', manifestError: null }, 'https://apps.example'), { address: 'https://apps.example/a%20b', href: 'https://apps.example/a%20b' });
  });

  it('names an app by its manifest, else by its folder', () => {
    assert.equal(appTitle({ name: 'Calorie tracker', path: 'apps/kcal' }), 'Calorie tracker');
    assert.equal(appTitle({ name: null, path: 'apps/kcal' }), 'kcal');
    assert.equal(appTitle({ name: null, path: 'wind' }), 'wind');
  });
});
