const canvas = document.querySelector('#material');
const word = document.querySelector('#word-window');
const scene = document.querySelector('#installation');
const motionButton = document.querySelector('#motion');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let paused = reducedMotion.matches;
let renderer = null;
let isHeld = false;
let pulse = 0;

function syncMotion() {
  motionButton.setAttribute('aria-pressed', String(paused));
  motionButton.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
  motionButton.title = paused ? 'Play animation' : 'Pause animation';
  document.querySelector('#motion-icon').setAttribute('d', paused ? 'M3 2l7 5-7 5V2Z' : 'M3 2v10M9 2v10');
}
motionButton.addEventListener('click', () => { paused = !paused; syncMotion(); renderer?.wake(); });
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) { paused = true; syncMotion(); renderer?.wake(); } });
word.addEventListener('pointerdown', event => { if (event.button !== 0) return; isHeld = true; word.setPointerCapture(event.pointerId); renderer?.wake(); });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  word.addEventListener(event, () => { isHeld = false; renderer?.wake(); });
}
word.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); isHeld = true; renderer?.wake(); } });
word.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') { isHeld = false; pulse = 1; renderer?.wake(); } });
word.addEventListener('blur', () => { isHeld = false; renderer?.wake(); });
word.addEventListener('click', () => { pulse = 1; renderer?.wake(); });
syncMotion();

// Signed-distance lettering lets the fragment shader shade the cut edge, the
// recessed pocket, the acrylic bevel, and the LCD as separate material layers.
// Exact Euclidean distance transform, after Felzenszwalb / Huttenlocher.
function distanceTransform(features, width, height) {
  const result = new Float64Array(width * height);
  const size = Math.max(width, height);
  const f = new Float64Array(size), d = new Float64Array(size);
  const v = new Int32Array(size), z = new Float64Array(size + 1);
  const transform = n => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      v[++k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = features[y * width + x] ? 0 : 1e10;
    transform(width);
    for (let x = 0; x < width; x++) result[y * width + x] = d[x];
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = result[y * width + x];
    transform(height);
    for (let y = 0; y < height; y++) result[y * width + x] = Math.sqrt(d[y]);
  }
  return result;
}

async function makeLettering() {
  await document.fonts.load('700 100px Barlow');
  const width = 1536, height = 640, range = 64;
  const mask = document.createElement('canvas'); mask.width = width; mask.height = height;
  const context = mask.getContext('2d', { willReadFrequently: true });
  context.font = '700 600px Barlow';
  const bounds = context.measureText('KURO');
  const ascent = bounds.actualBoundingBoxAscent, descent = bounds.actualBoundingBoxDescent;
  const sx = (width - 32) / (bounds.actualBoundingBoxLeft + bounds.actualBoundingBoxRight);
  const sy = (height - 32) / (ascent + descent);
  context.translate(16 + bounds.actualBoundingBoxLeft * sx, 16 + ascent * sy);
  context.scale(sx, sy); context.fillStyle = '#fff'; context.fillText('KURO', 0, 0);
  const bitmap = context.getImageData(0, 0, width, height);
  const ink = new Uint8Array(width * height), outside = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) { ink[i] = bitmap.data[i * 4 + 3] >= 128 ? 1 : 0; outside[i] = 1 - ink[i]; }
  const toInk = distanceTransform(ink, width, height), toOutside = distanceTransform(outside, width, height);
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < ink.length; i++) {
    const signed = toInk[i] - toOutside[i];
    const encoded = Math.max(0, Math.min(255, Math.round(128 + signed / range * 127)));
    pixels[i * 4] = encoded; pixels[i * 4 + 1] = encoded; pixels[i * 4 + 2] = encoded; pixels[i * 4 + 3] = 255;
  }
  return { width, height, range, pixels };
}

const vertexSource = `attribute vec2 position; void main(){gl_Position=vec4(position,0.,1.);}`;
const fragmentSource = `
precision highp float;
uniform vec2 resolution;
uniform vec2 cssSize;
uniform vec4 logo;
uniform sampler2D letters;
uniform vec2 maskSize;
uniform float distanceRange;
uniform vec2 pointer;
uniform float time;
uniform float press;
uniform float pulse;
float sat(float x){return clamp(x,0.,1.);}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float sd(vec2 uv){
  if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)return 100.;
  return (texture2D(letters,uv).r*255.-128.)/127.*distanceRange*logo.w/maskSize.y;
}
float gaussian(vec2 p,vec2 center,vec2 size){vec2 q=(p-center)/size;return exp(-dot(q,q)*2.);}
vec3 lcd(vec2 p,float t){
  // Each letter has its own small backlit display. Chunky content is diffused
  // by the frosted underside of the cap; the light keeps moving underneath.
  float cell=floor(clamp(p.x,0.,.999)*4.);
  vec2 q=vec2(fract(p.x*4.),p.y);
  float slow=t*.13;
  q+=vec2(sin(q.y*3.+slow+cell)*.12,cos(q.x*3.-slow*.7)*.13);
  float a=gaussian(q,vec2(.28+sin(slow+cell)*.28,.65+cos(slow*.8+cell)*.3),vec2(.62,.64));
  float b=gaussian(q,vec2(.74+cos(slow*.7+cell*2.)*.25,.24+sin(slow*.9+cell)*.3),vec2(.48,.6));
  float c=gaussian(q,vec2(.1+sin(slow*.45+cell)*.4,.0+cos(slow+cell)*.3),vec2(.8,.9));
  vec3 low=vec3(.027,.044,.043);
  vec3 lightA=vec3(.55,.78,.68), lightB=vec3(.82,.56,.37);
  if(cell<.5){lightA=vec3(.89,.39,.20);lightB=vec3(.62,.60,.72);}
  else if(cell<1.5){lightA=vec3(.62,.79,.70);lightB=vec3(.51,.62,.82);}
  else if(cell<2.5){lightA=vec3(.54,.56,.78);lightB=vec3(.85,.59,.39);}
  else{lightA=vec3(.43,.70,.63);lightB=vec3(.69,.78,.69);}
  vec3 col=low+lightA*a*.92+lightB*b*.68+vec3(.18,.24,.25)*c;
  float ribbon=exp(-pow((q.y-.48-sin(q.x*3.1+slow+cell)*.19)*6.,2.));
  col*=.58+.28*ribbon;
  return col;
}
vec3 aces(vec3 c){return clamp((c*(2.51*c+.03))/(c*(2.43*c+.59)+.14),0.,1.);}
void main(){
  vec2 p=gl_FragCoord.xy/resolution*cssSize;
  p.y=cssSize.y-p.y;
  vec2 uv=(p-logo.xy)/logo.zw;
  float d=sd(uv);
  float e=1.;
  vec2 gradient=vec2(sd(uv+vec2(e/logo.z,0.))-sd(uv-vec2(e/logo.z,0.)),sd(uv+vec2(0.,e/logo.w))-sd(uv-vec2(0.,e/logo.w)));
  vec2 normal=gradient/max(length(gradient),.001);
  vec2 screen=p/cssSize;
  vec2 key=vec2(.25,.05)+pointer*vec2(.15,.09);
  float broad=gaussian(screen,key,vec2(.78,.75));
  float grazing=gaussian(screen,vec2(.95,.1)+pointer*.13,vec2(.9,.6));
  float noise=hash(floor(p*1.7))-.5;
  vec3 matte=vec3(.043,.047,.050)+vec3(.013,.016,.017)*broad+grazing*vec3(.005,.006,.006);
  matte+=noise*.0035;
  matte*=1.-.09*length(screen-.5);
  // Sunk pocket: dark contact, a machined lip, then illuminated inner walls.
  vec2 lightDir=normalize(vec2(-.55,-.8)+pointer*.3);
  float edgeLight=dot(normal,lightDir);
  float outerBevel=(1.-smoothstep(.15,2.6,d))*step(0.,d);
  matte+=outerBevel*(vec3(.033,.04,.04)*sat(edgeLight)+vec3(.003));
  matte-=exp(-abs(d-3.)*1.8)*.012*step(0.,d);
  vec2 shifted=uv+pointer*vec2(.013,.026)*(1.-press*.78);
  float focus=mix(140.,420.,press);
  vec2 pixelUV=floor(shifted*vec2(focus,focus*.45))/vec2(focus,focus*.45);
  vec3 light=lcd(pixelUV,time);
  float fresnel=.04+pow(sat(length(uv-.5)*.45),5.);
  float bevelWidth=clamp(logo.w*.018,3.,8.);
  float inside=sat(-d/bevelWidth);
  vec2 bentUV=pixelUV-normal*pow(1.-inside,2.)*.023;
  vec3 bent=lcd(bentUV,time);
  // RGB subpixels remain softened until the cap is pressed toward the LCD.
  vec2 grid=shifted*vec2(focus,focus*.45);
  float sx=fract(grid.x);
  vec3 stripes=vec3(1.,.84,.84);
  if(sx>.333)stripes=vec3(.84,1.,.84);
  if(sx>.666)stripes=vec3(.84,.84,1.);
  float aperture=mix(.8,1.,smoothstep(.06,.24,fract(grid.y)));
  vec3 acrylic=mix(light,bent,(1.-inside)*.75)*mix(vec3(.92),stripes,mix(.23,.85,press))*aperture;
  acrylic*=mix(.8,1.,press);
  acrylic+=vec3(.013,.019,.02)*(1.-press*.65);
  // A broad reflected softbox bends across the glossy face of each cutout.
  float reflection=gaussian(uv,vec2(.38+pointer.x*.15,-.65+pointer.y*.08),vec2(.85,1.15));
  acrylic+=reflection*vec3(.13,.15,.15)*fresnel*2.;
  acrylic*=mix(.24,1.,smoothstep(0.,.75,inside));
  acrylic*=1.-.5*sat(edgeLight)*exp(-max(-d,0.)/7.);
  acrylic+=bent*sat(-edgeLight)*exp(-abs(d+1.4)*1.2)*.22;
  float pipe=exp(-pow((d+bevelWidth*.55)/(bevelWidth*.22),2.));
  acrylic+=bent*pipe*(.11+.12*sat(edgeLight));
  acrylic+=sat(edgeLight)*exp(-abs(d+.8)*1.8)*vec3(.08,.1,.1);
  acrylic*=1.+pulse*.2;
  // A restrained spill is visible on the matte around the lit aperture.
  matte+=light*exp(-max(d,0.)/9.)*.013*step(0.,d);
  vec3 color=mix(matte,aces(acrylic*1.08),1.-smoothstep(-.6,.6,d));
  color+=noise*.002;
  gl_FragColor=vec4(color,1.);
}`;

async function initMaterial() {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return;
  const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const shaderSource = precision?.precision ? fragmentSource : fragmentSource.replace('precision highp float;', 'precision mediump float;');
  const compile = (type, source) => {
    const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, shaderSource));
  gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(['resolution','cssSize','logo','letters','maskSize','distanceRange','pointer','time','press','pulse'].map(name => [name, gl.getUniformLocation(program, name)]));
  const mask = await makeLettering();
  const texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, mask.width, mask.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask.pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(uniforms.letters, 0); gl.uniform2f(uniforms.maskSize, mask.width, mask.height); gl.uniform1f(uniforms.distanceRange, mask.range);
  let width = 1, height = 1, logo = [0,0,1,1], target = [0,0], pointer = [0,0], press = 0;
  let lastTime = performance.now(), animationTime = 5.2, lastDraw = 0, raf = 0, lost = false;
  const draw = () => {
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height); gl.uniform2f(uniforms.cssSize, width, height);
    gl.uniform4f(uniforms.logo, ...logo); gl.uniform2f(uniforms.pointer, ...pointer);
    gl.uniform1f(uniforms.time, animationTime); gl.uniform1f(uniforms.press, press); gl.uniform1f(uniforms.pulse, pulse);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
  const tick = now => {
    raf = 0; if (lost || document.hidden) return;
    if (now-lastDraw < 1000/30) { raf=requestAnimationFrame(tick); return; }
    const dt=Math.min((now-lastTime)/1000,.1); lastTime=now;lastDraw=now;
    if (!paused) animationTime += dt;
    const blend=reducedMotion.matches?1:1-Math.exp(-dt*6);
    pointer[0]+=(target[0]-pointer[0])*blend;pointer[1]+=(target[1]-pointer[1])*blend;
    press+=((isHeld?1:0)-press)*(reducedMotion.matches?1:1-Math.exp(-dt*12));
    pulse=Math.max(0,pulse-dt*.8);
    draw();
    const settling=Math.abs(pointer[0]-target[0])+Math.abs(pointer[1]-target[1])+Math.abs(press-(isHeld?1:0))+pulse>.002;
    if(!paused||settling)raf=requestAnimationFrame(tick);
  };
  const wake=()=>{if(!raf&&!lost&&!document.hidden){lastTime=performance.now();raf=requestAnimationFrame(tick);}};
  const resize=()=>{
    const rect=scene.getBoundingClientRect(), bounds=word.getBoundingClientRect();width=rect.width;height=rect.height;
    const dpr=Math.min(devicePixelRatio||1,1.5,1800/Math.max(width,height));
    canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));gl.viewport(0,0,canvas.width,canvas.height);
    logo=[bounds.left-rect.left,bounds.top-rect.top,bounds.width,bounds.height];draw();wake();
  };
  const observer=new ResizeObserver(resize);observer.observe(scene);observer.observe(word);
  const pointerMove=event=>{const r=scene.getBoundingClientRect();target=[(event.clientX-r.left)/r.width*2-1,(event.clientY-r.top)/r.height*2-1];wake();};
  const pointerLeave=()=>{target=[0,0];wake();};
  scene.addEventListener('pointermove',pointerMove,{passive:true});scene.addEventListener('pointerleave',pointerLeave);
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else wake();};
  document.addEventListener('visibilitychange',visibility);
  canvas.addEventListener('webglcontextlost',event=>{
    event.preventDefault();lost=true;cancelAnimationFrame(raf);observer.disconnect();
    scene.removeEventListener('pointermove',pointerMove);scene.removeEventListener('pointerleave',pointerLeave);document.removeEventListener('visibilitychange',visibility);
    scene.classList.remove('gpu-ready');canvas.classList.remove('ready');renderer=null;
  },{once:true});
  canvas.addEventListener('webglcontextrestored',()=>initMaterial().catch(console.warn),{once:true});
  renderer={wake};resize();scene.classList.add('gpu-ready');canvas.classList.add('ready');wake();
}
initMaterial().catch(error=>console.warn('Material renderer unavailable; using the static wordmark.',error));
