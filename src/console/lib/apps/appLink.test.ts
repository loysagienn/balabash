import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appLink, appTitle, appUrlText, ownerAppHref, publicAppAddress } from './appLink.ts';

describe('app links', () => {
  it('shows the address without the scheme', () => {
    assert.equal(appUrlText('https://apps.example/kcal'), 'apps.example/kcal');
    assert.equal(appUrlText('http://localhost/a/kcal'), 'localhost/a/kcal');
  });

  it('opens a published app with a valid manifest, keeps the address of a broken one without opening it', () => {
    const owner = '/apps/apps/kcal';

    assert.deepEqual(appLink({ path: 'apps/kcal', slug: 'kcal', manifestError: null }, 'https://apps.example'), { address: 'https://apps.example/kcal', href: 'https://apps.example/kcal', owner, open: 'https://apps.example/kcal' });
    assert.deepEqual(appLink({ path: 'apps/kcal', slug: 'kcal', manifestError: 'bad' }, 'https://apps.example'), { address: 'https://apps.example/kcal', href: null, owner, open: null });
    // Unpublished: "Open" is the owner page; a broken manifest opens nothing.
    assert.deepEqual(appLink({ path: 'apps/kcal', slug: null, manifestError: null }, 'https://apps.example'), { address: null, href: null, owner, open: owner });
    assert.deepEqual(appLink({ path: 'apps/kcal', slug: null, manifestError: 'Invalid manifest' }, 'https://apps.example'), { address: null, href: null, owner, open: null });
    assert.deepEqual(appLink({ path: 'apps/kcal', slug: 'a b', manifestError: null }, 'https://apps.example'), { address: 'https://apps.example/a%20b', href: 'https://apps.example/a%20b', owner, open: 'https://apps.example/a%20b' });
  });

  it('builds the owner page and the public address by segments', () => {
    assert.equal(ownerAppHref('renovation/app'), '/apps/renovation/app');
    assert.equal(ownerAppHref('a b/c#1'), '/apps/a%20b/c%231');
    assert.equal(publicAppAddress('https://apps.example', 'kcal'), 'https://apps.example/kcal');
  });

  it('names an app by its manifest, else by its folder', () => {
    assert.equal(appTitle({ name: 'Calorie tracker', path: 'apps/kcal' }), 'Calorie tracker');
    assert.equal(appTitle({ name: null, path: 'apps/kcal' }), 'kcal');
    assert.equal(appTitle({ name: null, path: 'wind' }), 'wind');
  });
});
