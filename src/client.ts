/**
 * Minimal TonePerfect API client used by the MCP server.
 *
 * Same request shapes as the published SDKs (toneperfect-sdk/node):
 *   GET  /v1/capabilities  (no key)
 *   POST /v1/assess        (Authorization: Bearer, Idempotency-Key, multipart audio + text + language [+ pinyin, task])
 */
import { createHash, randomUUID } from 'node:crypto';

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://api.toneperfect.app';
export const TASKS = ['general', 'connected_speech', 'isolated_word'] as const;
export type Task = (typeof TASKS)[number];
export const LANGUAGES = ['zh-CN', 'en-US', 'fr-FR', 'es-419', 'de-DE', 'it-IT', 'pt-BR', 'ru-RU', 'ko-KR', 'ja-JP'] as const;
export const BETA_LANGUAGES = new Set(['ko-KR', 'ja-JP']);
export const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const RETRY_SAME_KEY_CODES = new Set(['rate_limit', 'account_busy', 'gateway_busy', 'decoder_busy', 'audio_decoder_unavailable', 'upload_timeout', 'request_pending', 'timeout', 'network_error']);
const NEW_KEY_CODES = new Set(['idempotency_expired', 'idempotency_conflict']);

export class TonePerfectError extends Error {
  status: number;
  code: string;
  detail: string;
  requestId: string | null;
  retryAfter: number | null;
  body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, requestId: string | null = null, retryAfter: number | null = null, body: Record<string, unknown> | null = null) {
    super(`${status} ${code}: ${message}`);
    this.name = 'TonePerfectError';
    this.status = status;
    this.code = code;
    this.detail = message;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.body = body ?? {};
  }
  /** The failure was stored under this Idempotency-Key (id + billing in the body). */
  get finalized(): boolean {
    return typeof this.body.id === 'string' && !!this.body.billing && typeof this.body.billing === 'object';
  }
  get needsNewKey(): boolean {
    return this.finalized || NEW_KEY_CODES.has(this.code);
  }
  get retryable(): boolean {
    if (this.needsNewKey) return false;
    return RETRY_SAME_KEY_CODES.has(this.code) || [408, 429, 502, 503, 504].includes(this.status);
  }
}

export interface AssessInput {
  audio: Uint8Array;
  text?: string;
  language: string;
  pinyin?: string;
  task?: Task;
  filename?: string;
  idempotencyKey?: string;
}

export interface AssessOutput {
  data: Record<string, any>;
  status: number;
  requestId: string | null;
  replayed: boolean;
  idempotencyKey: string;
}

/**
 * Deterministic key for one recording + reference: an agent that retries the same tool call after a
 * dropped connection gets the stored result back instead of being charged twice (results are kept 24 h).
 */
export function deriveIdempotencyKey(input: Omit<AssessInput, 'idempotencyKey' | 'filename'>): string {
  const h = createHash('sha256');
  h.update(input.audio);
  h.update('\0' + (input.text ?? '') + '\0' + input.language + '\0' + (input.pinyin ?? '') + '\0' + (input.task ?? 'general'));
  return `mcp-${h.digest('hex').slice(0, 48)}`;
}

export function newIdempotencyKey(): string {
  return `mcp-${randomUUID()}`;
}

export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class TonePerfectClient {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TONEPERFECT_API_KEY ?? '';
    this.baseUrl = (options.baseUrl || process.env.TONEPERFECT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async capabilities(): Promise<Record<string, any>> {
    const { status, headers, text } = await this.send('GET', '/v1/capabilities', undefined, {});
    return parseJson(status, headers, text);
  }

  async assess(input: AssessInput): Promise<AssessOutput> {
    if (!this.apiKey) {
      throw new TonePerfectError(401, 'invalid_api_key', 'No API key: set the TONEPERFECT_API_KEY environment variable in your MCP client config. New accounts get 50 free credits at https://api.toneperfect.app/signup');
    }
    if (!input.text && !input.pinyin) throw new TonePerfectError(400, 'invalid_reference', 'Provide the reference text (or pinyin for Mandarin).');
    const task = input.task ?? 'general';
    const key = input.idempotencyKey || deriveIdempotencyKey({ ...input, task });
    if (!IDEMPOTENCY_RE.test(key)) throw new TonePerfectError(400, 'invalid_idempotency_key', 'idempotency_key must be 8-128 letters, digits, dots, dashes, underscores or colons.');

    const form = new FormData();
    form.append('audio', new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), input.filename || 'recording.wav');
    if (input.text) form.append('text', input.text);
    if (input.pinyin) form.append('pinyin', input.pinyin);
    form.append('language', input.language);
    form.append('task', task);
    const { status, headers, text } = await this.send('POST', '/v1/assess', form, {
      Authorization: `Bearer ${this.apiKey}`,
      'Idempotency-Key': key,
    });
    const data = parseJson(status, headers, text);
    return {
      data,
      status,
      requestId: headers.get('x-request-id'),
      replayed: (headers.get('idempotent-replayed') || '').toLowerCase() === 'true',
      idempotencyKey: key,
    };
  }

  private async send(method: string, path: string, body: BodyInit | undefined, headers: Record<string, string>) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl + path, {
        method,
        body,
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': `toneperfect-mcp/${VERSION}`, ...headers },
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new TonePerfectError(0, 'timeout', `No response within ${this.timeoutMs} ms; the outcome is unknown. Retry with the same idempotency_key.`);
      throw new TonePerfectError(0, 'network_error', `Could not reach ${this.baseUrl}: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJson(status: number, headers: Headers, text: string): Record<string, any> {
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = null;
  }
  if (status >= 200 && status < 300 && data && typeof data === 'object') return data;
  const ra = headers.get('retry-after');
  const retryAfter = ra ? Number(ra) || null : null;
  if (data && typeof data === 'object' && data.error && typeof data.error === 'object') {
    throw new TonePerfectError(status, String(data.error.code || 'request_error'), String(data.error.message || ''), data.request_id || headers.get('x-request-id'), retryAfter, data);
  }
  throw new TonePerfectError(status, 'http_error', (text || '').slice(0, 200).trim() || `HTTP ${status}`, headers.get('x-request-id'), retryAfter);
}
