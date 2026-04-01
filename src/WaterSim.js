import * as THREE from 'three';

// ─── Simulation shaders ───────────────────────────────────────────────────────
const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// Wave equation: h_new = (n + s + e + w) * 0.5 - h_prev   (c²=0.5, at stability limit)
// Multiply by damping to prevent accumulation.
const FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uCurrent;
  uniform sampler2D uPrevious;
  uniform vec2  uTexelSize;
  uniform vec2  uTouchUV;
  uniform float uTouchActive;
  uniform float uTouchRadius;
  uniform float uTouchStrength;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    float curr = texture2D(uCurrent,  vUv).r;
    float prev = texture2D(uPrevious, vUv).r;

    float n = texture2D(uCurrent, vUv + vec2(0.0,         uTexelSize.y)).r;
    float s = texture2D(uCurrent, vUv - vec2(0.0,         uTexelSize.y)).r;
    float e = texture2D(uCurrent, vUv + vec2(uTexelSize.x, 0.0        )).r;
    float w = texture2D(uCurrent, vUv - vec2(uTexelSize.x, 0.0        )).r;

    // 2D wave propagation
    float wave = (n + s + e + w) * 0.5 - prev;

    // Gentle damping
    wave *= 0.9875;

    // ── Wind effect — 4 plane-wave trains traveling in a common direction ──
    // Each train has a slightly different angle, frequency, and speed so they
    // interfere and produce natural-looking surface chop even without interaction.
    // Amplitudes are tuned so steady-state height ≈ amplitude / (1 − 0.9875).
    float w1 = sin(dot(vUv, vec2(0.834, 0.552)) * 28.0 - uTime * 1.75) * 0.00052;
    float w2 = sin(dot(vUv, vec2(0.951, 0.309)) * 40.0 - uTime * 2.50) * 0.00038;
    float w3 = sin(dot(vUv, vec2(0.707, 0.707)) * 20.0 - uTime * 1.20) * 0.00062;
    float w4 = sin(dot(vUv, vec2(0.883, 0.469)) * 54.0 - uTime * 3.10) * 0.00024;
    wave += w1 + w2 + w3 + w4;

    // Touch / click disturbance
    if (uTouchActive > 0.5) {
      float d  = distance(vUv, uTouchUV);
      float r  = smoothstep(uTouchRadius, 0.0, d);
      wave    += r * uTouchStrength;
    }

    gl_FragColor = vec4(clamp(wave, -1.0, 1.0), 0.0, 0.0, 1.0);
  }
`;

// ─── WaterSim class ───────────────────────────────────────────────────────────
export class WaterSim {
  constructor(renderer, size = 512) {
    this.renderer = renderer;
    this.size     = size;
    this.frame    = 0;
    this._queue   = [];           // pending touch events

    const opts = {
      type:        THREE.HalfFloatType,  // good mobile support
      format:      THREE.RGBAFormat,
      minFilter:   THREE.LinearFilter,
      magFilter:   THREE.LinearFilter,
      depthBuffer: false,
    };

    // Triple buffer: write to "next", read "current" and "previous"
    this.rts = [
      new THREE.WebGLRenderTarget(size, size, opts),
      new THREE.WebGLRenderTarget(size, size, opts),
      new THREE.WebGLRenderTarget(size, size, opts),
    ];

    this._scene = new THREE.Scene();
    this._cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = {
      uCurrent:       { value: null },
      uPrevious:      { value: null },
      uTexelSize:     { value: new THREE.Vector2(1 / size, 1 / size) },
      uTouchUV:       { value: new THREE.Vector2(-1, -1) },
      uTouchActive:   { value: 0.0 },
      uTouchRadius:   { value: 0.04 },
      uTouchStrength: { value: 0.0 },
      uTime:          { value: 0.0 },
    };

    this._scene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.ShaderMaterial({
          uniforms:       this.uniforms,
          vertexShader:   VERT,
          fragmentShader: FRAG,
        })
      )
    );
  }

  /** Schedule a ripple at normalized UV coordinates [0,1] */
  addTouch(uvX, uvY, strength = 0.5, radius = 0.04) {
    this._queue.push({ x: uvX, y: uvY, strength, radius });
  }

  /** Advance the simulation by one step */
  step(time = 0) {
    const f    = this.frame;
    const curr = this.rts[ f      % 3];
    const prev = this.rts[(f + 2) % 3];
    const next = this.rts[(f + 1) % 3];

    this.uniforms.uCurrent.value  = curr.texture;
    this.uniforms.uPrevious.value = prev.texture;
    this.uniforms.uTime.value     = time;

    if (this._queue.length > 0) {
      const t = this._queue.shift();
      this.uniforms.uTouchUV.value.set(t.x, t.y);
      this.uniforms.uTouchActive.value   = 1.0;
      this.uniforms.uTouchRadius.value   = t.radius;
      this.uniforms.uTouchStrength.value = t.strength;
    } else {
      this.uniforms.uTouchActive.value = 0.0;
    }

    this.renderer.setRenderTarget(next);
    this.renderer.render(this._scene, this._cam);
    this.renderer.setRenderTarget(null);

    this.frame++;
  }

  /** The most recently computed height-map texture */
  get texture() {
    return this.rts[this.frame % 3].texture;
  }
}
