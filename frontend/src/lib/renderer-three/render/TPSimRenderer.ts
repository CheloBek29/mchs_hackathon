import {
  Clock,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setupEnvironment } from '../scene/environment.js';
import { setupBasicLights } from '../scene/lights.js';
import { createMainCamera, resizeCamera } from '../scene/camera.js';
import { VoxelLayer } from '../scene/voxelLayer.js';
import { WeatherController } from '../weather/weatherController.js';
import type { RendererOptions, RenderSnapshot, RenderWeather } from '../types.js';
import { FireLayer } from '../layers/fireLayer.js';
import { SmokeLayer } from '../layers/smokeLayer.js';
import { WaterLayer } from '../layers/waterLayer.js';
import {
  QUALITY_PROFILES,
  type QualityLevel,
  type QualityProfile,
} from '../quality/qualityProfiles.js';
import { FrameMonitor } from '../runtime/frameMonitor.js';
import { QualityGovernor } from '../quality/qualityGovernor.js';
import { EnvironmentEffects } from '../effects/environmentEffects.js';

export type RendererEvent =
  | { type: 'QUALITY_CHANGED'; payload: { previous: QualityLevel; current: QualityLevel; reason: string } }
  | { type: 'RENDER_RUNTIME_ERROR'; payload: { message: string; recoverable: boolean } };

type RendererEventHandler = (event: RendererEvent) => void;

const DEFAULT_OPTIONS = {
  antialias: true,
  shadowMap: true,
  pixelRatioCap: 2,
  backgroundColor: 0x9cbad6,
  gridSize: 200,
} satisfies Pick<RendererOptions, 'antialias' | 'shadowMap' | 'pixelRatioCap' | 'backgroundColor' | 'gridSize'>;

export class TPSimRenderer {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly voxelLayer: VoxelLayer;
  private readonly fireLayer: FireLayer;
  private readonly smokeLayer: SmokeLayer;
  private readonly waterLayer: WaterLayer;
  private readonly weatherController: WeatherController;
  private readonly effects: EnvironmentEffects;
  private readonly clock = new Clock();
  private readonly frameMonitor = new FrameMonitor(90);
  private readonly qualityGovernor = new QualityGovernor();
  private readonly listeners: Set<RendererEventHandler> = new Set();

  private container!: HTMLElement;
  private frameId: number | null = null;
  private qualityLevel: QualityLevel = 'high';
  private qualityProfile: QualityProfile = QUALITY_PROFILES.high;
  private autoQualityEnabled = true;

  constructor(container: HTMLElement, options: RendererOptions = {}) {
    this.container = container;
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const initialQuality = options.initialQuality ?? 'high';
    this.qualityLevel = initialQuality;
    this.qualityProfile = QUALITY_PROFILES[initialQuality];
    this.autoQualityEnabled = options.autoQuality ?? true;

    this.scene = new Scene();
    this.scene.background = null;

    const width = this.getSafeWidth();
    const height = this.getSafeHeight();

    this.camera = createMainCamera(width, height);
    this.renderer = new WebGLRenderer({ antialias: merged.antialias, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, merged.pixelRatioCap));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(merged.backgroundColor);

    if (merged.shadowMap) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = PCFSoftShadowMap;
    }

    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);

    const lights = setupBasicLights(this.scene);
    const environment = setupEnvironment(this.scene, merged.gridSize);
    this.voxelLayer = new VoxelLayer(this.scene);
    this.fireLayer = new FireLayer(this.scene);
    this.smokeLayer = new SmokeLayer(this.scene);
    this.waterLayer = new WaterLayer(this.scene);
    this.weatherController = new WeatherController(this.scene, lights, environment);
    this.effects = new EnvironmentEffects(this.scene);

    this.applyQualityProfile(this.qualityProfile);

    window.addEventListener('resize', this.handleResize);
    this.renderOnce();
  }

  public getCamera(): PerspectiveCamera {
    return this.camera;
  }

  public getScene(): Scene {
    return this.scene;
  }

  public setSnapshot(snapshot: RenderSnapshot): void {
    this.voxelLayer.setVoxels(snapshot.voxels);
    this.fireLayer.setSources(snapshot.voxels);
    this.smokeLayer.setSources(snapshot.voxels);
    this.waterLayer.emitFromSources(snapshot.waterSources ?? []);
    this.setWeather(snapshot.weather);
  }

  public setWeather(weather: RenderWeather): void {
    this.weatherController.apply(weather);
    this.smokeLayer.setWeather(
      weather.windSpeedMs,
      weather.windDirectionDeg,
      weather.humidityPct,
    );
    this.waterLayer.setWeather(weather.windSpeedMs, weather.windDirectionDeg);
    this.effects.setWeather(weather);
  }

  public renderOnce(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  public start(): void {
    if (this.frameId !== null) return;

    const loop = () => {
      this.frameId = requestAnimationFrame(loop);
      try {
        const dt = this.clock.getDelta();
        const t = this.clock.elapsedTime;
        this.fireLayer.tick(t);
        this.smokeLayer.tick(dt);
        this.waterLayer.tick(dt);
        this.effects.tick(dt);
        this.controls.update();
        this.renderer.render(this.scene, this.camera);

        const metrics = this.frameMonitor.update(dt);
        if (this.autoQualityEnabled) {
          const nextQuality = this.qualityGovernor.evaluate(this.qualityLevel, metrics);
          if (nextQuality && nextQuality !== this.qualityLevel) {
            this.setQuality(nextQuality, 'AUTO_FPS_GOVERNOR');
          }
        }
      } catch (error) {
        this.emit({
          type: 'RENDER_RUNTIME_ERROR',
          payload: {
            message: error instanceof Error ? error.message : 'Unknown renderer runtime error',
            recoverable: true,
          },
        });
      }
    };

    loop();
  }

  public stop(): void {
    if (this.frameId === null) return;
    cancelAnimationFrame(this.frameId);
    this.frameId = null;
  }

  public dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);

    this.controls.dispose();
    this.voxelLayer.dispose();
    this.fireLayer.dispose();
    this.smokeLayer.dispose();
    this.waterLayer.dispose();
    this.weatherController.dispose();
    this.effects.dispose();

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
    this.renderer.render(this.scene, this.camera);
  };

  private getSafeWidth(): number {
    return Math.max(1, this.container.clientWidth || window.innerWidth || 1);
  }

  private getSafeHeight(): number {
    return Math.max(1, this.container.clientHeight || window.innerHeight || 1);
  }

  public setQuality(level: QualityLevel, reason = 'MANUAL'): void {
    const profile = QUALITY_PROFILES[level];
    if (!profile) return;
    const previous = this.qualityLevel;
    this.qualityLevel = level;
    this.qualityProfile = profile;
    this.applyQualityProfile(profile);

    if (previous !== level) {
      this.emit({
        type: 'QUALITY_CHANGED',
        payload: { previous, current: level, reason },
      });
    }
  }

  public getQuality(): QualityLevel {
    return this.qualityLevel;
  }

  public setAutoQuality(enabled: boolean): void {
    this.autoQualityEnabled = enabled;
  }

  public on(handler: RendererEventHandler): void {
    this.listeners.add(handler);
  }

  public off(handler: RendererEventHandler): void {
    this.listeners.delete(handler);
  }

  public getPerformanceSnapshot(): {
    quality: QualityLevel;
    averageFps: number;
    drawCalls: number;
    triangles: number;
    points: number;
    lines: number;
    geometries: number;
    textures: number;
  } {
    const renderInfo = this.renderer.info.render;
    const memoryInfo = this.renderer.info.memory;

    return {
      quality: this.qualityLevel,
      averageFps: this.frameMonitor.getAverageFps(),
      drawCalls: renderInfo.calls,
      triangles: renderInfo.triangles,
      points: renderInfo.points,
      lines: renderInfo.lines,
      geometries: memoryInfo.geometries,
      textures: memoryInfo.textures,
    };
  }

  private applyQualityProfile(profile: QualityProfile): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.pixelRatioCap));

    this.renderer.shadowMap.enabled = profile.shadowsEnabled;

    this.voxelLayer.setRenderBudget(profile.voxelSamplingStep, profile.voxelMaxCount);
    this.fireLayer.setQuality(profile);
    this.smokeLayer.setQuality(profile);
    this.waterLayer.setQuality(profile);
    this.effects.setQuality(profile);
  }

  private emit(event: RendererEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors to keep render loop stable.
      }
    }
  }
}
