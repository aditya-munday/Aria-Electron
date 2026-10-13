/**
 * Formant synthesis of written phrases.
 *
 * One shared implementation renders both the engine's phrase templates and the
 * fixtures the engine is tested against, so template and audio are always in the
 * same feature space. Keeping them separate let a template and a fixture drift
 * apart, which read as a detection bug in the engine rather than a fixture bug.
 */

export interface FormantPhone {
  readonly f1: number;
  readonly f2: number;
  readonly ms: number;
  readonly voiced: number;
}

const A: FormantPhone = { f1: 800, f2: 1200, ms: 120, voiced: 1 };
const E: FormantPhone = { f1: 500, f2: 1800, ms: 110, voiced: 1 };
const I: FormantPhone = { f1: 300, f2: 2300, ms: 100, voiced: 1 };
const O: FormantPhone = { f1: 450, f2: 800, ms: 120, voiced: 1 };
const U: FormantPhone = { f1: 320, f2: 700, ms: 110, voiced: 1 };
const R: FormantPhone = { f1: 400, f2: 1000, ms: 90, voiced: 0.9 };
const L: FormantPhone = { f1: 400, f2: 1100, ms: 80, voiced: 0.9 };
const W: FormantPhone = { f1: 350, f2: 700, ms: 80, voiced: 0.9 };
const M: FormantPhone = { f1: 300, f2: 1100, ms: 80, voiced: 0.85 };
const N: FormantPhone = { f1: 300, f2: 1500, ms: 80, voiced: 0.85 };
const H: FormantPhone = { f1: 500, f2: 1500, ms: 70, voiced: 0.2 };
const S: FormantPhone = { f1: 4000, f2: 6000, ms: 90, voiced: 0 };
const F: FormantPhone = { f1: 3000, f2: 5000, ms: 80, voiced: 0 };
const T: FormantPhone = { f1: 2000, f2: 4000, ms: 60, voiced: 0 };
const K: FormantPhone = { f1: 1800, f2: 3500, ms: 60, voiced: 0 };
const P: FormantPhone = { f1: 300, f2: 900, ms: 60, voiced: 0 };
const B: FormantPhone = { f1: 300, f2: 900, ms: 70, voiced: 0.8 };
const D: FormantPhone = { f1: 300, f2: 1700, ms: 70, voiced: 0.8 };
const G: FormantPhone = { f1: 300, f2: 1600, ms: 70, voiced: 0.8 };
const Z: FormantPhone = { f1: 4000, f2: 6000, ms: 80, voiced: 0.4 };
const V: FormantPhone = { f1: 3000, f2: 5000, ms: 70, voiced: 0.4 };
const J: FormantPhone = { f1: 2000, f2: 3000, ms: 70, voiced: 0.3 };

export const SILENCE_PHONE: FormantPhone = { f1: 0, f2: 0, ms: 120, voiced: 0 };

export const DEFAULT_PHONE: FormantPhone = { f1: 500, f2: 1500, ms: 90, voiced: 0.8 };

export const PHONE_LIBRARY: Readonly<Record<string, FormantPhone>> = {
  a: A, e: E, i: I, o: O, u: U, y: I,
  r: R, l: L, w: W, m: M, n: N, h: H,
  s: S, f: F, z: Z, v: V, x: S, c: K, q: K, j: J,
  t: T, k: K, p: P, b: B, d: D, g: G,
};

const DIGRAPHS: Readonly<Record<string, readonly FormantPhone[]>> = {
  ch: [T, S],
  ck: [K],
  ng: [N],
  sh: [S],
  th: [T, S],
  ph: [F],
  wh: [W],
  oo: [U],
  ee: [I],
  ea: [E],
  ai: [E],
  ay: [E],
  ey: [E],
  ou: [O],
  ow: [O],
  oi: [O],
  ar: [A, R],
  er: [E, R],
  ir: [E, R],
  or: [O, R],
  ur: [E, R],
};

export function phonemesForPhrase(phrase: string): FormantPhone[] {
  const phones: FormantPhone[] = [];
  const normalized = phrase.toLowerCase().trim();
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i] as string;
    if (ch === ' ') {
      phones.push(SILENCE_PHONE);
      i += 1;
      continue;
    }
    const pair = i + 1 < normalized.length ? `${ch}${normalized[i + 1] as string}` : '';
    const digraph = DIGRAPHS[pair];
    if (digraph !== undefined) {
      phones.push(...digraph);
      i += 2;
      continue;
    }
    phones.push(PHONE_LIBRARY[ch] ?? DEFAULT_PHONE);
    i += 1;
  }
  return phones;
}

export function synthesizePhonemes(
  phones: readonly FormantPhone[],
  sampleRate: number,
  seed = 1,
  amplitude = 0.5,
): Float64Array {
  const totalSamples = phones.reduce((sum, phone) => sum + Math.round((phone.ms / 1000) * sampleRate), 0);
  const out = new Float64Array(totalSamples);
  let state = seed;
  const rand = (): number => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return (state / 0x7fffffff) * 2 - 1;
  };
  let offset = 0;
  for (const phone of phones) {
    const count = Math.round((phone.ms / 1000) * sampleRate);
    const y1 = { a: 0, b: 0 };
    const y2 = { a: 0, b: 0 };
    const r1 = Math.exp((-Math.PI * 90) / sampleRate);
    const r2 = Math.exp((-Math.PI * 130) / sampleRate);
    const c1 = 2 * r1 * Math.cos((2 * Math.PI * phone.f1) / sampleRate);
    const c2 = 2 * r2 * Math.cos((2 * Math.PI * phone.f2) / sampleRate);
    const d1 = r1 * r1;
    const d2 = r2 * r2;
    const pitchPeriod = Math.max(2, Math.round(sampleRate / 120));
    const voiced = phone.voiced >= 0.5;
    for (let i = 0; i < count; i += 1) {
      const env = Math.sin((Math.PI * i) / Math.max(1, count - 1));
      const excitation = voiced ? (i % pitchPeriod === 0 ? 1 : 0) : rand();
      const s1 = excitation + c1 * y1.a - d1 * y1.b;
      y1.b = y1.a;
      y1.a = s1;
      const s2 = excitation + c2 * y2.a - d2 * y2.b;
      y2.b = y2.a;
      y2.a = s2;
      const resonant = 0.6 * s1 + 0.4 * s2;
      out[offset + i] = amplitude * env * (phone.voiced * resonant + (1 - phone.voiced) * rand() * 0.5);
    }
    offset += count;
  }
  return out;
}

export function synthesizePhrase(
  phrase: string,
  sampleRate: number,
  rate = 1,
  seed = 1,
  amplitude = 0.5,
): Float64Array {
  const phones = phonemesForPhrase(phrase).map((phone) => ({ ...phone, ms: phone.ms * rate }));
  return synthesizePhonemes(phones, sampleRate, seed, amplitude);
}

export function resample(buffer: Float64Array, factor: number): Float64Array {
  if (factor === 1) return buffer;
  const out = new Float64Array(Math.round(buffer.length * factor));
  for (let i = 0; i < out.length; i += 1) {
    const source = i / factor;
    const low = Math.floor(source);
    const high = Math.min(buffer.length - 1, low + 1);
    const mix = source - low;
    out[i] = (buffer[low] as number) * (1 - mix) + (buffer[high] as number) * mix;
  }
  return out;
}
