import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { BodyTooLargeError, declaredLength, limitedBody } from './upload-body.ts';

// A request as limitedBody reads it: a stream whose `complete` turns true
// once the whole body has been read (node's IncomingMessage does so).
function fakeRequest(): PassThrough & { complete: boolean } {
  const request = Object.assign(new PassThrough(), { complete: false });

  request.on('end', () => {
    request.complete = true;
  });

  return request;
}

async function drain(stream: NodeJS.ReadableStream): Promise<number> {
  let size = 0;

  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
  }

  return size;
}

test('limitedBody passes a body up to the limit and fails past it, counted while reading', async () => {
  const fits = fakeRequest();
  const fitting = limitedBody(fits as unknown as IncomingMessage, 10);

  fits.end(Buffer.alloc(10));
  assert.equal(await drain(fitting), 10);

  const over = fakeRequest();
  const counted = limitedBody(over as unknown as IncomingMessage, 10);

  over.write(Buffer.alloc(6));
  over.end(Buffer.alloc(6));
  await assert.rejects(drain(counted), BodyTooLargeError);
});

test('limitedBody fails when the client leaves before the end', async () => {
  const request = fakeRequest();
  const body = limitedBody(request as unknown as IncomingMessage, 100);

  request.write(Buffer.alloc(5));
  setImmediate(() => request.emit('close'));
  await assert.rejects(drain(body), /closed the upload/);
});

test('declaredLength reads the header: a number, null when absent, NaN for anything else', () => {
  assert.equal(declaredLength('42'), 42);
  assert.equal(declaredLength(''), null);
  assert.ok(Number.isNaN(declaredLength('4 2')));
  assert.ok(Number.isNaN(declaredLength('-1')));
});
