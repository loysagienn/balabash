import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentFacts, needsMeta } from './attachments.ts';
import type { Attachment } from './project.ts';

const stored = (facts: Partial<Attachment>): Attachment => ({ key: 'k', href: '/api/files/f1', fileId: 'f1', name: null, image: false, size: null, ...facts });
const meta = { fileId: 'f1', name: 'voucher.pdf', contentType: 'application/pdf', sizeBytes: 2048, width: null, height: null };

describe('needsMeta', () => {
  it('asks the meta for a stored file the event did not name, never for a named one or a link', () => {
    assert.equal(needsMeta(stored({})), true);
    assert.equal(needsMeta(stored({ image: true })), true);
    assert.equal(needsMeta(stored({ name: 'shot.png' })), false);
    assert.equal(needsMeta({ key: 'k', href: 'https://x/y.md', fileId: null, name: 'y.md', image: false, size: 40 }), false);
  });
});

describe('attachmentFacts', () => {
  it('reads the facts the event recorded first', () => {
    assert.deepEqual(attachmentFacts(stored({ name: 'shot.png', image: true, size: 1200 }), meta), { name: 'shot.png', image: true, size: 1200 });
  });

  it('reads the meta for a file named by id alone — the name, the size and an image by its content type', () => {
    assert.deepEqual(attachmentFacts(stored({}), meta), { name: 'voucher.pdf', image: false, size: 2048 });
    assert.deepEqual(attachmentFacts(stored({}), { ...meta, name: 'shot.png', contentType: 'Image/PNG', sizeBytes: 9 }), { name: 'shot.png', image: true, size: 9 });
    // The event's image block stays an image whatever the meta says.
    assert.deepEqual(attachmentFacts(stored({ image: true }), { ...meta, contentType: null }), { name: 'voucher.pdf', image: true, size: 2048 });
  });

  it('is the word of the kind while the meta is not there, or when it names nothing', () => {
    assert.deepEqual(attachmentFacts(stored({}), undefined), { name: 'file', image: false, size: null });
    assert.deepEqual(attachmentFacts(stored({ image: true }), null), { name: 'image', image: true, size: null });
    assert.deepEqual(attachmentFacts(stored({}), { ...meta, name: null, contentType: 'image/jpeg', sizeBytes: null }), { name: 'image', image: true, size: null });
  });
});
