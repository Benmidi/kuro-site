// Reading a loop's frames file and playing it on a canvas.
//
// The file is a zlib stream of the exposures end to end, each width × height × 4 bytes of RGBA
// (Kuro/Film/LoopPack.swift). Alpha is the grain amplitude, which the phones turn into moving
// grain; here it is dropped, so a loop shows its developed color without grain.

import { LoopClock, STANDARD_CADENCE, playback } from '../stock-tester/film.js';

// The apps' limits: refuse anything they would.
const MAX_PACKED = 16 * 1024 * 1024, MAX_DECODED = 32 * 1024 * 1024;
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Bytes in one exposure, or null when the row describes something the apps would not open. */
export function frameSize(row) {
  if (!whole(row.frames, 2, 12) || !whole(row.width, 1, 4096) || !whole(row.height, 1, 4096)) return null;
  const size = row.width * row.height * 4;
  return size * row.frames <= MAX_DECODED ? size : null;
}

/** Inflates a frames file into exactly the bytes its row promises, or throws. */
export async function unpack(response, row) {
  const size = frameSize(row);
  if (size === null) throw new Error('Not a loop the apps would open');
  if (!response.ok) throw new Error(response.status === 400 || response.status === 404 ? 'No file' : `Refused (${response.status})`);
  if (Number(response.headers.get('Content-Length')) > MAX_PACKED) throw new Error('File too large');
  const out = new Uint8Array(size * row.frames);
  let packed = 0, at = 0;
  const counted = new TransformStream({
    transform(chunk, controller) {
      packed += chunk.byteLength;
      if (packed > MAX_PACKED) controller.error(new Error('File too large'));
      else controller.enqueue(chunk);
    },
  });
  const reader = response.body.pipeThrough(counted).pipeThrough(new DecompressionStream('deflate')).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.byteLength > out.length) { await reader.cancel(); throw new Error('File longer than its loop'); }
    out.set(value, at);
    at += value.byteLength;
  }
  if (at !== out.length) throw new Error('File shorter than its loop');
  return out;
}

/** The exposures as bitmaps, `width` pixels wide (their own size when left out). */
export async function bitmaps(bytes, row, width = row.width) {
  const size = frameSize(row), out = [];
  const resize = width < row.width
    ? { resizeWidth: width, resizeHeight: Math.round(row.height * width / row.width), resizeQuality: 'medium' } : {};
  try {
    for (let i = 0; i < row.frames; i++) {
      const pixels = new Uint8ClampedArray(bytes.subarray(i * size, (i + 1) * size));   // a copy
      for (let a = 3; a < pixels.length; a += 4) pixels[a] = 255;
      out.push(await createImageBitmap(new ImageData(pixels, row.width, row.height), resize));
    }
  } catch (error) {
    out.forEach(b => b.close());
    throw error;
  }
  return out;
}

/** How to play a loop: its stock's cadence when that fits the file, and a plain run through otherwise. */
export function cadenceFor(row) {
  const c = playback(row.spec && typeof row.spec === 'object' ? row.spec : {});
  const index = i => whole(i, 0, row.frames - 1), q = c.quietPasses;
  const fits = c.fps >= 1 && c.fps <= 60 && ['loop', 'bounce'].includes(c.mode)
    && Array.isArray(c.shown) && c.shown.length >= 2 && c.shown.length <= 12 && c.shown.every(index)
    && Array.isArray(c.swaps) && c.swaps.length <= 12 && c.swaps.every(s => whole(s?.slot, 0, c.shown.length - 1) && index(s?.frame))
    && Array.isArray(q) && whole(q[0], 0, 1000) && whole(q[1], q[0], 1000)
    && c.swapChance >= 0 && c.swapChance <= 1;
  if (fits) return { ...c, stutter: c.stutter === true };
  return { ...STANDARD_CADENCE, shown: Array.from({ length: row.frames }, (_, i) => i), swaps: [] };
}

// One timer for every loop on the page.
const playing = new Set();
let last = 0, ticking = false;

function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  for (const player of playing) player.draw(dt);
  if (playing.size) requestAnimationFrame(tick); else ticking = false;
}

/** Plays a loop's bitmaps on a canvas as the apps do, hidden exposures included. */
export class Player {
  constructor(canvas, row) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    this.clock = new LoopClock(cadenceFor(row));
    this.frames = null;
    this.shown = -1;
  }

  /** Takes ownership of `frames`; they are closed when replaced or on `stop()`. */
  play(frames) {
    this.release();
    this.frames = frames;
    this.canvas.width = frames[0].width;
    this.canvas.height = frames[0].height;
    this.shown = -1;
    this.draw(0);
    playing.add(this);
    if (!ticking) { ticking = true; last = performance.now(); requestAnimationFrame(tick); }
  }

  draw(dt) {
    if (!this.frames) return;
    const i = this.clock.advance(dt);
    if (i === this.shown || !this.frames[i]) return;
    this.shown = i;
    this.context.drawImage(this.frames[i], 0, 0);
  }

  release() {
    playing.delete(this);
    this.frames?.forEach(b => b.close());
    this.frames = null;
  }

  /** Stops and frees the bitmaps. The canvas keeps the last exposure drawn. */
  stop() { this.release(); }
}
