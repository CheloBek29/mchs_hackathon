import {
  HalfFloatType,
  NearestFilter,
  PerspectiveCamera,
  RGBAFormat,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RetroPostShader } from '../postfx/retroPostShader.js';
import type { RetroQualityLevel, RetroQualityProfile } from '../types.js';
import { RETRO_QUALITY_PROFILES } from '../types.js';

export class RetroPipeline {
  private readonly composer: EffectComposer;
  private readonly renderTarget: WebGLRenderTarget;
  private readonly postPass: ShaderPass;
  private quality: RetroQualityLevel;
  private profile: RetroQualityProfile;
  private elapsedSec = 0;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    initialQuality: RetroQualityLevel,
  ) {
    this.quality = initialQuality;
    this.profile = RETRO_QUALITY_PROFILES[initialQuality];

    this.renderTarget = new WebGLRenderTarget(2, 2, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.composer = new EffectComposer(renderer, this.renderTarget);
    this.composer.setPixelRatio(1);
    this.composer.addPass(new RenderPass(scene, camera));

    this.postPass = new ShaderPass(RetroPostShader);
    this.composer.addPass(this.postPass);
  }

  public getCurrentProfile(): RetroQualityProfile {
    return this.profile;
  }

  public getQuality(): RetroQualityLevel {
    return this.quality;
  }

  public setQuality(quality: RetroQualityLevel, viewportAspect: number): void {
    this.quality = quality;
    this.profile = RETRO_QUALITY_PROFILES[quality];
    this.postPass.uniforms.uColorLevels.value = this.profile.colorLevels;
    this.postPass.uniforms.uDitherStrength.value = this.profile.ditherStrength;
    this.applyResolution(viewportAspect);
  }

  public resize(width: number, height: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    this.applyResolution(safeWidth / safeHeight);
  }

  public render(deltaSec: number): void {
    this.elapsedSec += Math.max(0, deltaSec);
    this.postPass.uniforms.uTime.value = this.elapsedSec;
    this.composer.render();
  }

  public dispose(): void {
    this.composer.dispose();
    this.postPass.dispose();
    this.renderTarget.dispose();
  }

  private applyResolution(viewportAspect: number): void {
    const safeAspect = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 16 / 9;
    const targetHeight = this.profile.internalHeight;
    const targetWidth = Math.max(1, Math.round(targetHeight * safeAspect));
    this.composer.setSize(targetWidth, targetHeight);
  }
}

