import { Clock, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setupEnvironment } from '../../renderer-three/scene/environment.js';
import { setupBasicLights } from '../../renderer-three/scene/lights.js';
import { createMainCamera, resizeCamera } from '../../renderer-three/scene/camera.js';
import { VoxelLayer } from '../../renderer-three/scene/voxelLayer.js';
import { FireLayer } from '../../renderer-three/layers/fireLayer.js';
import { SmokeLayer } from '../../renderer-three/layers/smokeLayer.js';
import { WaterLayer } from '../../renderer-three/layers/waterLayer.js';
import { WeatherController } from '../../renderer-three/weather/weatherController.js';
import type { RenderVoxel, RenderWeather, RenderWaterSource } from '../../renderer-three/types.js';
import { QUALITY_PROFILES } from '../../renderer-three/quality/qualityProfiles.js';
import type { RetroQualityLevel, RetroRendererOptions } from '../types.js';
import { RetroPipeline } from './RetroPipeline.js';
import { RetroMaterialController } from '../materials/retroMaterialController.js';
import type { RetroEmitter, RetroRenderSnapshot } from '../types.js';
import { RetroVehicleLayer } from '../layers/RetroVehicleLayer.js';
import { RetroWaterJetLayer } from '../layers/RetroWaterJetLayer.js';

const DEFAULT_OPTIONS = {
  antialias: false,
  backgroundColor: 0x000000,
  gridSize: 220,
} satisfies Pick<RetroRendererOptions, 'antialias' | 'backgroundColor' | 'gridSize'>;

export class RetroSimRenderer {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly voxelLayer: VoxelLayer;
  private readonly fireLayer: FireLayer;
  private readonly smokeLayer: SmokeLayer;
  private readonly waterLayer: WaterLayer;
  private readonly vehicleLayer: RetroVehicleLayer;
  private readonly waterJetLayer: RetroWaterJetLayer;
  private readonly weatherController: WeatherController;
  private readonly pipeline: RetroPipeline;
  private readonly materialController: RetroMaterialController;
  private readonly clock = new Clock();

  private readonly container: HTMLElement;
  private frameId: number | null = null;

  constructor(container: HTMLElement, options: RetroRendererOptions = {}) {
    this.container = container;
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const initialQuality = options.initialQuality ?? 'balanced';

    const width = this.getSafeWidth();
    const height = this.getSafeHeight();

    this.scene = new Scene();
    this.scene.background = null;

    this.camera = createMainCamera(width, height);
    this.renderer = new WebGLRenderer({
      antialias: merged.antialias,
      alpha: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(merged.backgroundColor);
    this.renderer.domElement.style.imageRendering = 'pixelated';
    this.renderer.shadowMap.enabled = false;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.target.set(0, 0, 0);

    const lights = setupBasicLights(this.scene);
    const environment = setupEnvironment(this.scene, merged.gridSize);
    this.voxelLayer = new VoxelLayer(this.scene);
    this.fireLayer = new FireLayer(this.scene, 8000);
    this.smokeLayer = new SmokeLayer(this.scene, 9000);
    this.waterLayer = new WaterLayer(this.scene, 7000);
    this.vehicleLayer = new RetroVehicleLayer(this.scene, 300);
    this.waterJetLayer = new RetroWaterJetLayer(this.scene, 2400);
    this.weatherController = new WeatherController(this.scene, lights, environment);
    this.applyEffectQuality(initialQuality);

    this.pipeline = new RetroPipeline(this.renderer, this.scene, this.camera, initialQuality);
    this.pipeline.resize(width, height);

    this.materialController = new RetroMaterialController(this.pipeline.getCurrentProfile());
    this.materialController.applyToScene(this.scene);

    window.addEventListener('resize', this.handleResize);
    this.renderOnce();
  }

  public setSnapshot(snapshot: RetroRenderSnapshot): void {
    const compiled = this.compileRetroSnapshot(snapshot);
    this.voxelLayer.setVoxels(compiled.voxels);
    this.fireLayer.setSources(compiled.fireSources);
    this.smokeLayer.setSources(compiled.smokeSources);
    this.vehicleLayer.setVehicles(snapshot.dynamicState.vehicles);
    this.waterJetLayer.setJets(snapshot.dynamicState.waterJets);
    this.waterLayer.emitFromSources(compiled.splashSources);
    this.setWeather(compiled.weather);
    this.materialController.applyToScene(this.scene);
  }

  public setWeather(weather: RenderWeather): void {
    this.weatherController.apply(weather);
    this.smokeLayer.setWeather(
      weather.windSpeedMs,
      weather.windDirectionDeg,
      weather.humidityPct,
    );
    this.waterLayer.setWeather(weather.windSpeedMs, weather.windDirectionDeg);
  }

  public setQuality(quality: RetroQualityLevel): void {
    const width = this.getSafeWidth();
    const height = this.getSafeHeight();
    this.pipeline.setQuality(quality, width / Math.max(1, height));
    this.materialController.setQuality(this.pipeline.getCurrentProfile());
    this.applyEffectQuality(quality);
    this.materialController.applyToScene(this.scene);
  }

  public getQuality(): RetroQualityLevel {
    return this.pipeline.getQuality();
  }

  public start(): void {
    if (this.frameId !== null) {
      return;
    }

    const loop = () => {
      this.frameId = requestAnimationFrame(loop);
      const delta = this.clock.getDelta();
      const elapsed = this.clock.elapsedTime;
      this.fireLayer.tick(elapsed);
      this.smokeLayer.tick(delta);
      this.waterLayer.tick(delta);
      this.waterJetLayer.tick(delta);
      this.controls.update();
      this.pipeline.render(delta);
    };

    loop();
  }

  public stop(): void {
    if (this.frameId === null) {
      return;
    }
    cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  public renderOnce(): void {
    this.controls.update();
    this.pipeline.render(0);
  }

  public dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);

    this.controls.dispose();
    this.voxelLayer.dispose();
    this.fireLayer.dispose();
    this.smokeLayer.dispose();
    this.waterLayer.dispose();
    this.vehicleLayer.dispose();
    this.waterJetLayer.dispose();
    this.weatherController.dispose();
    this.pipeline.dispose();

    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  private readonly handleResize = () => {
    const width = this.getSafeWidth();
    const height = this.getSafeHeight();
    resizeCamera(this.camera, width, height);
    this.renderer.setSize(width, height);
    this.pipeline.resize(width, height);
    this.materialController.setQuality(this.pipeline.getCurrentProfile());
    this.materialController.applyToScene(this.scene);
  };

  private getSafeWidth(): number {
    return Math.max(1, this.container.clientWidth || window.innerWidth || 1);
  }

  private getSafeHeight(): number {
    return Math.max(1, this.container.clientHeight || window.innerHeight || 1);
  }

  private applyEffectQuality(quality: RetroQualityLevel): void {
    const mappedProfile = quality === 'authentic'
      ? QUALITY_PROFILES.low
      : quality === 'balanced'
        ? QUALITY_PROFILES.medium
        : QUALITY_PROFILES.high;

    this.fireLayer.setQuality(mappedProfile);
    this.smokeLayer.setQuality(mappedProfile);
    this.waterLayer.setQuality(mappedProfile);
  }

  private compileRetroSnapshot(snapshot: RetroRenderSnapshot): {
    voxels: RenderVoxel[];
    fireSources: RenderVoxel[];
    smokeSources: RenderVoxel[];
    splashSources: RenderWaterSource[];
    weather: RenderWeather;
  } {
    const burnMask = new Set<string>();
    for (const cell of snapshot.dynamicState.burnCells) {
      if (cell.state === 'burning' || cell.state === 'charred') {
        burnMask.add(this.voxelKey(cell.x, cell.y, cell.z));
      }
    }

    const staticVoxels = snapshot.staticScene.voxels.filter(
      (voxel) => !burnMask.has(this.voxelKey(voxel.x, voxel.y, voxel.z)),
    );

    const charredVoxels = snapshot.dynamicState.burnCells
      .filter((cell) => cell.state === 'charred')
      .map((cell) => ({
        x: cell.x,
        y: cell.y,
        z: cell.z,
        materialType: 'CHARRED',
        isBurning: false,
        temperature: Math.max(80, cell.temperature),
      } satisfies RenderVoxel));

    const voxelMap = new Map<string, RenderVoxel>();
    for (const voxel of staticVoxels) {
      voxelMap.set(this.voxelKey(voxel.x, voxel.y, voxel.z), voxel);
    }
    for (const voxel of charredVoxels) {
      voxelMap.set(this.voxelKey(voxel.x, voxel.y, voxel.z), voxel);
    }
    for (const voxel of snapshot.dynamicState.burningVoxels) {
      voxelMap.set(this.voxelKey(voxel.x, voxel.y, voxel.z), voxel);
    }

    const fireSources = this.emittersToVoxels(snapshot.dynamicState.fireEmitters, 900);
    const smokeSources = this.emittersToVoxels(snapshot.dynamicState.smokeEmitters, 550);
    const splashSources = snapshot.dynamicState.waterJets.map((jet) => ({
      x: jet.targetX,
      y: jet.targetY,
      z: jet.targetZ,
      radiusM: Math.max(1.4, jet.radiusM * 0.22),
      flowRateLs: Math.max(0.8, jet.flowRateLs * 0.45),
    }));

    return {
      voxels: Array.from(voxelMap.values()),
      fireSources: fireSources.length > 0 ? fireSources : snapshot.dynamicState.burningVoxels,
      smokeSources: smokeSources.length > 0 ? smokeSources : snapshot.dynamicState.burningVoxels,
      splashSources,
      weather: snapshot.weather,
    };
  }

  private emittersToVoxels(emitters: RetroEmitter[], temperatureBase: number): RenderVoxel[] {
    const voxels: RenderVoxel[] = [];
    for (const emitter of emitters) {
      const seedBase = this.hashSeed(emitter.id);
      const clusterCount = Math.max(1, Math.min(6, Math.round(Math.sqrt(Math.max(1, emitter.areaM2)) * 0.6)));
      const spread = Math.max(0.35, Math.min(2.4, Math.sqrt(Math.max(1, emitter.areaM2)) * 0.28));
      const temperature = Math.max(120, Math.round(temperatureBase * Math.max(0.25, emitter.intensity)));

      for (let index = 0; index < clusterCount; index += 1) {
        const px = this.pseudoRandom(seedBase + index * 13.1) - 0.5;
        const py = this.pseudoRandom(seedBase + index * 27.7) - 0.5;
        voxels.push({
          x: emitter.x + px * spread,
          y: emitter.y + py * spread,
          z: emitter.z,
          materialType: 'WOOD',
          isBurning: true,
          temperature,
        });
      }
    }
    return voxels;
  }

  private pseudoRandom(seed: number): number {
    const raw = Math.sin(seed * 12.9898) * 43758.5453;
    return raw - Math.floor(raw);
  }

  private hashSeed(input: string): number {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) | 0;
    }
    return hash;
  }

  private voxelKey(x: number, y: number, z: number): string {
    return `${Math.round(x * 10)}:${Math.round(y * 10)}:${Math.round(z * 10)}`;
  }
}
