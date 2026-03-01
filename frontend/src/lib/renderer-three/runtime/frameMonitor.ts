export interface FrameMetrics {
  fps: number;
  averageFps: number;
  frameMs: number;
}

export class FrameMonitor {
  private samples: number[] = [];
  private readonly maxSamples: number;
  private averageFps = 60;

  constructor(maxSamples = 90) {
    this.maxSamples = maxSamples;
  }

  public update(deltaSec: number): FrameMetrics {
    const frameMs = Math.max(deltaSec, 1e-4) * 1000;
    const fps = 1000 / frameMs;

    this.samples.push(fps);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }

    const total = this.samples.reduce((acc, v) => acc + v, 0);
    this.averageFps = total / this.samples.length;

    return {
      fps,
      averageFps: this.averageFps,
      frameMs,
    };
  }

  public getAverageFps(): number {
    return this.averageFps;
  }
}
