import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAudio } from '../dist/server.js';

test('audio URL download has a timeout signal and preserves chunked bytes', async () => {
  let request;
  const result = await loadAudio({ audio_url: 'https://example.com/hello.wav' }, async (_url, options) => {
    request = options;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }));
  });
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.filename, 'hello.wav');
});

test('oversized streaming audio is cancelled without waiting for EOF', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(loadAudio({ audio_url: 'https://example.com/large.wav' }, async () => new Response(stream)), /larger than 10 MB/);
  assert.equal(cancelled, true);
});

test('empty downloads are rejected before assessment', async () => {
  await assert.rejects(loadAudio({ audio_url: 'https://example.com/empty.wav' }, async () => new Response('')), /empty/);
});
