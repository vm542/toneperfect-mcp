/** Turn API JSON into short, model-friendly text. Pure functions, no I/O. */
import { BETA_LANGUAGES, TonePerfectError } from './client.js';

const fmt = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? (Math.round(n * 10) / 10).toString() : 'n/a');

export function summarizeCapabilities(caps: Record<string, any>): string {
  const langs: any[] = Array.isArray(caps.languages) ? caps.languages : [];
  const lines = [`TonePerfect serves ${langs.length} languages (scripted speech only: the learner reads a known text).`];
  for (const l of langs) {
    const beta = BETA_LANGUAGES.has(l.locale) ? ', beta' : '';
    const dims = Array.isArray(l.dimensions) ? l.dimensions.join(', ') : '';
    lines.push(`- ${l.locale} ${l.name ?? ''} [${l.available === false ? 'unavailable' : l.status ?? 'available'}${beta}] dimensions: ${dims}`);
  }
  const lim = caps.limits;
  if (lim) lines.push(`Limits: up to ${lim.max_audio_seconds} s of audio, ${Math.round((lim.max_upload_bytes ?? 0) / 1048576)} MB per upload, ${lim.concurrent_requests_per_account} concurrent assessments per account.`);
  lines.push('Scores are 0-100 display grades calibrated per language against native references; they are not accuracy percentages and are not comparable across vendors.');
  return lines.join('\n');
}

interface WeakUnit { word: string; dimension?: string; expected?: unknown; heard?: unknown; score: number; decision?: string }

/** Lowest-scoring words and sounds, worst first. */
export function weakestUnits(data: Record<string, any>, limit = 5): { words: { word: string; score: number }[]; sounds: WeakUnit[] } {
  const words: any[] = Array.isArray(data.words) ? data.words : [];
  const scoredWords = words.filter((w) => typeof w.score === 'number').map((w) => ({ word: String(w.word), score: w.score as number }));
  scoredWords.sort((a, b) => a.score - b.score);
  const sounds: WeakUnit[] = [];
  for (const w of words) {
    for (const p of Array.isArray(w.phones) ? w.phones : []) {
      if (typeof p.score === 'number') sounds.push({ word: String(w.word), dimension: p.dimension, expected: p.expected, heard: p.heard, score: p.score, decision: p.decision });
    }
  }
  // Units the API flagged for review come first, then by score.
  sounds.sort((a, b) => Number(b.decision === 'review') - Number(a.decision === 'review') || a.score - b.score);
  return { words: scoredWords.slice(0, limit), sounds: sounds.slice(0, limit) };
}

export function summarizeAssessment(data: Record<string, any>, meta: { replayed?: boolean; language?: string } = {}): string {
  const lines: string[] = [];
  const billing = data.billing ?? {};
  if (!data.assessable) {
    lines.push(`Not assessable: ${data.reason ?? 'no reason given'}. This is not a score of zero; nothing was charged (credits: ${billing.credits ?? 0}).`);
    lines.push('Typical causes: silence, a different sentence than the reference, or unreadable audio. Ask the learner to record the reference text again.');
    return lines.join('\n');
  }
  const s = data.scores ?? {};
  const dims = Object.entries(s)
    .filter(([k, v]) => k !== 'overall' && typeof v === 'number')
    .map(([k, v]) => `${k} ${fmt(v)}`)
    .join(', ');
  lines.push(`Overall ${fmt(s.overall)}/100${dims ? ` (${dims})` : ''}.`);
  const { words, sounds } = weakestUnits(data, 3);
  if (words.length) lines.push(`Lowest words: ${words.map((w) => `${w.word} ${fmt(w.score)}`).join(', ')}.`);
  const review = sounds.filter((u) => u.decision === 'review');
  if (review.length) {
    lines.push('Flagged for review: ' + review.map((u) => `${u.word} ${u.dimension ?? 'sound'} expected ${u.expected} heard ${u.heard} (${fmt(u.score)})`).join('; ') + '.');
  } else if (sounds.length) {
    lines.push('Lowest sounds: ' + sounds.map((u) => `${u.word} ${u.dimension ?? ''} ${u.expected}${u.heard != null && String(u.heard) !== String(u.expected) ? `→${u.heard}` : ''} ${fmt(u.score)}`.replace(/\s+/g, ' ')).join('; ') + '.');
  }
  lines.push(meta.replayed
    ? `Stored result replayed for this idempotency key: not charged again (the original call charged ${billing.credits ?? 'n/a'}).`
    : `Credits charged: ${billing.credits ?? 'n/a'}, balance: ${billing.balance_credits ?? 'n/a'}.`);
  if (meta.language && BETA_LANGUAGES.has(meta.language)) lines.push(`Note: ${meta.language} is a beta language pack; treat scores as indicative.`);
  return lines.join('\n');
}

/** Longer, teacher-style walkthrough of one result. */
export function explainAssessment(data: Record<string, any>): string {
  if (!data || typeof data !== 'object') return 'No result to explain.';
  if (!data.assessable) return summarizeAssessment(data);
  const out: string[] = [];
  const s = data.scores ?? {};
  out.push(`How to read this result (${data.locale ?? data.language ?? 'unknown language'}, model ${data.model_version ?? 'n/a'}):`);
  out.push(`- overall ${fmt(s.overall)} is a 0-100 display grade calibrated against native speakers reading the same kind of text; it is not a percentage of correct sounds.`);
  const unsupported = Object.entries(s).filter(([, v]) => v === null).map(([k]) => k);
  if (unsupported.length) out.push(`- ${unsupported.join(', ')}: null means this language pack does not score that dimension (or there was no evidence), not zero.`);
  out.push('- Per word, `phones` list each sound with what was expected and what was heard. For Mandarin, every syllable has a separate initial, final and tone (1-5) component.');
  out.push('- `decision` separates the grade from the feedback call: "review" = worth correcting, "uncertain" = weak evidence, "no_correction" = fine; other values mean no decision.');
  const words: any[] = Array.isArray(data.words) ? data.words : [];
  if (words.length) {
    out.push('', 'Word by word:');
    for (const w of words.slice(0, 40)) {
      const phones = (Array.isArray(w.phones) ? w.phones : [])
        .map((p: any) => {
          const mismatch = p.expected != null && p.heard != null && String(p.expected) !== String(p.heard);
          return `${p.dimension ? p.dimension + ' ' : ''}${p.expected}${mismatch ? `→${p.heard}` : ''} ${fmt(p.score)}${p.decision === 'review' ? ' [review]' : ''}`;
        })
        .join(', ');
      const timing = typeof w.start_ms === 'number' ? ` @${w.start_ms}-${w.end_ms} ms` : '';
      out.push(`- ${w.word}${w.pinyin ? ` (${w.pinyin})` : ''}: ${fmt(w.score)}${timing}${phones ? ` | ${phones}` : ''}`);
    }
  }
  const { sounds } = weakestUnits(data, 3);
  if (sounds.length) {
    out.push('', 'Suggested focus: ' + sounds.map((u) => `${u.word} (${u.dimension ?? 'sound'} ${u.expected}${u.heard != null && String(u.heard) !== String(u.expected) ? `, heard ${u.heard}` : ''})`).join('; ') + '.');
  }
  return out.join('\n');
}

export function describeError(error: unknown): string {
  if (!(error instanceof TonePerfectError)) return `Unexpected error: ${(error as Error)?.message ?? String(error)}`;
  const e = error;
  switch (e.status === 401 ? 'auth' : e.status === 402 ? 'pay' : 'other') {
    case 'auth':
      return `Authentication failed (${e.code}): ${e.detail} Check TONEPERFECT_API_KEY; keys are created in https://api.toneperfect.app/dashboard.`;
    case 'pay':
      return `Payment required (${e.code}): ${e.detail} Nothing was charged. New accounts get 50 free credits; after that a plan is needed (Starter is $10/month). Manage it at https://api.toneperfect.app/dashboard.`;
    default: {
      const hint = e.retryable
        ? ' Nothing was finalized: retry later with the SAME idempotency_key.'
        : e.needsNewKey
          ? ' This failure is stored under that idempotency_key; use a new key (or omit it) for a new attempt.'
          : '';
      return `TonePerfect API error ${e.status} ${e.code}: ${e.detail}${hint}${e.requestId ? ` (request ${e.requestId})` : ''}`;
    }
  }
}
