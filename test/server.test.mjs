// Offline tests: a local mock of api.toneperfect.app + the real server over stdio via the MCP SDK client.
// Run: npm test
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deriveIdempotencyKey } from '../dist/client.js';
import { explainAssessment } from '../dist/summarize.js';

const here = dirname(fileURLToPath(import.meta.url));
const ASSESSMENT = {
  id: 'req_test1', locale: 'zh-CN', language: 'zh', model_version: 'mandarin-human-v2-test', task: 'general', status: 'completed',
  assessable: true, reason: null,
  scores: { overall: 82.4, pronunciation: 80.1, initial: 90, final: 85, tone: 61.2, fluency: null, rhythm: null, integrity: null },
  words: [
    { word: '你', pinyin: 'ni3', score: 91, start_ms: 0, end_ms: 150, phones: [
      { dimension: 'initial', expected: 'n', heard: 'n', score: 95, decision: 'no_correction' },
      { dimension: 'tone', expected: 3, heard: 3, score: 90, decision: 'no_correction' }] },
    { word: '好', pinyin: 'hao3', score: 64, start_ms: 150, end_ms: 420, phones: [
      { dimension: 'initial', expected: 'h', heard: 'h', score: 92, decision: 'no_correction' },
      { dimension: 'tone', expected: 3, heard: 4, score: 38.5, decision: 'review' }] },
  ],
  billing: { credits: 1, balance_credits: 49 },
};

let server, baseUrl, requests = [], mode = 'ok', tmp, audioPath;

function parseMultipart(body, contentType) {
  const boundary = contentType.split('boundary=')[1];
  const fields = {};
  for (const part of body.toString('latin1').split('--' + boundary)) {
    const m = part.match(/name="([^"]+)"(?:; filename="([^"]+)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/);
    if (m) fields[m[1]] = m[2] ? { filename: m[2], bytes: Buffer.from(m[3], 'latin1') } : Buffer.from(m[3], 'latin1').toString('utf8');
  }
  return fields;
}

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const rec = { method: req.method, url: req.url, headers: req.headers };
      if (req.headers['content-type']?.startsWith('multipart/')) rec.fields = parseMultipart(body, req.headers['content-type']);
      requests.push(rec);
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url === '/v1/capabilities') return send(200, { model_version: 'x', languages: [{ locale: 'zh-CN', name: 'Mandarin Chinese', available: true, status: 'experimental', dimensions: ['pronunciation', 'tone'] }, { locale: 'ko-KR', name: 'Korean', available: true, status: 'experimental', dimensions: ['pronunciation'] }], limits: { max_audio_seconds: 30, max_upload_bytes: 10485760, concurrent_requests_per_account: 2 } });
      if (req.url === '/v1/assess') {
        if (mode === '401') return send(401, { error: { code: 'invalid_api_key', message: 'Unknown API key.' }, request_id: 'req_401' });
        if (mode === '402') return send(402, { error: { code: 'subscription_required', message: 'Free credits are used up.' }, request_id: 'req_402' });
        if (mode === '429') return send(429, { error: { code: 'rate_limit', message: 'Slow down.' } }, { 'retry-after': '2' });
        if (mode === 'unassessable') return send(200, { assessable: false, reason: 'silence', scores: { overall: null }, billing: { credits: 0, balance_credits: 49 } });
        return send(200, ASSESSMENT, { 'x-request-id': 'req_test1', ...(mode === 'replay' ? { 'idempotent-replayed': 'true' } : {}) });
      }
      send(404, { error: { code: 'not_found', message: 'no' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tmp = await mkdtemp(join(tmpdir(), 'tp-mcp-'));
  audioPath = join(tmp, 'hello.wav');
  await writeFile(audioPath, Buffer.from('RIFF0000WAVEfake-audio-bytes'));
});

after(() => server.close());

async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, '..', 'dist', 'index.js')],
    env: { PATH: process.env.PATH, TONEPERFECT_BASE_URL: baseUrl, TONEPERFECT_API_KEY: 'tp_live_testkey', ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test('lists three tools with annotations', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['assess_pronunciation', 'explain_result', 'list_languages']);
  const assess = tools.find((t) => t.name === 'assess_pronunciation');
  assert.equal(assess.annotations.readOnlyHint, false);
  assert.ok(assess.inputSchema.properties.language.enum.includes('ja-JP'));
  assert.equal(tools.find((t) => t.name === 'list_languages').annotations.readOnlyHint, true);
  await client.close();
});

test('list_languages calls GET /v1/capabilities without a key and marks beta languages', async () => {
  requests = [];
  const client = await connect();
  const r = await client.callTool({ name: 'list_languages', arguments: {} });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /zh-CN Mandarin Chinese/);
  assert.match(r.content[0].text, /ko-KR Korean \[experimental, beta\]/);
  assert.equal(r.structuredContent.limits.max_audio_seconds, 30);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].headers.authorization, undefined);
  await client.close();
});

test('assess_pronunciation from a file path sends the real contract and summarises', async () => {
  requests = []; mode = 'ok';
  const client = await connect();
  const r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_path: audioPath, text: '你好', language: 'zh-CN', pinyin: 'ni3 hao3', task: 'connected_speech' } });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  const req = requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/assess');
  assert.equal(req.headers.authorization, 'Bearer tp_live_testkey');
  assert.match(req.headers['idempotency-key'], /^mcp-[0-9a-f]{48}$/);
  assert.match(req.headers['user-agent'], /^toneperfect-mcp\//);
  assert.equal(req.fields.text, '你好');
  assert.equal(req.fields.language, 'zh-CN');
  assert.equal(req.fields.pinyin, 'ni3 hao3');
  assert.equal(req.fields.task, 'connected_speech');
  assert.equal(req.fields.audio.filename, 'hello.wav');
  assert.equal(req.fields.audio.bytes.toString(), 'RIFF0000WAVEfake-audio-bytes');
  const summary = r.content[0].text;
  assert.match(summary, /Overall 82\.4\/100/);
  assert.match(summary, /Flagged for review: 好 tone expected 3 heard 4/);
  assert.match(summary, /Credits charged: 1, balance: 49/);
  assert.equal(r.structuredContent.scores.tone, 61.2);
  assert.equal(r.structuredContent._meta_toneperfect.replayed, false);
  assert.equal(JSON.parse(r.content[1].text).id, 'req_test1');
  await client.close();
});

test('the default idempotency key is stable for identical calls (no double charge on retry)', async () => {
  requests = []; mode = 'replay';
  const client = await connect();
  const args = { audio_base64: Buffer.from('same-bytes').toString('base64'), text: 'hello', language: 'en-US' };
  await client.callTool({ name: 'assess_pronunciation', arguments: args });
  const r2 = await client.callTool({ name: 'assess_pronunciation', arguments: args });
  assert.equal(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key']);
  assert.match(r2.content[0].text, /replayed for this idempotency key: not charged again/);
  await client.callTool({ name: 'assess_pronunciation', arguments: { ...args, text: 'hello there' } });
  assert.notEqual(requests[2].headers['idempotency-key'], requests[0].headers['idempotency-key']);
  await client.callTool({ name: 'assess_pronunciation', arguments: { ...args, idempotency_key: 'lesson-42-attempt-1' } });
  assert.equal(requests[3].headers['idempotency-key'], 'lesson-42-attempt-1');
  assert.equal(deriveIdempotencyKey({ audio: new Uint8Array([1]), text: 'a', language: 'en-US' }), deriveIdempotencyKey({ audio: new Uint8Array([1]), text: 'a', language: 'en-US', task: 'general' }));
  await client.close();
});

test('401 and 402 come back as clear tool errors', async () => {
  const client = await connect();
  mode = '401';
  let r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_path: audioPath, text: 'hi', language: 'en-US' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Authentication failed \(invalid_api_key\)/);
  mode = '402';
  r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_path: audioPath, text: 'hi', language: 'en-US' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Payment required \(subscription_required\).*Nothing was charged.*50 free credits.*\$10\/month/);
  mode = '429';
  r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_path: audioPath, text: 'hi', language: 'en-US' } });
  assert.match(r.content[0].text, /rate_limit.*retry later with the SAME idempotency_key/);
  mode = 'ok';
  await client.close();
});

test('missing key, missing audio, unassessable', async () => {
  requests = [];
  const noKey = await connect({ TONEPERFECT_API_KEY: '' });
  let r = await noKey.callTool({ name: 'assess_pronunciation', arguments: { audio_path: audioPath, text: 'hi', language: 'en-US' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /TONEPERFECT_API_KEY/);
  assert.equal(requests.length, 0, 'no request without a key');
  await noKey.close();
  const client = await connect();
  r = await client.callTool({ name: 'assess_pronunciation', arguments: { text: 'hi', language: 'en-US' } });
  assert.match(r.content[0].text, /exactly one of audio_path, audio_base64 or audio_url/);
  r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_path: join(tmp, 'nope.wav'), text: 'hi', language: 'en-US' } });
  assert.match(r.content[0].text, /No audio file at/);
  mode = 'unassessable';
  r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_path: audioPath, text: 'hi', language: 'en-US' } });
  assert.match(r.content[0].text, /Not assessable: silence\. This is not a score of zero; nothing was charged/);
  mode = 'ok';
  await client.close();
});

test('audio_url is downloaded then uploaded', async () => {
  const files = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end('URL-AUDIO'); });
  await new Promise((r) => files.listen(0, '127.0.0.1', r));
  requests = [];
  const client = await connect();
  const r = await client.callTool({ name: 'assess_pronunciation', arguments: { audio_url: `http://127.0.0.1:${files.address().port}/clips/take1.m4a`, text: 'bonjour', language: 'fr-FR' } });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  assert.equal(requests[0].fields.audio.filename, 'take1.m4a');
  assert.equal(requests[0].fields.audio.bytes.toString(), 'URL-AUDIO');
  files.close();
  await client.close();
});

test('explain_result walks through words locally', async () => {
  const client = await connect();
  requests = [];
  const r = await client.callTool({ name: 'explain_result', arguments: { result: JSON.stringify(ASSESSMENT) } });
  assert.equal(requests.length, 0, 'no API call');
  const t = r.content[0].text;
  assert.match(t, /not a percentage/);
  assert.match(t, /fluency, rhythm, integrity: null means/);
  assert.match(t, /- 好 \(hao3\): 64 @150-420 ms \| initial h 92, tone 3→4 38\.5 \[review\]/);
  assert.match(t, /Suggested focus: 好 \(tone 3, heard 4\)/);
  assert.match(explainAssessment({ assessable: false, reason: 'wrong_text', billing: { credits: 0 } }), /Not assessable: wrong_text/);
  await client.close();
});
