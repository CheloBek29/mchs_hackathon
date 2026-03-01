import {
  Color,
  DoubleSide,
  Fog,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from 'three';

export interface SceneEnvironment {
  ground: Mesh;
  grid: GridHelper;
  fog: Fog;
}

export function setupEnvironment(scene: Scene, size = 200): SceneEnvironment {
  const skyColor = new Color(0x9cbad6);
  scene.background = skyColor;

  const fog = new Fog(skyColor, 35, 220);
  scene.fog = fog;

  const groundGeometry = new PlaneGeometry(size, size);
  const groundMaterial = new MeshStandardMaterial({
    color: 0x5f6e5a,
    roughness: 0.95,
    metalness: 0.02,
    side: DoubleSide,
  });

  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.51;
  ground.receiveShadow = true;

  const grid = new GridHelper(size, Math.floor(size / 2), 0x1a1a1a, 0x4c4c4c);
  grid.position.y = -0.5;

  scene.add(ground);
  scene.add(grid);

  return { ground, grid, fog };
}
