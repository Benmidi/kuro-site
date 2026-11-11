const $ = (selector) => document.querySelector(selector);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const stocks = [
  { name: 'SUMI 1600', iso: 1600, fps: 8, note: 'SUMI / Hard grain. Deep blacks. Eight frames a second.' },
  { name: 'MIST 160', iso: 160, fps: 6, note: 'MIST / Soft color. Warm bloom. A gentle back-and-forth.' },
  { name: 'KARE ’09', iso: 400, fps: 5, note: 'KARE / Shifted color. Restless grain. A little unpredictability.' },
];
let stock = 2, exposure = 0, paused = reducedMotion.matches;
let started = performance.now(), frozenTime = 0, resumeOffset = 0, frame = 0;
let render = () => {};

function setStock(index, scroll = false) {
  stock = index;
  document.querySelectorAll('[data-stock]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.stock) === stock)));
  $('#stock-label').textContent = stocks[stock].name;
  $('#iso-label').textContent = `ISO ${stocks[stock].iso}`;
  $('#capture-status').textContent = stocks[stock].note;
  $('.photo-fallback').style.filter = ['grayscale(1) contrast(1.5)', 'saturate(.6) brightness(1.2) contrast(.8)', 'sepia(.22) saturate(.75)'][stock];
  if (scroll) $('#camera').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' });
  render();
}
document.querySelectorAll('[data-stock]').forEach(button => button.addEventListener('click', () => setStock(Number(button.dataset.stock), button.classList.contains('stock-card'))));
$('#exposure').addEventListener('input', event => {
  exposure = Number(event.target.value);
  const text = `${exposure < -.05 ? '' : '+'}${Math.abs(exposure) < .05 ? '0.0' : exposure.toFixed(1)}`;
  $('#ev-value').textContent = text;
  $('#exposure-label').textContent = `EV ${text}`;
  render();
});
function syncMotion() {
  $('#motion').setAttribute('aria-pressed', String(paused));
  $('#motion-label').textContent = paused ? 'PLAY' : 'PAUSE';
  $('#motion .motion-icon').textContent = paused ? '▷' : 'Ⅱ';
  $('#motion').setAttribute('aria-label', paused ? 'Play demo motion' : 'Pause demo motion');
  $('.ticker>div').style.animationPlayState = paused ? 'paused' : 'running';
}
$('#motion').addEventListener('click', () => {
  if (!paused) frozenTime = (performance.now() - started) / 1000 - resumeOffset;
  else resumeOffset = (performance.now() - started) / 1000 - frozenTime;
  paused = !paused;
  syncMotion(); render();
});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches && !paused) $('#motion').click();
});
syncMotion();
$('#shutter').addEventListener('click', () => {
  const flash = $('#shutter-flash');
  flash.classList.remove('flash');
  void flash.offsetWidth;
  flash.classList.add('flash');
  $('#camera-mode').textContent = 'LOOP CAPTURED';
  $('#capture-status').textContent = 'A moment, on repeat. This is a browser preview; nothing was saved.';
  $('#shutter').disabled = true;
  setTimeout(() => { $('#camera-mode').textContent = 'LIVE VIEW'; $('#shutter').disabled = false; }, 1800);
  render();
});

// A single small WebGL surface: stock curves, animated grain, warm halation,
// per-stock cadence, subtle frame registration, vignette and an expired-film leak.
// The source is a static AI photograph: this intentionally illustrates character,
// rather than claiming to be five actual camera exposures or a native app capture.
const vertexSource = `attribute vec2 position; varying vec2 vUv; void main(){vUv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const fragmentSource = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D image;
uniform vec2 resolution;
uniform vec2 imageSize;
uniform vec2 pointer;
uniform float time;
uniform float stock;
uniform float exposure;
uniform float motion;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec3 sampleImage(vec2 uv){return texture2D(image,clamp(uv,.001,.999)).rgb;}
void main(){
  float fps=stock<.5?8.:stock<1.5?6.:5.;
  float tick=floor(time*fps);
  float f=mod(tick,5.);
  if(stock>.5&&stock<1.5)f=abs(mod(tick,8.)-4.);
  vec2 uv=vUv;
  float aspect=resolution.x/resolution.y;
  float sourceAspect=imageSize.x/imageSize.y;
  if(aspect<sourceAspect)uv.x=(uv.x-.5)*aspect/sourceAspect+.5;
  else uv.y=(uv.y-.5)*sourceAspect/aspect+.5;
  uv=(uv-.5)*.96+.5;
  uv+=vec2(sin(f*1.3)*.0025,cos(f*1.6)*.0015)*motion;
  uv+=pointer*.004*motion;
  vec3 c=sampleImage(uv);
  vec2 px=1./imageSize;
  vec3 halo=vec3(0.);
  halo+=max(sampleImage(uv+px*vec2(5.,0.))-.55,0.);
  halo+=max(sampleImage(uv+px*vec2(-5.,0.))-.55,0.);
  halo+=max(sampleImage(uv+px*vec2(0.,5.))-.55,0.);
  halo+=max(sampleImage(uv+px*vec2(0.,-5.))-.55,0.);
  c*=pow(2.,exposure);
  float lum=dot(c,vec3(.299,.587,.114));
  float grain=hash(floor(gl_FragCoord.xy/1.3)+vec2(floor(time*24.),floor(time*24.)*.71))-.5;
  if(stock<.5){
    c=vec3(pow(clamp((lum-.075)*1.25,0.,1.),1.15));
    c+=grain*.15;
  }else if(stock<1.5){
    c=mix(vec3(lum),c,.68)*.86+vec3(.085,.077,.082);
    c+=halo*vec3(.22,.12,.07);
    c+=grain*.055;
  }else{
    c=pow(max(c,vec3(.001)),vec3(.87,1.03,1.18))*vec3(1.07,.96,.9)+vec3(.025,.02,.006);
    c+=halo*vec3(.21,.045,.01);
    c+=grain*(.075+(1.-lum)*.07);
    float leak=pow(max(0.,1.-vUv.x),5.5)*(.035+.06*(.5+.5*sin(time*.36)));
    c+=vec3(1.,.19,.025)*leak;
    c*=1.+sin(tick*1.73)*.014;
  }
  float vignette=1.-dot(vUv-.5,vUv-.5)*(stock<.5?.65:.4);
  c*=vignette;
  gl_FragColor=vec4(clamp(c,0.,1.),1.);
}`;

async function initFilm() {
  const canvas = $('#film');
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const locations = Object.fromEntries(['image','resolution','imageSize','pointer','time','stock','exposure','motion'].map(name => [name, gl.getUniformLocation(program,name)]));
  const image = new Image(); image.src = new URL('assets/after-rain.jpg', import.meta.url).href;
  await image.decode();
  const texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(locations.image,0); gl.uniform2f(locations.imageSize,image.naturalWidth,image.naturalHeight);
  let pointer = [0,0], inView = true, lastDraw = 0, lost = false;
  const resize = () => {
    const rect=canvas.getBoundingClientRect(), dpr=Math.min(devicePixelRatio || 1,1.5);
    canvas.width=Math.round(rect.width*dpr); canvas.height=Math.round(rect.height*dpr);
    gl.viewport(0,0,canvas.width,canvas.height); render();
  };
  render = () => {
    if (lost) return;
    const now=performance.now();
    const time=paused?frozenTime:(now-started)/1000-resumeOffset;
    frame=stock===1?Math.abs(Math.floor(time*6)%8-4):Math.floor(time*stocks[stock].fps)%5;
    $('#frame-label').textContent=`FRAME ${String(frame+1).padStart(2,'0')} / 05`;
    gl.uniform2f(locations.resolution,canvas.width,canvas.height);
    gl.uniform2f(locations.pointer,...pointer);
    gl.uniform1f(locations.time,time); gl.uniform1f(locations.stock,stock);
    gl.uniform1f(locations.exposure,exposure); gl.uniform1f(locations.motion,paused?0:1);
    gl.drawArrays(gl.TRIANGLES,0,6);
  };
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;canvas.classList.remove('ready');});
  canvas.addEventListener('webglcontextrestored',()=>{initFilm().catch(console.warn);},{once:true});
  $('#viewfinder').addEventListener('pointermove',event=>{
    if(paused)return;
    const rect=canvas.getBoundingClientRect();
    pointer=[(event.clientX-rect.left)/rect.width-.5,(event.clientY-rect.top)/rect.height-.5];
  },{passive:true});
  $('#viewfinder').addEventListener('pointerleave',()=>{pointer=[0,0];});
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;},{rootMargin:'100px'}).observe(canvas);
  resize(); canvas.classList.add('ready');
  const loop = now => {
    if(lost)return;
    if(!document.hidden&&inView&&!paused&&now-lastDraw>=1000/24){render();lastDraw=now;}
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
initFilm().catch(error=>console.warn('Film preview unavailable; showing the still photograph.',error));

// Only the public function URL ships to the static site; database credentials
// and the salted network hash remain on the Supabase Edge Function.
const waitlistEndpoint='https://rqirmprdejkkfvzhttco.supabase.co/functions/v1/kuro-waitlist';
async function requestWaitlist(payload) {
  const response=await fetch(waitlistEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  if(!response.ok){
    if(response.status===429)throw Error('A few too many attempts. Please try again in an hour.');
    if(response.status===400)throw Error('Please check your email address and try again.');
    throw Error('We couldn’t reach the list. Please try again in a moment.');
  }
  const data=await response.json();
  if(data.ok!==true)throw Error('Your request wasn’t saved. Please try again.');
}
$('#waitlist-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.currentTarget, button=form.querySelector('[type=submit]'), status=$('#form-status');
  if(button.disabled)return;
  button.disabled=true; status.textContent='Saving your spot…'; status.dataset.error='false';
  const data=new FormData(form);
  try{
    await requestWaitlist({email:String(data.get('email')).trim(),platform:data.get('platform'),website:data.get('website'),action:'join'});
    status.textContent='You’re on the list. We’ll be in touch when KURO is ready.';
    form.reset();
  }catch(error){status.textContent=error.message;status.dataset.error='true';}
  finally{button.disabled=false;}
});
const dialog=$('#privacy-dialog');
$('#privacy-open').addEventListener('click',()=>dialog.showModal());
$('#privacy-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
$('#removal-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.currentTarget.querySelector('button'),status=$('#removal-status');
  if(button.disabled)return;
  button.disabled=true;status.dataset.error='false';status.textContent='Removing…';
  try{
    await requestWaitlist({email:$('#removal-email').value.trim(),action:'remove'});
    status.textContent='If that address was on the list, it has been removed.';
    event.target.reset();
  }catch(error){status.textContent=error.message;status.dataset.error='true';}
  finally{button.disabled=false;}
});
$('#year').textContent=new Date().getFullYear();
