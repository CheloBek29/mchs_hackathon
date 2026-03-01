import { PerspectiveCamera } from 'three';

export function createMainCamera(width: number, height: number): PerspectiveCamera {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const camera = new PerspectiveCamera(60, aspect, 0.1, 1000);
  camera.position.set(30, 24, 30);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function resizeCamera(camera: PerspectiveCamera, width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
