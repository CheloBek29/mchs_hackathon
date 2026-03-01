import { ArrowHelper, Color, Scene, Vector3 } from 'three';
import type { SceneEnvironment } from '../scene/environment.js';
import type { SceneLights } from '../scene/lights.js';
import type { RenderWeather } from '../types.js';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export class WeatherController {
  private readonly scene: Scene;
  private readonly lights: SceneLights;
  private readonly environment: SceneEnvironment;
  private readonly windArrow: ArrowHelper;

  constructor(
    scene: Scene,
    lights: SceneLights,
    environment: SceneEnvironment,
  ) {
    this.scene = scene;
    this.lights = lights;
    this.environment = environment;
    this.windArrow = new ArrowHelper(new Vector3(1, 0, 0), new Vector3(0, 2, 0), 6, 0x2148a6);
    this.scene.add(this.windArrow);
  }

  public apply(weather: RenderWeather): void {
    const directionRad = (weather.windDirectionDeg * Math.PI) / 180;
    const direction = new Vector3(Math.cos(directionRad), 0, Math.sin(directionRad)).normalize();

    const length = clamp(4 + weather.windSpeedMs * 1.4, 4, 30);
    this.windArrow.setDirection(direction);
    this.windArrow.setLength(length, length * 0.25, length * 0.15);

    const humidityNorm = clamp(weather.humidityPct / 100, 0, 1);
    const fogFar = clamp(220 - humidityNorm * 80 - weather.windSpeedMs * 2, 70, 220);
    const fogNear = clamp(25 + humidityNorm * 12, 15, 80);

    this.environment.fog.far = fogFar;
    this.environment.fog.near = fogNear;

    const tempNorm = clamp((weather.ambientTempC - 20) / 25, -1, 1);
    const sky = new Color().setHSL(0.58 - tempNorm * 0.04, 0.42, 0.62 - humidityNorm * 0.08);

    this.scene.background = sky;
    this.environment.fog.color = sky;

    this.lights.ambient.intensity = 0.35 + (1 - humidityNorm) * 0.2;
    this.lights.directional.intensity = 0.72 + (1 - humidityNorm) * 0.3;
    this.lights.hemisphere.intensity = 0.48 + humidityNorm * 0.2;
  }

  public dispose(): void {
    this.windArrow.removeFromParent();
  }
}
