import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LANGUAGES, TASKS, TonePerfectClient, TonePerfectError, VERSION } from './client.js';
import { describeError, explainAssessment, summarizeAssessment, summarizeCapabilities } from './summarize.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface ServerOptions {
  client?: TonePerfectClient;
}

function errorResult(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: describeError(error) }] };
}

export async function loadAudio(args: { audio_path?: string; audio_base64?: string; audio_url?: string; filename?: string }, fetchImpl: typeof fetch) {
  const given = [args.audio_path, args.audio_base64, args.audio_url].filter(Boolean).length;
  if (given !== 1) throw new TonePerfectError(400, 'missing_audio', 'Provide exactly one of audio_path, audio_base64 or audio_url.');
  if (args.audio_path) {
    const p = resolve(args.audio_path.replace(/^~(?=$|\/)/, homedir()));
    const info = await stat(p).catch(() => null);
    if (!info?.isFile()) throw new TonePerfectError(400, 'missing_audio', `No audio file at ${p}.`);
    if (info.size > MAX_UPLOAD_BYTES) throw new TonePerfectError(413, 'upload_too_large', `${p} is ${info.size} bytes; the limit is 10 MB (30 s).`);
    return { bytes: new Uint8Array(await readFile(p)), filename: args.filename || basename(p) };
  }
  if (args.audio_base64) {
    const b64 = args.audio_base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (b64.length > 4 * Math.ceil(MAX_UPLOAD_BYTES / 3)) throw new TonePerfectError(413, 'upload_too_large', 'Audio is larger than 10 MB.');
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    if (!bytes.length) throw new TonePerfectError(400, 'missing_audio', 'audio_base64 decoded to 0 bytes.');
    if (bytes.length > MAX_UPLOAD_BYTES) throw new TonePerfectError(413, 'upload_too_large', 'Audio is larger than 10 MB.');
    return { bytes, filename: args.filename || 'recording.wav' };
  }
  const url = new URL(args.audio_url!);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TonePerfectError(400, 'missing_audio', 'audio_url must be http(s).');
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new TonePerfectError(400, 'missing_audio', `Downloading audio_url failed: HTTP ${res.status}.`);
  if (Number(res.headers.get('content-length')) > MAX_UPLOAD_BYTES) {
    await res.body?.cancel();
    throw new TonePerfectError(413, 'upload_too_large', 'Audio is larger than 10 MB.');
  }
  const reader = res.body?.getReader();
  if (!reader) throw new TonePerfectError(400, 'missing_audio', 'Downloaded audio is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new TonePerfectError(413, 'upload_too_large', 'Audio is larger than 10 MB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new TonePerfectError(400, 'missing_audio', 'Downloaded audio is empty.');
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes: buf, filename: args.filename || basename(url.pathname) || 'recording.wav' };
}

export function createServer(options: ServerOptions = {}): McpServer {
  const client = options.client ?? new TonePerfectClient();
  const server = new McpServer(
    { name: 'toneperfect', title: 'TonePerfect Pronunciation Assessment', version: VERSION },
    {
      instructions:
        'Scores a short recording (up to 30 s) of someone reading a KNOWN text: 0-100 grades for the sentence, every word and every sound, with initial/final/tone per Mandarin syllable. Scripted speech only, not free conversation. Call list_languages to see supported locales (Korean and Japanese are beta). assess_pronunciation costs 1 credit per started 15 s of assessable audio; unassessable results cost nothing. Never present an unassessable result as a zero score.',
    },
  );

  server.registerTool(
    'list_languages',
    {
      title: 'List supported languages',
      description: 'List the languages, scored dimensions and limits of the TonePerfect pronunciation assessment API (GET /v1/capabilities). Free, no API key needed.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    async () => {
      try {
        const caps = await client.capabilities();
        return { content: [{ type: 'text', text: summarizeCapabilities(caps) }], structuredContent: caps };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'assess_pronunciation',
    {
      title: 'Assess pronunciation',
      description:
        'Score a recording of someone reading a known reference text (POST /v1/assess). Give the audio as a local file path, base64, or an http(s) URL (WAV, MP3, M4A, Ogg or WebM; 0.15-30 s; max 10 MB), plus the reference text and locale. Returns a short summary and the full JSON (sentence, word and sound scores, expected vs heard, timings, billing). Uses the API key in TONEPERFECT_API_KEY; 1 credit per started 15 s of assessable audio.',
      inputSchema: {
        audio_path: z.string().optional().describe('Path to a local audio file (~ is expanded).'),
        audio_base64: z.string().optional().describe('Audio bytes as base64 (a data: URL prefix is accepted).'),
        audio_url: z.string().url().optional().describe('http(s) URL to download the audio from.'),
        text: z.string().max(500).optional().describe('The expected words the speaker read. Required unless pinyin is given (Mandarin only). Numbers written as words.'),
        language: z.enum(LANGUAGES).default('zh-CN').describe('Locale: zh-CN, en-US, fr-FR, es-419, de-DE, it-IT, pt-BR, ru-RU, ko-KR (beta), ja-JP (beta).'),
        pinyin: z.string().max(1000).optional().describe('Mandarin only: numbered-tone pinyin, one syllable per character, e.g. "ni3 hao3".'),
        task: z.enum(TASKS).default('general').describe('general (default), connected_speech (enables Mandarin component correction decisions) or isolated_word.'),
        idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/).optional().describe('Optional. Defaults to a hash of the audio and fields, so repeating the identical call within 24 h returns the stored result without charging again.'),
        filename: z.string().optional().describe('Optional filename sent with the upload (helps format detection).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const audio = await loadAudio(args, globalThis.fetch);
        const out = await client.assess({
          audio: audio.bytes,
          filename: audio.filename,
          text: args.text,
          language: args.language,
          pinyin: args.pinyin,
          task: args.task,
          idempotencyKey: args.idempotency_key,
        });
        const summary = summarizeAssessment(out.data, { replayed: out.replayed, language: args.language });
        const full = { ...out.data, _meta_toneperfect: { idempotency_key: out.idempotencyKey, replayed: out.replayed, request_id: out.requestId } };
        return {
          content: [
            { type: 'text', text: summary },
            { type: 'text', text: JSON.stringify(full) },
          ],
          structuredContent: full,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'explain_result',
    {
      title: 'Explain an assessment result',
      description: 'Explain a TonePerfect assessment JSON (the output of assess_pronunciation) word by word: what each score means, which sounds were flagged and what to practise. Runs locally; no API call, no credits.',
      inputSchema: {
        result: z.union([z.string(), z.record(z.any())]).describe('The assessment JSON object, or it as a string.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ result }) => {
      let data: unknown = result;
      if (typeof result === 'string') {
        try {
          data = JSON.parse(result);
        } catch {
          return { isError: true, content: [{ type: 'text', text: 'result is not valid JSON.' }] };
        }
      }
      return { content: [{ type: 'text', text: explainAssessment(data as Record<string, any>) }] };
    },
  );

  return server;
}
