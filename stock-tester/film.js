// The parts of KURO's film that have no screen: the RNG, the loop clock, and reading a stock's JSON.
// These follow the apps exactly (Kuro/Film/SplitMix.swift, LoopClock.swift, Stocks.swift), so a loop
// here plays its exposures in the same order as on a phone given the same seed.

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9E3779B97F4A7C15n;

export class SplitMix {
  constructor(seed) { this.state = (BigInt.asUintN(64, BigInt(seed)) + GOLDEN) & MASK; }
  next() {
    this.state = (this.state + GOLDEN) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    return z ^ (z >> 31n);
  }
  /** 0 ..< 1, in 24 bits, as a Float is on the phones. */
  unit() { return Number(this.next() >> 40n) / 16777216; }
}

export function randomSeed() {
  const w = new Uint32Array(2);
  crypto.getRandomValues(w);
  return (BigInt(w[0]) << 32n) | BigInt(w[1]);
}

/** What a stock with no cadence of its own plays at. */
export const STANDARD_CADENCE = {
  fps: 6, mode: 'loop', stutter: false, dt: 0.1, quietPasses: [6, 10], swapChance: 0.3,
  frames: 7, shown: [0, 2, 3, 4, 6], swaps: [{ slot: 1, frame: 1 }, { slot: 3, frame: 5 }],
};

export const playback = stock => ({ ...STANDARD_CADENCE, ...(stock.cadence || {}) });

/** Plays a loop: which exposure to show as time passes. */
export class LoopClock {
  constructor(cadence, seed = randomSeed()) {
    this.cad = cadence;
    this.rng = new SplitMix(seed);
    this.pass = 0;
    this.standIns = [];
    this.step = 0;
    this.acc = 0;
    this.held = false;
    const [lo, hi] = cadence.quietPasses;
    this.quietUntil = lo + Number(this.rng.next() % BigInt(hi - lo + 1));
    this.newPass(true);
  }

  newPass(first = false) {
    const c = this.cad, n = c.shown.length;
    if (!first) this.pass += 1;
    this.seq = Array.from({ length: n }, (_, i) => i);
    if (c.mode === 'bounce' && n > 2) for (let i = n - 2; i >= 1; i--) this.seq.push(i);
    this.map = c.shown.slice();
    this.standIns = [];
    if (this.pass >= this.quietUntil && c.swaps.length && this.rng.unit() < c.swapChance) {
      // One held-back exposure four times in five, each equally likely; all of them otherwise.
      const u = this.rng.unit(), k = c.swaps.length, f = Math.fround;
      let one = -1;
      for (let i = 0; i < k; i++) if (u < f(f(f(0.8) * (i + 1)) / k)) { one = i; break; }
      const chosen = one >= 0 ? [c.swaps[one]] : c.swaps;
      for (const s of chosen) this.map[s.slot] = s.frame;
      this.standIns = chosen.map(s => s.frame);
    }
    this.stutterAt = c.stutter && n > 2 ? 1 + Number(this.rng.next() % BigInt(n - 2)) : -1;
    this.held = false;
  }

  /** Advances by `dt` seconds and returns the exposure to show. */
  advance(dt) {
    this.acc += Math.min(dt, 0.25);
    const fdt = 1 / this.cad.fps;
    while (this.acc >= fdt) {
      this.acc -= fdt;
      if (this.step === this.stutterAt && !this.held) { this.held = true; continue; }
      this.held = false;
      this.step += 1;
      if (this.step >= this.seq.length) { this.step = 0; this.newPass(); }
    }
    return this.map[this.seq[this.step]];
  }
}

/** Per-exposure choices the develop shader needs: flicker gain and the light leak. */
export function exposure(stock, loopSeed, frame, evThirds = 0) {
  const rl = new SplitMix(loopSeed), rf = new SplitMix((loopSeed * 131n + BigInt(frame) * 17n) & MASK);
  let gain = 2 ** (evThirds / 3);
  if (stock.flicker > 0) gain *= 2 ** ((rf.unit() - 0.5) * 2 * stock.flicker);
  const side = rl.unit() < 0.5 ? 1 : 0;
  let leak = 0;
  if (stock.leak > 0 && rl.unit() < stock.leak) leak = (0.15 + rl.unit() * 0.35) * (0.4 + rf.unit() * 0.9);
  return { gain, side, leak, phase: Number(loopSeed % 1000n) / 100 };
}

// MARK: Reading stocks

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const looksLikeStock = v => isObject(v) && typeof v.id === 'string' && ('curves' in v || 'air' in v || 'grain' in v);

/** Every stock in a piece of JSON: one spec, a list, a map by id, a Supabase row, or the contract fixture. */
export function findStocks(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return [];
  if (looksLikeStock(value)) return [value];
  if (isObject(value) && looksLikeStock(value.spec)) return [value.spec];
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.flatMap(v => findStocks(v, depth + 1));
}

const FORMAT = 1, MAX_FRAMES = 12, MAX_QUIET = 1000;
const numbers = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const hex = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

// What the apps' decoders ask of each field (Stock, AirPalette, Cadence and Season in Stocks.swift).
// A field of the wrong type fails the decode outright, so the whole file is refused.
const KINDS = {
  whole: [Number.isInteger, 'a whole number'],
  number: [Number.isFinite, 'a number'],
  text: [v => typeof v === 'string', 'text'],
  flag: [v => typeof v === 'boolean', 'true or false'],
  color: [hex, 'a color like #C7802D'],
  three: [v => numbers(v, 3), 'three numbers'],
  numbers: [v => Array.isArray(v) && v.every(Number.isFinite), 'a list of numbers'],
  wholes: [v => Array.isArray(v) && v.every(Number.isInteger), 'a list of whole numbers'],
  list: [Array.isArray, 'a list'],
  object: [isObject, 'an object'],
  shape: [v => ['mid', 'flat', 'shadow'].includes(v), 'mid, flat or shadow'],
  mode: [v => ['loop', 'bounce'].includes(v), 'loop or bounce'],
};
const STOCK = {
  format: 'whole', id: 'text', version: 'whole', name: 'text', short: 'text', iso: 'whole', kanji: 'text', line: 'text',
  grainNote: 'text', air: 'object', pair: 'object', accent: 'color', curves: 'list', grain: 'number', mono: 'flag',
  monoW: 'three', matrix: 'numbers', sat: 'number', splitSh: 'three', splitHi: 'three', fog: 'three', grainSize: 'number',
  grainShape: 'shape', colorGrain: 'flag', vignette: 'number', halation: 'number', flicker: 'number', leak: 'number',
};
const AIR = { name: 'text', kanji: 'text', blur: 'number', ink: 'color', layers: 'list' };
const LAYER = { hex: 'color', x: 'number', y: 'number' };
const PAIR = { a: 'color', b: 'color' };
const CURVE = { lift: 'number', white: 'number', gamma: 'number', k: 'number' };
const CADENCE = {
  fps: 'number', mode: 'mode', stutter: 'flag', dt: 'number', quietPasses: 'wholes', swapChance: 'number',
  frames: 'whole', shown: 'wholes', swaps: 'list',
};
const SWAP = { slot: 'whole', frame: 'whole' };
const SEASON = { name: 'text', place: 'text', code: 'text', coords: 'text', open: 'object', close: 'object' };
const MONTH_DAY = { month: 'whole', day: 'whole' };

/** Checks `value` has every field of `shape` with the right type. Returns whether it does. */
function check(value, shape, where, out) {
  if (!isObject(value)) { out.push(`${where} must be an object`); return false; }
  const before = out.length;
  for (const [key, kind] of Object.entries(shape)) {
    const [fits, wants] = KINDS[kind], name = where ? `${where} "${key}"` : `"${key}"`;
    if (!(key in value)) out.push(where ? `${where} is missing "${key}"` : `Missing "${key}"`);
    else if (!fits(value[key])) out.push(`${name} must be ${wants}`);
  }
  return out.length === before;
}

/** Why the apps would refuse this spec. Empty when they would play it. */
export function problems(s) {
  const out = [];
  check(s, STOCK, '', out);
  if (Number.isInteger(s.format) && s.format > FORMAT) out.push(`Format ${s.format} is newer than the apps read (${FORMAT})`);
  if (Array.isArray(s.curves)) {
    if (!s.curves.length) out.push('"curves" needs at least one curve');
    s.curves.forEach((c, i) => check(c, CURVE, `Curve ${i + 1}`, out));
  }
  if (KINDS.numbers[0](s.matrix) && s.matrix.length !== 9) out.push('"matrix" needs nine numbers');
  if (isObject(s.air)) {
    const a = s.air;
    check(a, AIR, 'Card', out);
    if (Array.isArray(a.layers)) {
      if (a.layers.length !== 4) out.push('Card needs four layers');
      a.layers.forEach((l, i) => check(l, LAYER, `Card layer ${i + 1}`, out));
    }
    if (a.style != null && typeof a.style !== 'string') out.push('Card "style" must be text');
  }
  if (isObject(s.pair)) check(s.pair, PAIR, 'Pair', out);
  if (s.cadence != null) out.push(...cadenceProblems(s.cadence));
  if (s.season != null && check(s.season, SEASON, 'Season', out)) {
    check(s.season.open, MONTH_DAY, 'Season open', out);
    check(s.season.close, MONTH_DAY, 'Season close', out);
  }
  return out;
}

function cadenceProblems(c) {
  const out = [];
  if (!check(c, CADENCE, 'Cadence', out)) return out;
  if (!(c.fps >= 1 && c.fps <= 60)) out.push('Playback must be 1 to 60 fps');
  if (!(c.dt >= 1 / 60 && c.dt <= 1)) out.push('Exposures must be 1/60 s to 1 s apart');
  const q = c.quietPasses;
  // The apps read the first two numbers as the range and ignore any after them.
  if (!(q.length >= 2 && q[0] >= 0 && q[1] >= q[0] && q[1] <= MAX_QUIET)) out.push(`Quiet passes must be a range within 0 to ${MAX_QUIET}`);
  if (!(c.swapChance >= 0 && c.swapChance <= 1)) out.push('Swap chance must be 0 to 1');
  const frames = c.frames, inFrames = i => i >= 0 && i < frames;
  if (!(frames >= 2 && frames <= MAX_FRAMES)) out.push(`A stock takes 2 to ${MAX_FRAMES} exposures`);
  if (!(c.shown.length >= 2 && c.shown.every(inFrames))) out.push('"shown" needs two or more exposures the stock takes');
  else if (!c.swaps.every((s, i) => check(s, SWAP, `Swap ${i + 1}`, out) && s.slot >= 0 && s.slot < c.shown.length && inFrames(s.frame))) out.push('Each swap needs a slot in "shown" and an exposure the stock takes');
  return out;
}

/** The spec with a value in every field the renderer reads, so a broken one still shows something. */
export function filled(s) {
  const three = (v, d) => (numbers(v, 3) ? v : d), num = (v, d) => (Number.isFinite(v) ? v : d);
  const curves = Array.isArray(s.curves) && s.curves.length ? s.curves : [{}];
  const cadOK = s.cadence != null && !cadenceProblems(s.cadence).length;
  return {
    ...s,
    curves: curves.map(c => ({ lift: num(c?.lift, 0), white: num(c?.white, 1), gamma: num(c?.gamma, 1), k: num(c?.k, 1) })),
    grain: num(s.grain, 0), mono: s.mono === true, monoW: three(s.monoW, [0.24, 0.62, 0.14]),
    matrix: numbers(s.matrix, 9) ? s.matrix : [1, 0, 0, 0, 1, 0, 0, 0, 1], sat: num(s.sat, 1),
    splitSh: three(s.splitSh, [0, 0, 0]), splitHi: three(s.splitHi, [0, 0, 0]), fog: three(s.fog, [0, 0, 0]),
    grainSize: num(s.grainSize, 1), grainShape: ['mid', 'flat', 'shadow'].includes(s.grainShape) ? s.grainShape : 'flat',
    colorGrain: s.colorGrain === true, vignette: num(s.vignette, 0), halation: num(s.halation, 0),
    flicker: num(s.flicker, 0), leak: num(s.leak, 0),
    cadence: cadOK ? s.cadence : STANDARD_CADENCE, hasCadence: cadOK,
  };
}

/** What a stock card says about motion. */
export function motionLabel(s) {
  const c = playback(s);
  return `${Math.trunc(c.fps)} FPS · ${c.mode === 'bounce' ? 'BOOMERANG' : c.stutter ? 'STUTTER' : 'LOOP'}`;
}
