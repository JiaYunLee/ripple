import * as THREE from 'three';
import { WaterSim }    from './WaterSim.js';
import { FaceTracker } from './FaceTracker.js';
import './style.css';

// ── Renderer ───────────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const quad  = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ── Water simulation ───────────────────────────────────────────────────────────
const sim = new WaterSim(renderer, 512);

// ── Face tracker ───────────────────────────────────────────────────────────────
const faceTracker = new FaceTracker();
faceTracker.init();
let face = { cx: 0.5, cy: 0.45, rx: 3.0, ry: 3.0 };

// ── Motion detector ────────────────────────────────────────────────────────────
// Samples the video at low resolution, diffs consecutive frames,
// and returns motion events to drive ripples.
class MotionDetector {
  constructor(w = 48, h = 27) {
    this.w = w; this.h = h;
    this.canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.ctx    = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev   = null;
    this._lastT = 0;
  }

  /** Returns array of {x,y,mag} or null if not enough time has passed. */
  sample(video, intervalMs = 85) {
    const now = performance.now();
    if (now - this._lastT < intervalMs) return null;
    if (!video.videoWidth || video.readyState < 2) return null;
    this._lastT = now;

    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    const curr = this.ctx.getImageData(0, 0, this.w, this.h).data;
    const prev = this.prev;
    this.prev  = new Uint8ClampedArray(curr);
    if (!prev) return null;

    const events = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i    = (y * this.w + x) * 4;
        const diff = (Math.abs(curr[i]   - prev[i])   +
                      Math.abs(curr[i+1] - prev[i+1]) +
                      Math.abs(curr[i+2] - prev[i+2])) / 3 / 255;
        if (diff > 0.11) events.push({ x, y, mag: diff });
      }
    }
    return events;
  }
}

const motionDet = new MotionDetector(48, 27);

/** Smoothstep helper (JS side) */
const ss = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Convert a motion-detector pixel (canvas top-left origin)
 * to simulation UV (screen UV, bottom-left origin).
 * Mirrors and inverts the same cover-fit the shader applies.
 */
function pixelToSimUV(x, y, w, h, scrAsp, camAsp) {
  if (scrAsp > camAsp) {
    const s = scrAsp / camAsp;
    return [1 - x / w,  0.5 + (0.5 - y / h) / s];
  } else {
    const s = camAsp / scrAsp;
    return [0.5 + (0.5 - x / w) / s,  1 - y / h];
  }
}

// ── Camera / video ─────────────────────────────────────────────────────────────
const video = Object.assign(document.createElement('video'), {
  autoplay: true, playsInline: true, muted: true,
});
let videoTex        = null;
let cameraOn        = false;
let blendTarget     = 0.0;
let streamStopTimer = null;

async function startCamera() {
  clearTimeout(streamStopTimer);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    videoTex = new THREE.VideoTexture(video);
    videoTex.minFilter = THREE.LinearFilter;
    videoTex.magFilter = THREE.LinearFilter;
    displayMat.uniforms.uCamera.value = videoTex;
    cameraOn    = true;
    blendTarget = 1.0;
  } catch {
    cameraOn = false; blendTarget = 0.0;
  }
  syncBtn();
}

function stopCamera() {
  blendTarget = 0.0;
  cameraOn    = false;
  face        = { cx: 0.5, cy: 0.45, rx: 3.0, ry: 3.0 };
  syncBtn();
  streamStopTimer = setTimeout(() => {
    video.srcObject?.getTracks().forEach(t => t.stop());
    video.srcObject = null;
  }, 750);
}

// ── Display shader — CRAYON TEXTURE STYLE ─────────────────────────────────────
const displayMat = new THREE.ShaderMaterial({
  uniforms: {
    uHeight:       { value: null },
    uCamera:       { value: null },
    uTexelSize:    { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uResolution:   { value: new THREE.Vector2(innerWidth, innerHeight) },
    uCameraBlend:  { value: 0.0 },
    uCameraAspect: { value: 16 / 9 },
    uDistortion:   { value: 0.032 },
    uTime:         { value: 0.0 },
    uFaceCenter:   { value: new THREE.Vector2(0.5, 0.45) },
    uFaceRadius:   { value: new THREE.Vector2(3.0, 3.0) },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
  `,

  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D uHeight;
    uniform sampler2D uCamera;
    uniform vec2  uTexelSize;
    uniform vec2  uResolution;
    uniform float uCameraBlend;
    uniform float uCameraAspect;
    uniform float uDistortion;
    uniform float uTime;
    uniform vec2  uFaceCenter;
    uniform vec2  uFaceRadius;

    varying vec2 vUv;

    // ── Value noise ───────────────────────────────────────────────────────
    float hash21(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash21(i), hash21(i+vec2(1,0)),u.x),
                 mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),u.x),u.y);
    }

    // ── 12-tap disc blur ──────────────────────────────────────────────────
    vec3 discBlur(sampler2D tex, vec2 uv, float r) {
      vec3 c = vec3(0.0);
      c += texture2D(tex, clamp(uv+r*0.45*vec2( 1.000, 0.000),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*0.45*vec2( 0.309, 0.951),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*0.45*vec2(-0.809, 0.588),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*0.45*vec2(-0.809,-0.588),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*0.45*vec2( 0.309,-0.951),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2( 0.978, 0.208),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2( 0.208, 0.978),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2(-0.669, 0.743),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2(-1.000, 0.000),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2(-0.669,-0.743),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2( 0.208,-0.978),0.001,0.999)).rgb;
      c += texture2D(tex, clamp(uv+r*vec2( 0.978,-0.208),0.001,0.999)).rgb;
      return c / 12.0;
    }

    void main() {
      // ── Wave normals ──────────────────────────────────────────────────
      float hL = texture2D(uHeight, vUv - vec2(uTexelSize.x, 0.0)).r;
      float hR = texture2D(uHeight, vUv + vec2(uTexelSize.x, 0.0)).r;
      float hD = texture2D(uHeight, vUv - vec2(0.0, uTexelSize.y)).r;
      float hU = texture2D(uHeight, vUv + vec2(0.0, uTexelSize.y)).r;
      vec2  slope = vec2(hR-hL, hU-hD);
      float h     = texture2D(uHeight, vUv).r;

      // ── Camera UV (mirror + cover-fit + ripple distortion) ────────────
      vec2 cUV = vec2(1.0 - vUv.x, vUv.y);
      float scrAsp = uResolution.x / uResolution.y;
      if (scrAsp > uCameraAspect) {
        float s = scrAsp / uCameraAspect;
        cUV.y = (cUV.y - 0.5) * s + 0.5;
      } else {
        float s = uCameraAspect / scrAsp;
        cUV.x = (cUV.x - 0.5) * s + 0.5;
      }
      cUV += slope * uDistortion;
      cUV  = clamp(cUV, 0.001, 0.999);

      // ── Face mask + camera transition blur ───────────────────────────
      // fDist = 0 at the ellipse edge, grows outside.
      float fDist    = max(0.0, length((vUv - uFaceCenter) / uFaceRadius) - 1.0);

      // Smooth face window: 1.0 inside/at edge → 0.0 outside.
      // Wide softness (0.7) gives a gentle feathered fade.
      float faceMask = 1.0 - smoothstep(0.0, 0.7, fDist);

      // Only the toggle animation uses blur (no background blur —
      // the background will be the watercolour itself, not blurred camera).
      float transR   = (1.0 - uCameraBlend) * 0.026;
      float transAmt = 1.0 - uCameraBlend * uCameraBlend;
      vec3 camRaw    = mix(texture2D(uCamera, cUV).rgb,
                           discBlur(uCamera, cUV, transR), transAmt);

      // ════════════════════════════════════════════════════════════════
      //  WATERCOLOUR TEXTURE
      //  Technique: domain-warped multi-scale washes + paper granulation
      //  + pigment-pooling at wave edges + wet-bleed bloom.
      // ════════════════════════════════════════════════════════════════

      // ── Domain warp — makes wash shapes organic, not grid-aligned ─────
      // Two layers of noise used to offset UV before sampling colour washes
      vec2 q = vec2(
        vnoise(vUv * 3.2  + vec2(uTime * 0.035,  uTime * 0.028)),
        vnoise(vUv * 3.2  + vec2(5.18, 1.34)
                           + vec2(uTime * 0.030, -uTime * 0.024))
      );
      vec2 wUV = vUv + 0.13 * q;   // gently distorted coordinates

      // ── Wash layers at three scales ───────────────────────────────────
      // Large pools  — gentle slow drift (like pigment settling)
      float w1 = vnoise(wUV * 3.4  + vec2(uTime * 0.022, -uTime * 0.017));
      // Medium pools — medium drift
      float w2 = vnoise(wUV * 7.2  + vec2(-uTime * 0.016,  uTime * 0.013));
      // Fine detail  — almost static (paper grain-scale)
      float w3 = vnoise(wUV * 15.0 + vec2(1.7, 3.9));

      float wash = w1*0.55 + w2*0.30 + w3*0.15;   // combined wash tone

      // ── Paper granulation (static — paper doesn't move) ───────────────
      float gran  = vnoise(vUv * 210.0);            // fine paper fibre
      float fibre = vnoise(vUv *  65.0 + vec2(0.8, 2.1)); // medium fibre

      // ── Pigment concentration ─────────────────────────────────────────
      // Wave troughs gather pigment (gravity), crests are more dilute —
      // exactly how wet watercolour behaves on tilted paper.
      float pigment = clamp(wash * 0.60 - h * 0.28 + 0.50, 0.0, 1.0);

      // ── Watercolour palette — luminous, translucent blues/teals ───────
      vec3 wcPaper  = vec3(0.96, 0.98, 1.00);  // wet paper (near-white)
      vec3 wcDilute = vec3(0.72, 0.92, 0.91);  // very dilute wash
      vec3 wcMid    = vec3(0.48, 0.81, 0.80);  // mid-tone wash
      vec3 wcDeep   = vec3(0.30, 0.68, 0.69);  // concentrated pigment

      // Three-stop blend from dilute → mid → deep
      vec3 wcColor = mix(
        mix(wcDilute, wcMid,  smoothstep(0.30, 0.65, pigment)),
        wcDeep,               smoothstep(0.65, 1.00, pigment)
      );

      // Paper granulation: pigment settles into paper valleys, leaving
      // lighter peaks — the hallmark of granulating watercolours.
      wcColor = mix(wcColor, wcColor * (0.88 + gran*0.22 + fibre*0.08), 0.55);

      // ── Wet-edge bloom (backrun / cauliflower effect) ─────────────────
      // Where the wash is drying at its boundary it pulls more pigment
      // outward — visible as a slightly darker, diffuse halo.
      float edgeMag  = length(slope) * 7.0;
      float bloom    = smoothstep(0.15, 0.55, edgeMag) *
                       (1.0 - smoothstep(0.55, 0.85, edgeMag));
      wcColor = mix(wcColor, wcDeep * 0.90, bloom * 0.28);

      // ── Soft luminous areas (dilute wash catches light) ────────────────
      float lumPool  = smoothstep(0.60, 0.85, wash) * smoothstep(-0.1,0.3,h);
      wcColor = mix(wcColor, wcPaper * 1.02, lumPool * 0.32);

      // ── Camera feed — watercolour treatment ───────────────────────────
      // Slight desaturation (watercolour is translucent, not vivid like photo)
      float camLuma = dot(camRaw, vec3(0.299, 0.587, 0.114));
      vec3  camDesat = mix(camRaw, vec3(camLuma), 0.18);
      // Granulation on camera feed too (same paper, same fibre)
      camDesat *= (0.92 + gran*0.12 + fibre*0.06);
      // Luminous highlight: bright areas of face glow like wet paper
      float faceLum  = smoothstep(0.72, 0.92, camLuma);
      camDesat = mix(camDesat, wcPaper, faceLum * 0.14);
      // Tint toward watercolour wash (reflection reads as same wet medium)
      vec3 camTinted = mix(camDesat, wcColor, 0.22);

      // ── Blend: watercolour everywhere; camera only inside face window ──
      // Background is always pure watercolour, matching the camera-off look.
      vec3 color = mix(wcColor, camTinted, faceMask * uCameraBlend);

      // ── Soft wet-shine highlight (no hard Blinn-Phong) ────────────────
      vec3  Nv   = normalize(vec3(-slope.x*8.0, 1.0, -slope.y*8.0));
      vec3  Lv   = normalize(vec3(0.35, 1.0, 0.4));
      vec3  Hv   = normalize(Lv + vec3(0.0, 1.0, 0.0));
      float NdH  = max(0.0, dot(Nv, Hv));
      // Broad soft sheen — wet paper catching diffuse sky
      color += vec3(pow(NdH, 6.0) * 0.07);
      // Tiny bright glint — a single water-surface reflection
      color += vec3(pow(NdH, 80.0) * 0.55);

      // ── Soft paper-edge vignette ──────────────────────────────────────
      float edge = min(min(vUv.x,1.0-vUv.x), min(vUv.y,1.0-vUv.y));
      color = mix(mix(wcPaper, wcMid, 0.6) * 0.86, color,
                  0.78 + smoothstep(0.0, 0.22, edge) * 0.22);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
});

scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), displayMat));

// ── Camera toggle button ────────────────────────────────────────────────────────
const toggleBtn = document.getElementById('camera-toggle');
const iconOn    = document.getElementById('icon-on');
const iconOff   = document.getElementById('icon-off');
const camLabel  = document.getElementById('cam-label');

function syncBtn() {
  const on = cameraOn;
  iconOn.style.display  = on ? ''     : 'none';
  iconOff.style.display = on ? 'none' : '';
  camLabel.textContent  = on ? 'Camera' : 'Camera off';
  toggleBtn.classList.toggle('on', on);
}

toggleBtn.addEventListener('click', () => cameraOn ? stopCamera() : startCamera());

// ── Pointer / touch interaction ─────────────────────────────────────────────────
let lastMoveT = 0;
const toUV = (cx, cy) => [cx / innerWidth, 1 - cy / innerHeight];

window.addEventListener('mousemove', e => {
  const now = performance.now();
  if (now - lastMoveT < 18) return;
  lastMoveT = now;
  sim.addTouch(...toUV(e.clientX, e.clientY), 0.11, 0.032);
});
window.addEventListener('click', e =>
  sim.addTouch(...toUV(e.clientX, e.clientY), 0.72, 0.058));
window.addEventListener('touchstart', e => {
  for (const t of e.changedTouches)
    sim.addTouch(...toUV(t.clientX, t.clientY), 0.68, 0.058);
}, { passive: true });
window.addEventListener('touchmove', e => {
  e.preventDefault();
  const now = performance.now();
  if (now - lastMoveT < 28) return;
  lastMoveT = now;
  for (const t of e.touches)
    sim.addTouch(...toUV(t.clientX, t.clientY), 0.14, 0.034);
}, { passive: false });

// ── Resize ─────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  displayMat.uniforms.uResolution.value.set(innerWidth, innerHeight);
});

// ── Seeding ────────────────────────────────────────────────────────────────────
[[0.25,0.6],[0.75,0.35],[0.5,0.8],[0.15,0.3],[0.85,0.7],[0.6,0.2],[0.4,0.5]]
  .forEach(([x, y], i) => setTimeout(() => sim.addTouch(x, y, 0.07, 0.07), i * 260));

let nextAmbient = 2500;

// ── Animation loop ─────────────────────────────────────────────────────────────
function loop(t) {
  requestAnimationFrame(loop);

  // Sporadic ambient ripple
  if (t > nextAmbient) {
    sim.addTouch(Math.random(), Math.random(), 0.05, 0.06);
    nextAmbient = t + 2800 + Math.random() * 4200;
  }

  // ── Video + face + motion ─────────────────────────────────────────────
  if (video.readyState >= 2 && videoTex) {
    videoTex.needsUpdate = true;

    const camAsp = video.videoWidth / video.videoHeight || 16 / 9;
    if (camAsp > 0) displayMat.uniforms.uCameraAspect.value = camAsp;

    const scrAsp = innerWidth / innerHeight;

    // Face detection (throttled internally)
    faceTracker.detect(video, scrAsp, camAsp);

    // ── Camera motion → ripples ─────────────────────────────────────
    const events = motionDet.sample(video, 85);
    if (events && events.length > 0) {
      // Sort by magnitude; take the strongest cells (avoid flooding queue)
      events.sort((a, b) => b.mag - a.mag);
      const top = events.slice(0, 7);

      for (const e of top) {
        const [su, sv] = pixelToSimUV(
          e.x, e.y, motionDet.w, motionDet.h, scrAsp, camAsp
        );
        if (su < 0.02 || su > 0.98 || sv < 0.02 || sv > 0.98) continue;

        // Proportional: small motion → subtle ripple, large → strong wave
        const strength = ss(0.11, 0.55, e.mag) * 0.32;
        const radius   = 0.026 + e.mag * 0.045;
        if (strength > 0.005) sim.addTouch(su, sv, strength, radius);
      }
    }
  }

  // ── Smooth face ellipse ───────────────────────────────────────────────
  const FACE_TTL = 2500;
  const hasFace  = faceTracker.face &&
                   faceTracker.seenAt &&
                   (performance.now() - faceTracker.seenAt < FACE_TTL);
  const faceTarget = hasFace
    ? faceTracker.face
    : { cx: 0.5, cy: 0.45, rx: 3.0, ry: 3.0 };

  const k = 0.055;
  face.cx += (faceTarget.cx - face.cx) * k;
  face.cy += (faceTarget.cy - face.cy) * k;
  face.rx += (faceTarget.rx - face.rx) * k;
  face.ry += (faceTarget.ry - face.ry) * k;
  displayMat.uniforms.uFaceCenter.value.set(face.cx, face.cy);
  displayMat.uniforms.uFaceRadius.value.set(face.rx, face.ry);

  // ── Camera blend ──────────────────────────────────────────────────────
  const u = displayMat.uniforms.uCameraBlend;
  u.value += (blendTarget - u.value) * 0.072;
  if (u.value < 0.001) u.value = 0.0;
  if (u.value > 0.999) u.value = 1.0;

  // ── Sim + render ──────────────────────────────────────────────────────
  const ts = t * 0.001;
  sim.step(ts);
  displayMat.uniforms.uHeight.value = sim.texture;
  displayMat.uniforms.uTime.value   = ts;
  renderer.render(scene, quad);
}

// ── Boot ───────────────────────────────────────────────────────────────────────
syncBtn();
startCamera();
requestAnimationFrame(loop);
