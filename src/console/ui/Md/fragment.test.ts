import assert from 'node:assert/strict';
import { test } from 'node:test';
import rehypeSlug from 'rehype-slug';
import { HEADING_IDS, HEADING_ID_PREFIX, fragmentIds, fragmentTarget, headingId } from './fragment.ts';

test('fragmentIds: the decoded fragment first, then the one written', () => {
  assert.deepEqual(fragmentIds('#anchors'), ['anchors']);
  assert.deepEqual(fragmentIds('anchors'), ['anchors']);
  assert.deepEqual(fragmentIds('#%D0%BA%D0%B8'), ['ки', '%D0%BA%D0%B8']);
  assert.deepEqual(fragmentIds('#a%20b'), ['a b', 'a%20b']);
});

test('fragmentIds: nothing to name', () => {
  assert.deepEqual(fragmentIds(''), []);
  assert.deepEqual(fragmentIds('#'), []);
});

test('fragmentIds: a fragment that does not decode is tried as written', () => {
  assert.deepEqual(fragmentIds('#%E0%A4%A'), ['%E0%A4%A']);
  assert.deepEqual(fragmentIds('#100%'), ['100%']);
});

// The tree rehype-slug walks: the headings of a document, as react-markdown
// hands them over (hast). Built by hand — the renderer itself is JSX.
type Tree = Parameters<ReturnType<typeof rehypeSlug>>[0];

const heading = (rank: number, text: string): Tree['children'][number] => ({
  type: 'element',
  tagName: `h${rank}`,
  properties: {},
  children: [{ type: 'text', value: text }],
});

function headingIdsOf(...texts: string[]): string[] {
  const tree: Tree = { type: 'root', children: texts.map(text => heading(2, text)) };

  rehypeSlug(HEADING_IDS)(tree);

  return tree.children.map(node => (node.type === 'element' ? String(node.properties.id) : ''));
}

test('heading ids: the GitHub slug of the text in the namespace of the document, never an id of the interface', () => {
  assert.equal(HEADING_ID_PREFIX, 'user-content-');
  assert.deepEqual(headingIdsOf('Edit project', 'Edit project title', 'Root', 'Кириллица', 'Anchors'), [
    'user-content-edit-project',
    'user-content-edit-project-title',
    'user-content-root',
    'user-content-кириллица',
    'user-content-anchors',
  ]);

  // The ids of the interface a heading could otherwise take: the form of
  // "Edit project" and its fields, the app's root.
  for (const id of headingIdsOf('Edit project', 'Edit project title', 'Root', 'edit-project', 'root')) {
    assert.ok(id.startsWith(HEADING_ID_PREFIX), id);
    assert.notEqual(id, 'edit-project');
    assert.notEqual(id, 'edit-project-title');
    assert.notEqual(id, 'root');
  }
});

test('heading ids: repeated headings stay distinct, the prefix does not fold them', () => {
  assert.deepEqual(headingIdsOf('A', 'A', 'a', 'A 1', 'user-content-a'), [
    'user-content-a',
    'user-content-a-1',
    'user-content-a-2',
    'user-content-a-1-1',
    'user-content-user-content-a',
  ]);
  // A second document starts afresh: the slugs of the first are forgotten.
  assert.deepEqual(headingIdsOf('A'), ['user-content-a']);
});

// A document's root as fragmentTarget reads it: the elements carrying an id.
const rootOf = (...ids: string[]): ParentNode => ({ querySelectorAll: () => ids.map(id => ({ id })) }) as unknown as ParentNode;

test('fragmentTarget: the fragment names the heading of its slug', () => {
  const root = rootOf(headingId('anchors'), headingId('edit-project'), headingId('edit-project-1'), headingId('кириллица'));

  assert.equal(fragmentTarget(root, '#anchors')?.id, 'user-content-anchors');
  assert.equal(fragmentTarget(root, '#edit-project')?.id, 'user-content-edit-project');
  assert.equal(fragmentTarget(root, '#edit-project-1')?.id, 'user-content-edit-project-1');
  // Percent-encoded as the browser writes it, and as written.
  assert.equal(fragmentTarget(root, '#%D0%BA%D0%B8%D1%80%D0%B8%D0%BB%D0%BB%D0%B8%D1%86%D0%B0')?.id, 'user-content-кириллица');
  assert.equal(fragmentTarget(root, '#кириллица')?.id, 'user-content-кириллица');
  assert.equal(fragmentTarget(root, '#nowhere'), null);
  assert.equal(fragmentTarget(root, ''), null);
  assert.equal(fragmentTarget(root, '#'), null);
});

test('fragmentTarget: an id of the interface is not a section, a fragment with the prefix is not a slug', () => {
  // The form of "Edit project" and the app's root inside the searched
  // root (they are not, but the rule must not depend on that), next to
  // the heading of the same slug.
  const root = rootOf('edit-project', 'root', headingId('edit-project'));

  assert.equal(fragmentTarget(root, '#edit-project')?.id, 'user-content-edit-project');
  assert.equal(fragmentTarget(root, '#root'), null);
  assert.equal(fragmentTarget(root, '#user-content-edit-project'), null);
  assert.equal(fragmentTarget(rootOf('edit-project', 'root'), '#edit-project'), null);
});

test('fragmentTarget: a fragment that decodes to nothing present falls back to the one written', () => {
  const root = rootOf(headingId('a%20b'), headingId('100%'));

  assert.equal(fragmentTarget(root, '#a%20b')?.id, 'user-content-a%20b');
  assert.equal(fragmentTarget(root, '#100%')?.id, 'user-content-100%');
});
