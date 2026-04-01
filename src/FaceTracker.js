// Lazy-loads MediaPipe face-detection from CDN — no bundler WASM issues.
// Falls back gracefully if network or GPU is unavailable.

const CDN   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

export class FaceTracker {
  constructor() {
    this._det   = null;
    this._ready = false;
    this._lastT = -400;
    /** Latest detection in screen-UV space: { cx, cy, rx, ry } or null */
    this.face   = null;
    /** performance.now() timestamp of the last successful detection */
    this.seenAt = null;
  }

  async init() {
    try {
      // Dynamic CDN import — keeps WASM out of Vite bundle
      const { FaceDetector, FilesetResolver } =
        await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);

      const vision = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      this._det = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
      this._ready = true;
    } catch (e) {
      // No CDN, no GPU driver, old browser — silently degrade
      console.warn('[FaceTracker] unavailable —', e?.message ?? e);
    }
  }

  /**
   * Run detection (throttled ~5 fps). Updates this.face in screen-UV coords.
   * @param {HTMLVideoElement} video
   * @param {number} scrAsp   window.innerWidth / window.innerHeight
   * @param {number} camAsp   video.videoWidth / video.videoHeight
   */
  detect(video, scrAsp, camAsp) {
    if (!this._ready || !video.videoWidth || video.readyState < 2) return;
    const now = performance.now();
    if (now - this._lastT < 200) return;
    this._lastT = now;

    let result;
    try { result = this._det.detectForVideo(video, now); }
    catch { return; }

    if (!result.detections.length) return;

    const bb = result.detections[0].boundingBox;
    const W  = video.videoWidth;
    const H  = video.videoHeight;

    // Face center in video UV — bottom-left origin (matches Three.js texture UVs)
    const fvx    = (bb.originX + bb.width  * 0.5) / W;
    const fvy_bl =  1.0 - (bb.originY + bb.height * 0.5) / H;

    // Padding: generous so hair / neck stay in the clear zone
    const padX = 0.60;
    const padY = 0.72;

    // Invert the shader's cover-fit + mirror to get screen UV coords
    let cx, cy, rx, ry;
    if (scrAsp > camAsp) {
      // Shader stretches video-UV y:  cUV.y = (vUv.y − 0.5)·s + 0.5
      const s = scrAsp / camAsp;
      cx  = 1.0 - fvx;                         // mirror x
      cy  = (fvy_bl - 0.5) / s + 0.5;          // invert y-stretch
      rx  = (bb.width  / W) * padX;
      ry  = (bb.height / H) * padY / s;
    } else {
      // Shader stretches video-UV x:  cUV.x = ((1−vUv.x) − 0.5)·s + 0.5
      const s = camAsp / scrAsp;
      cx  = (0.5 - fvx) / s + 0.5;             // invert x-stretch + mirror
      cy  = fvy_bl;
      rx  = (bb.width  / W) * padX / s;
      ry  = (bb.height / H) * padY;
    }

    this.face   = { cx, cy, rx, ry };
    this.seenAt = performance.now();
  }

  get ready() { return this._ready; }
}
