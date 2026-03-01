import type { RenderWeather } from '../types.js';
import type { QualityProfile } from '../quality/qualityProfiles.js';
import { ParticleField } from '../particles/particleField.js';
import { Scene } from 'three';

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export class EnvironmentEffects {
  private readonly dust: ParticleField;
  private readonly mist: ParticleField;

  private windX = 0;
  private windZ = 0;

  constructor(scene: Scene) {
    this.dust = new ParticleField(scene, {
      capacity: 4200,
      areaWidth: 220,
      areaDepth: 220,
      minHeight: 0.2,
      maxHeight: 18,
      speedMin: 0.8,
      speedMax: 2.6,
      size: 0.16,
      color: 0xb8b2a1,
      opacity: 0.2,
    });

    this.mist = new ParticleField(scene, {
      capacity: 4200,
      areaWidth: 220,
      areaDepth: 220,
      minHeight: 0.2,
      maxHeight: 28,
      speedMin: 0.4,
      speedMax: 1.7,
      size: 0.21,
      color: 0x9db0c2,
      opacity: 0.13,
    });
  }

  public setQuality(profile: QualityProfile): void {
    // Rough split: 65% dust, 35% mist
    const dustCount = Math.floor(profile.particleCount * 0.65);
    const mistCount = Math.floor(profile.particleCount * 0.35);

    this.dust.setActiveCount(dustCount);
    this.mist.setActiveCount(mistCount);
  }

  public setWeather(weather: RenderWeather): void {
    const rad = (weather.windDirectionDeg * Math.PI) / 180;
    this.windX = Math.cos(rad) * weather.windSpeedMs;
    this.windZ = Math.sin(rad) * weather.windSpeedMs;

    const humidity = clamp(weather.humidityPct / 100, 0, 1);
    const windNorm = clamp(weather.windSpeedMs / 20, 0, 1);

    this.dust.setWindDirection(this.windX, this.windZ);
    this.mist.setWindDirection(this.windX * 0.65, this.windZ * 0.65);

    // Сухо + ветрено = больше пыли; влажно = больше дымки
    this.dust.setOpacity(clamp(0.08 + (1 - humidity) * 0.24 + windNorm * 0.12, 0.06, 0.42));
    this.mist.setOpacity(clamp(0.06 + humidity * 0.24, 0.05, 0.34));

    this.dust.setPointSize(clamp(0.1 + windNorm * 0.18, 0.1, 0.3));
    this.mist.setPointSize(clamp(0.16 + humidity * 0.2, 0.12, 0.4));
  }

  public tick(deltaSec: number): void {
    this.dust.tick(deltaSec);
    this.mist.tick(deltaSec);
  }

  public dispose(): void {
    this.dust.dispose();
    this.mist.dispose();
  }
}
