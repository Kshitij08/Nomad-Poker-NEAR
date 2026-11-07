import {
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type WebGLRenderer,
} from 'three';

/**
 * Unity Post Processing v2 "Lens Distortion" (Runtime/Effects/LensDistortion.cs + the Distort()
 * function in Shaders/Builtins/Distortion.hlsl, applied by the Uber pass to the final image).
 * The scene's profile (Test_Profiles/ppv Profile) has intensity 0, X/Y multipliers 1, centre 0,
 * scale 1; the river slam's MMLensDistortionShaker animates `intensity` only. Like PPv2, the effect
 * is skipped entirely while intensity is 0, so normal frames render exactly as before.
 */
export interface LensDistortionSettings {
  intensity: number;
  intensityX: number;
  intensityY: number;
  centerX: number;
  centerY: number;
  scale: number;
}

/** LensDistortionRenderer.Render: the two shader vectors (_Distortion_Amount, _Distortion_CenterScale). */
export function lensDistortionUniforms(s: LensDistortionSettings): { amount: [number, number, number, number]; centerScale: [number, number, number, number] } {
  const amount = 1.6 * Math.max(Math.abs(s.intensity), 1);
  const theta = (Math.PI / 180) * Math.min(160, amount);
  const sigma = 2 * Math.tan(theta * 0.5);
  return {
    centerScale: [s.centerX, s.centerY, Math.max(s.intensityX, 1e-4), Math.max(s.intensityY, 1e-4)],
    amount: [s.intensity >= 0 ? theta : 1 / theta, sigma, 1 / s.scale, s.intensity],
  };
}

/** Distortion.hlsl Distort(uv), on the CPU (for tests / picking). */
export function distortUv(u: number, v: number, s: LensDistortionSettings): [number, number] {
  const { amount: a, centerScale: c } = lensDistortionUniforms(s);
  u = (u - 0.5) * a[2] + 0.5;
  v = (v - 0.5) * a[2] + 0.5;
  const rx = c[2] * (u - 0.5 - c[0]);
  const ry = c[3] * (v - 0.5 - c[1]);
  let ru = Math.max(Math.hypot(rx, ry), 1e-6);
  if (a[3] > 0) ru = Math.tan(ru * a[0]) * (1 / (ru * a[1]));
  else ru = (1 / ru) * a[0] * Math.atan(ru * a[1]);
  return [u + rx * (ru - 1), v + ry * (ru - 1)];
}

export const LensDistortionShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: new Vector4() },
    uCenterScale: { value: new Vector4() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec4 uAmount;       // _Distortion_Amount
    uniform vec4 uCenterScale;  // _Distortion_CenterScale
    varying vec2 vUv;
    vec2 distort(vec2 uv) {
      uv = (uv - 0.5) * uAmount.z + 0.5;
      vec2 ruv = uCenterScale.zw * (uv - 0.5 - uCenterScale.xy);
      float ru = max(length(ruv), 1e-6);
      if (uAmount.w > 0.0) {
        float wu = ru * uAmount.x;
        ru = tan(wu) * (1.0 / (ru * uAmount.y));
        uv = uv + ruv * (ru - 1.0);
      } else {
        ru = (1.0 / ru) * uAmount.x * atan(ru * uAmount.y);
        uv = uv + ruv * (ru - 1.0);
      }
      return uv;
    }
    void main() {
      gl_FragColor = texture2D(tDiffuse, distort(vUv));
      #include <colorspace_fragment>
    }`,
};

/**
 * Renders a scene, through the lens distortion when `intensity` is non-zero. While active the scene
 * goes into a 4x MSAA half-float target and a full-screen pass samples it through Distort() (the
 * target clamps to edge, like Unity's), converting to the renderer's output colour space.
 *
 * main.ts: create one after the renderer, call `lens.render(scene, camera)` instead of
 * `renderer.render(scene, camera)`. Size follows the renderer's drawing buffer automatically.
 */
export class LensDistortionRenderer implements LensDistortionSettings {
  intensity = 0;
  intensityX = 1;
  intensityY = 1;
  centerX = 0;
  centerY = 0;
  scale = 1;

  private target: WebGLRenderTarget | null = null;
  private readonly material = new ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uAmount: { value: new Vector4() },
      uCenterScale: { value: new Vector4() },
    },
    vertexShader: LensDistortionShader.vertexShader,
    fragmentShader: LensDistortionShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new Vector2();

  constructor(private readonly renderer: WebGLRenderer) {
    const quad: Object3D = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** PPv2 LensDistortion.IsEnabledAndSupported. */
  get active(): boolean {
    return Math.abs(this.intensity) > 1e-6 && (this.intensityX > 0 || this.intensityY > 0);
  }

  render(scene: Object3D, camera: Camera): void {
    if (!this.active) {
      this.renderer.render(scene, camera);
      return;
    }
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.floor(this.size.x));
    const h = Math.max(1, Math.floor(this.size.y));
    if (!this.target) this.target = new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 });
    else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    const { amount, centerScale } = lensDistortionUniforms(this);
    const u = this.material.uniforms;
    (u.uAmount.value as Vector4).fromArray(amount);
    (u.uCenterScale.value as Vector4).fromArray(centerScale);
    u.tDiffuse.value = this.target.texture;

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(prev);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}
