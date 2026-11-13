// KURO stock tester: develops the webcam through any stock given as JSON.
// The shader follows Kuro/Film/Film.metal (develop + filmFragment) in one pass.
import { LoopClock, exposure, filled, findStocks, motionLabel, problems, randomSeed } from './film.js';

const $ = id => document.getElementById(id);
const FRAME_W = 540, FRAME_H = 720;   // the apps' film frame, which sets the size of the grain

// MARK: Shader

const VERT = `#version 300 es
out vec2 q;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  q = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 q;
out vec4 color;
uniform sampler2D src;
uniform vec4 crop;        // source uv origin xy, size zw (3:4 crop)
uniform float mirror;
uniform vec3 row0, row1, row2;   // color crosstalk, row by row
uniform vec4 monoW;       // xyz weights, w = 1 for black and white
uniform vec4 splitSh;     // xyz shadow tint, w = saturation
uniform vec4 splitHi;     // xyz highlight tint, w = gain
uniform vec4 fog;         // xyz base fog, w = vignette
uniform vec4 grain;       // x amount, y shape, z halation, w light leak
uniform vec4 leak;        // x side, y phase
uniform vec4 curve[3];    // lift, white, gamma, k
uniform vec4 film;        // x grain seed, y grain size, z color grain

float tone(float x, vec4 c) {
  x = clamp(x, 0.0, 2.0);
  if (x > 0.8) x = 0.8 + 0.2 * tanh((x - 0.8) / 0.2);
  x = pow(clamp(x, 0.0, 1.0), c.z);
  float s = x < 0.5 ? 0.5 * pow(2.0 * x, c.w) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), c.w);
  return clamp(c.x + (c.y - c.x) * s, 0.0, 1.0);
}
vec3 read(vec2 at) {
  vec2 uv = crop.xy + vec2(mix(at.x, 1.0 - at.x, mirror), at.y) * crop.zw;
  return texture(src, uv).rgb * splitHi.w;
}
float ihash(uvec2 p, uint s) {
  uint h = p.x * 1973u + p.y * 9277u + s * 26699u;
  h = (h << 13u) ^ h;
  h = h * (h * h * 15731u + 789221u) + 1376312589u;
  return float(h & 0x7fffffffu) / 2147483647.0;
}
float gnoise(uvec2 p, uint s) {
  return (ihash(p, s) + ihash(p + uvec2(311u, 0u), s) + ihash(p + uvec2(0u, 977u), s) - 1.5) / 0.87;
}
void main() {
  vec3 c = read(q);
  if (grain.z > 0.0) {   // halation: highlights bleed red-orange
    float hsum = 0.0;
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 0.5236, r = (i & 1) == 1 ? 0.025 : 0.055;
      vec3 t = read(q + vec2(cos(a), sin(a) * 0.75) * r);
      hsum += max(0.0, dot(t, vec3(0.3, 0.59, 0.11)) - 0.69);
    }
    c += vec3(1.0, 0.27, 0.12) * (hsum / 12.0 / 0.31 * grain.z);
  }
  if (grain.w > 0.0) {   // light leak from one edge
    float d = leak.x > 0.5 ? 1.0 - q.x : q.x;
    c += vec3(1.0, 0.42, 0.08) * (grain.w * exp(-d * 5.0) * (0.75 + 0.25 * sin(q.y * 8.4 + leak.y)));
  }
  vec2 dv = (q - 0.5) * 2.0; dv.y *= 1.1;
  float v = max(0.0, 1.0 - fog.w * pow(dot(dv, dv) * 0.5, 1.4));

  vec3 o; float y;
  if (monoW.w > 0.5) {
    y = tone(dot(c, monoW.xyz) * v, curve[0]);
    o = vec3(y, y * 0.992, y * 0.975 + (1.0 - y) * 0.016);
  } else {
    c = vec3(dot(row0, c), dot(row1, c), dot(row2, c)) * v;
    o = vec3(tone(c.r, curve[0]), tone(c.g, curve[1]), tone(c.b, curve[2]));
    float l = dot(o, vec3(0.2126, 0.7152, 0.0722));
    o = l + (o - l) * splitSh.w;
    y = l;
    o += splitSh.xyz * (1.0 - y) * (1.0 - y) + splitHi.xyz * y * y + fog.xyz;
  }
  float amp = grain.y < 0.5 ? 0.35 + 3.2 * y * (1.0 - y)
            : (grain.y < 1.5 ? 0.6 + 1.6 * y * (1.0 - y) : 0.45 + 1.6 * (1.0 - y) * (1.0 - y));
  amp = clamp(amp * grain.x * 4.0, 0.0, 1.0) * 0.25;
  o = clamp(o, 0.0, 1.0);

  uvec2 px = uvec2(q * vec2(${FRAME_W}.0, ${FRAME_H}.0) / max(film.y, 1.0));
  uint seed = uint(film.x);
  float n0 = gnoise(px, seed);
  vec3 n = film.z > 0.5 ? vec3(n0, gnoise(px, seed + 7u) * 0.9, gnoise(px, seed + 13u) * 1.25) : vec3(n0);
  color = vec4(clamp(o + n * amp, 0.0, 1.0), 1.0);
}`;

const canvas = $('film');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
let uni = {};

function setUpGL() {
  const program = gl.createProgram();
  for (const [type, text] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, text);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  for (const name of ['src', 'crop', 'mirror', 'row0', 'row1', 'row2', 'monoW', 'splitSh', 'splitHi', 'fog', 'grain', 'leak', 'curve', 'film']) {
    uni[name] = gl.getUniformLocation(program, name);
  }
  gl.bindVertexArray(gl.createVertexArray());
  gl.uniform1i(uni.src, 0);
  gl.enable(gl.SCISSOR_TEST);
}

function makeTexture() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  return t;
}

/** Copies the current source picture (camera or test scene) into `texture`. Returns its size. */
function grab(texture) {
  const el = source.el();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
  return { w: el.videoWidth || el.width, h: el.videoHeight || el.height };
}

/** Centre crop to 3:4 portrait, as the phones do. */
function cropFor({ w, h }) {
  const aspect = w / h, target = 3 / 4;
  if (aspect < target) { const ch = aspect / target; return [0, (1 - ch) / 2, 1, ch]; }
  const cw = target / aspect;
  return [(1 - cw) / 2, 0, cw, 1];
}

/** Draws one developed frame of `s` into a rectangle of the canvas (CSS-style, y down, device pixels). */
function develop(s, rect, texture, size, loopSeed, frame, grainSeed) {
  const e = exposure(s, loopSeed, frame, state.ev), c = s.curves;
  const curve = [0, 1, 2].flatMap(ch => { const k = c[Math.min(ch, c.length - 1)]; return [k.lift, k.white, k.gamma, k.k]; });
  const y = canvas.height - rect.y - rect.h;
  gl.viewport(rect.x, y, rect.w, rect.h);
  gl.scissor(rect.x, y, rect.w, rect.h);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform4fv(uni.crop, cropFor(size));
  gl.uniform1f(uni.mirror, state.mirror && source.live ? 1 : 0);   // the test scene has nothing to mirror
  gl.uniform3fv(uni.row0, s.matrix.slice(0, 3));
  gl.uniform3fv(uni.row1, s.matrix.slice(3, 6));
  gl.uniform3fv(uni.row2, s.matrix.slice(6, 9));
  gl.uniform4f(uni.monoW, ...s.monoW, s.mono ? 1 : 0);
  gl.uniform4f(uni.splitSh, ...s.splitSh, s.sat);
  gl.uniform4f(uni.splitHi, ...s.splitHi, e.gain);
  gl.uniform4f(uni.fog, ...s.fog, s.vignette);
  gl.uniform4f(uni.grain, s.grain, { mid: 0, flat: 1, shadow: 2 }[s.grainShape], s.halation, e.leak);
  gl.uniform4f(uni.leak, e.side, e.phase, 0, 0);
  gl.uniform4fv(uni.curve, curve);
  gl.uniform4f(uni.film, grainSeed % 100000, s.grainSize, s.colorGrain ? 1 : 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// MARK: Source: the webcam, or a test scene until there is one

const source = {
  video: $('video'),
  scene: document.createElement('canvas'),
  live: false,
  el() { return this.live && this.video.readyState >= 2 ? this.video : this.scene; },

  async start() {
    const status = $('camera-status');
    if (!navigator.mediaDevices?.getUserMedia) { status.textContent = 'This browser has no camera access. Showing the test scene.'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false });
      this.video.srcObject = stream;
      await this.video.play();
      this.live = true;
      status.textContent = 'Webcam on. Nothing leaves this page.';
      $('camera').textContent = 'STOP CAMERA';
    } catch (error) {
      status.textContent = error.name === 'NotAllowedError' ? 'Camera access was declined. Showing the test scene.' : 'No camera found. Showing the test scene.';
    }
  },

  stop() {
    this.video.srcObject?.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
    this.live = false;
    $('camera').textContent = 'START CAMERA';
    $('camera-status').textContent = 'Camera off. Showing the test scene.';
  },

  /** A beach, a figure and a strip of color patches, so color and tone can be judged without a camera. */
  drawScene(t) {
    const c = this.scene, g = c.getContext('2d'), W = c.width, H = c.height;
    const sky = g.createLinearGradient(0, 0, 0, H * 0.42);
    sky.addColorStop(0, '#7fa7cc'); sky.addColorStop(0.6, '#d9c6b4'); sky.addColorStop(1, '#f2d2a6');
    g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.42);
    const sun = g.createRadialGradient(W * 0.72, H * 0.34, 0, W * 0.72, H * 0.34, W * 0.3);
    sun.addColorStop(0, '#fffdf0'); sun.addColorStop(0.15, 'rgba(255,236,200,.9)'); sun.addColorStop(1, 'rgba(255,236,200,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, H * 0.42);
    const sea = g.createLinearGradient(0, H * 0.42, 0, H * 0.66);
    sea.addColorStop(0, '#6e9bb0'); sea.addColorStop(1, '#2c5a70');
    g.fillStyle = sea; g.fillRect(0, H * 0.42, W, H * 0.24);
    g.fillStyle = 'rgba(255,240,214,.55)';
    for (let i = 0; i < 14; i++) {
      const w = (8 + i * 2.4) * (0.5 + 0.5 * Math.abs(Math.sin(i * 1.7 + t * 4)));
      g.fillRect(W * 0.72 + Math.sin(i * 3.1 + t * 3) * (3 + i) - w / 2, H * 0.43 + i * H * 0.014, w, 1.5);
    }
    const shore = H * 0.64 + Math.sin(t * 1.1) * 5;
    const sand = g.createLinearGradient(0, shore, 0, H);
    sand.addColorStop(0, '#9c8a72'); sand.addColorStop(0.2, '#c6ad8c'); sand.addColorStop(1, '#e6d2b3');
    g.fillStyle = sand; g.fillRect(0, shore, W, H - shore);
    g.fillStyle = 'rgba(255,255,250,.9)'; g.fillRect(0, shore - 1, W, 2.5);

    // The jumper.
    const ph = (t * 0.75) % 1, air = ph < 0.55 ? Math.sin(Math.PI * ph / 0.55) : 0;
    const x = W * 0.4, ground = H * 0.86, yy = ground - air * H * 0.14, arm = 0.2 + air * 1.2;
    g.fillStyle = `rgba(60,45,30,${0.35 - air * 0.2})`;
    g.beginPath(); g.ellipse(x + 6, ground + 3, 22 - air * 9, 4, 0, 0, 7); g.fill();
    g.strokeStyle = g.fillStyle = '#2a211c'; g.lineCap = 'round';
    g.lineWidth = 9; g.beginPath(); g.moveTo(x, yy - 44); g.lineTo(x, yy - 78); g.stroke();
    g.lineWidth = 6;
    for (const sd of [-1, 1]) {
      g.beginPath(); g.moveTo(x, yy - 44); g.lineTo(x + sd * (5 + air * 9), yy - 20 - air * 8); g.lineTo(x + sd * 6, yy); g.stroke();
      g.beginPath(); g.moveTo(x, yy - 74); g.lineTo(x + sd * 26 * Math.cos(arm - 0.6), yy - 74 - 26 * Math.sin(arm - 0.6)); g.stroke();
    }
    g.beginPath(); g.arc(x, yy - 90, 10, 0, 7); g.fill();

    // Patches: red, green, blue, cyan, magenta, yellow, two skin tones, then a grey ramp.
    const patches = ['#c8102e', '#1f8a3b', '#1f4fc8', '#19b5c8', '#c81fb0', '#e8c81f', '#c68e6f', '#7a4a36'];
    const pw = W / patches.length, top = H * 0.93;
    patches.forEach((p, i) => { g.fillStyle = p; g.fillRect(i * pw, top, pw + 1, H * 0.035); });
    for (let i = 0; i < 16; i++) { const v = Math.round(i / 15 * 255); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i * W / 16, top + H * 0.035, W / 16 + 1, H * 0.035); }
  },
};
source.scene.width = 540; source.scene.height = 720;

// MARK: State

const state = {
  stocks: [],        // { spec, use, problems }
  selected: 0,
  all: false,        // contact sheet of every stock
  ev: 0,
  mirror: true,
  loop: null,        // { stock, frames: [texture], size, clock, seed, taken, t0 } while shooting or reviewing
  liveSeed: randomSeed(), tick: 0, grainSeed: 1, tickAcc: 0,
};
const liveTexture = { texture: null, size: { w: 3, h: 4 } };
const key = s => `${s.id}@${s.version ?? 1}`;
const current = () => state.stocks[state.selected];

function save() {
  try { localStorage.setItem('kuro.stock-tester', JSON.stringify(state.stocks.map(s => s.spec))); } catch { /* private window */ }
}

/** Adds every stock found in `text`. Returns how many, or throws with what was wrong. */
function addFrom(text, origin) {
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new Error(`${origin} isn't JSON: ${error.message}`); }
  const found = findStocks(value);
  if (!found.length) throw new Error(`${origin} has no stock in it. A stock is an object with an "id" and "curves".`);
  for (const spec of found) {
    const entry = { spec, use: filled(spec), problems: problems(spec) };
    const at = state.stocks.findIndex(s => key(s.spec) === key(spec));
    if (at >= 0) state.stocks[at] = entry; else state.stocks.push(entry);
    state.selected = at >= 0 ? at : state.stocks.length - 1;
  }
  endLoop();
  save();
  renderList();
  return found.length;
}

function report(message, bad = false) {
  const el = $('report');
  el.textContent = message;
  el.dataset.bad = bad;
}

async function addFiles(files) {
  let n = 0;
  const errors = [];
  for (const file of files) {
    try { n += addFrom(await file.text(), file.name); } catch (error) { errors.push(error.message); }
  }
  report(errors.length ? errors.join(' ') : `Added ${n} stock${n === 1 ? '' : 's'}.`, errors.length > 0);
}

// MARK: Page

const esc = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeHex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);

/** A card's four lobes as CSS, the way the Air style draws them. */
function airCSS(spec) {
  const layers = Array.isArray(spec.air?.layers) ? spec.air.layers : [];
  const lobes = layers.map(l => `radial-gradient(at ${(+l.x || 0) * 100}% ${(+l.y || 0) * 100}%, ${safeHex(l.hex, '#333333')} 0%, transparent 70%)`);
  const mean = [16, 8, 0].map(sh => Math.round(layers.reduce((a, l) => a + ((parseInt(safeHex(l.hex, '#333333').slice(1), 16) >> sh) & 255), 0) / Math.max(layers.length, 1)));
  return `background:${[...lobes, `rgb(${mean})`].join(',')};color:${safeHex(spec.air?.ink, '#f3f1ec')}`;
}

function renderList() {
  const row = $('stocks');
  row.innerHTML = state.stocks.map((s, i) => `
    <button class="cartridge" role="option" aria-selected="${i === state.selected}" data-i="${i}" style="${airCSS(s.spec)}">
      <span class="c-kanji">${esc(s.spec.kanji)}</span><span class="c-iso">${esc(s.spec.iso)}</span>
      <span class="c-name">${esc(s.spec.name || s.spec.id)}</span>${s.problems.length ? '<span class="c-flag">!</span>' : ''}
    </button>`).join('');
  document.body.classList.toggle('empty', !state.stocks.length);
  $('all').disabled = state.stocks.length < 2;
  if (state.stocks.length < 2) state.all = false;
  $('all').setAttribute('aria-pressed', state.all);
  renderDetail();
  layoutLabels();
}

function renderDetail() {
  const s = current(), el = $('detail');
  if (!s) { el.innerHTML = ''; $('title').textContent = 'NO STOCK'; $('motion').textContent = 'DROP A STOCK FILE TO BEGIN'; return; }
  const spec = s.spec, u = s.use, c = u.cadence;
  $('title').textContent = spec.short || spec.name || spec.id;
  $('motion').textContent = `ISO ${spec.iso ?? '?'} · ${motionLabel(u)}`;
  const n = v => (Array.isArray(v) ? v.map(x => +(+x).toFixed(3)).join('  ') : typeof v === 'number' ? +v.toFixed(4) : v);
  const rows = [
    ['TONE', u.curves.map((k, i) => [u.curves.length > 1 ? 'RGB'[i] : 'ALL', `lift ${n(k.lift)} · white ${n(k.white)} · gamma ${n(k.gamma)} · k ${n(k.k)}`])],
    ['COLOR', u.mono ? [['MONO', n(u.monoW)]] : [['MATRIX R', n(u.matrix.slice(0, 3))], ['MATRIX G', n(u.matrix.slice(3, 6))], ['MATRIX B', n(u.matrix.slice(6, 9))],
      ['SATURATION', n(u.sat)], ['SHADOW TINT', n(u.splitSh)], ['HIGHLIGHT TINT', n(u.splitHi)], ['FOG', n(u.fog)]]],
    ['GRAIN', [['AMOUNT', n(u.grain)], ['SIZE', n(u.grainSize)], ['SHAPE', u.grainShape.toUpperCase()], ['COLOR', u.colorGrain ? 'YES' : 'NO']]],
    ['OPTICS', [['VIGNETTE', n(u.vignette)], ['HALATION', n(u.halation)], ['FLICKER', n(u.flicker)], ['LIGHT LEAK', n(u.leak)]]],
    ['MOTION' + (u.hasCadence ? '' : ' (STANDARD)'), [['PLAYBACK', `${n(c.fps)} fps · ${c.mode === 'bounce' ? 'boomerang' : c.stutter ? 'stutter' : 'loop'}`],
      ['EXPOSURES', `${c.frames}, ${n(c.dt)} s apart`], ['SHOWN', c.shown.map(i => i + 1).join(' ')],
      ['HELD BACK', c.swaps.length ? c.swaps.map(w => `${w.frame + 1}→place ${w.slot + 1}`).join(', ') : 'none'],
      ['SWAPS', `after ${c.quietPasses[0]}–${c.quietPasses[1]} passes, chance ${n(c.swapChance)}`]]],
  ];
  el.innerHTML = `
    <article class="card" style="${airCSS(spec)}">
      <span class="k-big" aria-hidden="true">${esc(spec.kanji)}</span>
      <span class="k-name">${esc(spec.name || spec.id)}</span>
      <span class="k-iso">${esc(spec.iso)}</span>
      <p>${esc(spec.line)}</p>
      <span class="k-meta">${esc(motionLabel(u))} · GRAIN: ${esc(spec.grainNote || 'NONE')}</span>
      <span class="k-meta dim">${esc(spec.air?.kanji)} ${esc(spec.air?.name)} · ID ${esc(spec.id)} · V${esc(spec.version ?? '?')} · FORMAT ${esc(spec.format ?? '?')}</span>
    </article>
    ${s.problems.length
      ? `<div class="verdict bad"><strong>THE APPS WOULD REFUSE THIS FILE</strong><ul>${s.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul><span>Shown here with standard values standing in.</span></div>`
      : '<div class="verdict"><strong>PLAYABLE</strong><span>Every field the apps need is here and in range.</span></div>'}
    <div class="actions"><button id="copy">COPY JSON</button><button id="download">DOWNLOAD .JSON</button><button id="remove">REMOVE</button></div>
    ${rows.map(([title, items]) => `<section class="params"><h3>${title}</h3><dl>${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`).join('')}`;
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(spec, null, 2)); report(`Copied ${spec.short || spec.id}.`); } catch { report("Couldn't reach the clipboard.", true); }
  };
  $('download').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2) + '\n'], { type: 'application/json' }));
    a.download = `${String(spec.short || spec.id).replace(/[^\w.-]+/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('remove').onclick = () => {
    state.stocks.splice(state.selected, 1);
    state.selected = Math.max(0, Math.min(state.selected, state.stocks.length - 1));
    endLoop(); save(); renderList();
  };
}

// MARK: Shooting a loop

function shoot() {
  const s = current();
  if (!s || state.all || state.loop) return;
  const c = s.use.cadence;
  state.loop = { stock: s.use, frames: Array.from({ length: c.frames }, makeTexture), size: liveTexture.size, seed: randomSeed(), taken: 0, t0: null, clock: null, shown: 0 };
  setPhase();
}

function endLoop() {
  if (!state.loop) return;
  state.loop.frames.forEach(t => gl.deleteTexture(t));
  state.loop = null;
  setPhase();
}

function setPhase() {
  const l = state.loop, reviewing = l && l.clock;
  $('shoot').textContent = reviewing ? 'BACK TO LIVE' : l ? 'EXPOSING…' : 'SHOOT LOOP';
  $('shoot').disabled = (!!l && !reviewing) || state.all || !current();
  if (!l) $('anatomy').textContent = state.all ? 'ALL STOCKS, LIVE' : 'LIVE';
}

// MARK: Drawing

/** Where each stock sits on the contact sheet, in CSS pixels. */
function cells() {
  const box = canvas.getBoundingClientRect(), n = state.stocks.length, gap = 6;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((box.width - gap * (cols - 1)) / cols, ((box.height - gap * (rows - 1)) / rows) * 0.75);
    if (!best || w > best.w) best = { w, cols, rows };
  }
  const w = best.w, h = w / 0.75;
  const x0 = (box.width - (best.cols * w + (best.cols - 1) * gap)) / 2, y0 = (box.height - (best.rows * h + (best.rows - 1) * gap)) / 2;
  return state.stocks.map((_, i) => ({ x: x0 + (i % best.cols) * (w + gap), y: y0 + Math.floor(i / best.cols) * (h + gap), w, h }));
}

function layoutLabels() {
  const el = $('labels');
  document.body.classList.toggle('sheet', state.all);
  if (!state.all) { el.innerHTML = ''; return; }
  el.innerHTML = cells().map((r, i) => `<button class="label" data-i="${i}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px"><span>${esc(state.stocks[i].spec.short || state.stocks[i].spec.id)}</span></button>`).join('');
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - last) / 1000;
  last = now;
  const box = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  gl.viewport(0, 0, W, H); gl.scissor(0, 0, W, H);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  if (!state.stocks.length) return;

  if (!source.live) source.drawScene(now / 1000);
  liveTexture.size = grab(liveTexture.texture);

  // Grain is re-thrown, and live flicker moves, at the selected stock's playback rate.
  const fps = (state.all ? 12 : current().use.cadence.fps);
  state.tickAcc += Math.min(dt, 0.25);
  if (state.tickAcc >= 1 / fps) {
    state.tickAcc %= 1 / fps;
    state.tick += 1;
    state.grainSeed = (Math.random() * 100000) | 0;
    if (state.tick % 48 === 0) state.liveSeed = randomSeed();
  }

  if (state.all) {
    cells().forEach((r, i) => develop(state.stocks[i].use, { x: Math.round(r.x * dpr), y: Math.round(r.y * dpr), w: Math.round(r.w * dpr), h: Math.round(r.h * dpr) },
      liveTexture.texture, liveTexture.size, state.liveSeed, state.tick, state.grainSeed));
    return;
  }

  const full = { x: 0, y: 0, w: W, h: H }, l = state.loop;
  if (!l) { develop(current().use, full, liveTexture.texture, liveTexture.size, state.liveSeed, state.tick, state.grainSeed); return; }

  const c = l.stock.cadence;
  if (!l.clock) {
    // Exposure i is the first frame at or after t0 + i * dt.
    if (l.t0 === null) l.t0 = now;
    while (l.taken < c.frames && now >= l.t0 + l.taken * c.dt * 1000 - 4) { l.size = grab(l.frames[l.taken]); l.taken += 1; }
    develop(l.stock, full, liveTexture.texture, liveTexture.size, l.seed, Math.max(0, l.taken - 1), state.grainSeed);
    $('anatomy').textContent = `EXPOSING ${l.taken} / ${c.frames}`;
    if (l.taken >= c.frames) { l.clock = new LoopClock(c); setPhase(); }
    return;
  }
  const shown = l.clock.advance(dt);
  develop(l.stock, full, l.frames[shown], l.size, l.seed, shown, state.grainSeed);
  $('anatomy').textContent = `EXPOSURE ${shown + 1} / ${c.frames} · PASS ${l.clock.pass + 1}${l.clock.standIns.length ? ' · SWAPPED ' + l.clock.standIns.map(i => i + 1).join(', ') : ''}`;
}

// MARK: Wiring

function start() {
  if (!gl) { document.body.classList.add('no-gl'); return; }
  try { setUpGL(); } catch (error) { document.body.classList.add('no-gl'); console.error(error); return; }
  liveTexture.texture = makeTexture();

  try { for (const spec of JSON.parse(localStorage.getItem('kuro.stock-tester') || '[]')) state.stocks.push({ spec, use: filled(spec), problems: problems(spec) }); } catch { /* nothing kept */ }
  renderList();
  setPhase();

  $('camera').onclick = () => (source.live ? source.stop() : source.start());
  $('shoot').onclick = () => (state.loop?.clock ? endLoop() : shoot());
  $('all').onclick = () => { state.all = !state.all; endLoop(); renderList(); setPhase(); };
  $('mirror').onclick = e => { state.mirror = !state.mirror; e.currentTarget.setAttribute('aria-pressed', state.mirror); };
  $('ev').oninput = e => { state.ev = +e.target.value; $('ev-value').textContent = state.ev === 0 ? '±0' : `${state.ev > 0 ? '+' : '−'}${(Math.abs(state.ev) / 3).toFixed(1)}`; };
  const pick = e => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    state.selected = +b.dataset.i; state.all = false;
    endLoop(); renderList(); setPhase();
  };
  $('stocks').onclick = pick;
  $('labels').onclick = pick;

  $('add').onclick = () => {
    const box = $('paste');
    if (!box.value.trim()) { report('Paste a stock\'s JSON into the box first.', true); return; }
    try { const n = addFrom(box.value, 'The pasted text'); box.value = ''; report(`Added ${n} stock${n === 1 ? '' : 's'}.`); } catch (error) { report(error.message, true); }
  };
  $('file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  $('clear').onclick = () => { state.stocks = []; state.selected = 0; endLoop(); save(); renderList(); report('Cleared.'); };

  // Drop a file anywhere; paste anywhere outside the box.
  let depth = 0;
  addEventListener('dragenter', e => { e.preventDefault(); depth += 1; document.body.classList.add('dropping'); });
  addEventListener('dragleave', () => { depth -= 1; if (depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { addFiles(files); return; }
    const text = e.dataTransfer?.getData('text');
    if (text) { try { const n = addFrom(text, 'The dropped text'); report(`Added ${n} stock${n === 1 ? '' : 's'}.`); } catch (error) { report(error.message, true); } }
  });
  addEventListener('paste', e => {
    if (e.target === $('paste')) return;
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    try { const n = addFrom(text, 'The pasted text'); report(`Added ${n} stock${n === 1 ? '' : 's'}.`); } catch (error) { report(error.message, true); }
  });
  addEventListener('resize', layoutLabels);
  addEventListener('pagehide', () => source.stop());
  requestAnimationFrame(frame);
}

start();
