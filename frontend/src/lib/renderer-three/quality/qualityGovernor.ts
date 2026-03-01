import { getHigherQuality, getLowerQuality, type QualityLevel } from './qualityProfiles.js';
import type { FrameMetrics } from '../runtime/frameMonitor.js';

export interface QualityGovernorOptions {
  lowFpsThreshold?: number;
  highFpsThreshold?: number;
  lowFramesToDowngrade?: number;
  highFramesToUpgrade?: number;
}

export class QualityGovernor {
  private lowFpsStreak = 0;
  private highFpsStreak = 0;

  private readonly lowFpsThreshold: number;
  private readonly highFpsThreshold: number;
  private readonly lowFramesToDowngrade: number;
  private readonly highFramesToUpgrade: number;

  constructor(options: QualityGovernorOptions = {}) {
    this.lowFpsThreshold = options.lowFpsThreshold ?? 25;
    this.highFpsThreshold = options.highFpsThreshold ?? 52;
    this.lowFramesToDowngrade = options.lowFramesToDowngrade ?? 100;
    this.highFramesToUpgrade = options.highFramesToUpgrade ?? 240;
  }

  public evaluate(currentQuality: QualityLevel, metrics: FrameMetrics): QualityLevel | null {
    if (metrics.averageFps < this.lowFpsThreshold) {
      this.lowFpsStreak += 1;
      this.highFpsStreak = 0;
    } else if (metrics.averageFps > this.highFpsThreshold) {
      this.highFpsStreak += 1;
      this.lowFpsStreak = 0;
    } else {
      this.lowFpsStreak = 0;
      this.highFpsStreak = 0;
      return null;
    }

    if (this.lowFpsStreak >= this.lowFramesToDowngrade) {
      this.lowFpsStreak = 0;
      return getLowerQuality(currentQuality);
    }

    if (this.highFpsStreak >= this.highFramesToUpgrade) {
      this.highFpsStreak = 0;
      return getHigherQuality(currentQuality);
    }

    return null;
  }
}
