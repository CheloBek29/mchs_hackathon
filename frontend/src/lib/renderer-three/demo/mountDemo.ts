import { TPSimRenderer } from '../render/TPSimRenderer.js';
import { createSampleSnapshot } from './sampleSnapshot.js';

export function mountRendererDemo(container: HTMLElement): TPSimRenderer {
  const renderer = new TPSimRenderer(container);
  renderer.setSnapshot(createSampleSnapshot());
  renderer.start();
  return renderer;
}
