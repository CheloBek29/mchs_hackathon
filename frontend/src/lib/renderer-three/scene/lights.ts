import { AmbientLight, DirectionalLight, HemisphereLight, Scene } from 'three';

export interface SceneLights {
  ambient: AmbientLight;
  directional: DirectionalLight;
  hemisphere: HemisphereLight;
}

export function setupBasicLights(scene: Scene): SceneLights {
  const hemisphere = new HemisphereLight(0xbfd9ff, 0x3c4a33, 0.55);
  const ambient = new AmbientLight(0xffffff, 0.45);

  const directional = new DirectionalLight(0xffffff, 0.9);
  directional.position.set(40, 60, 20);
  directional.castShadow = true;
  directional.shadow.mapSize.set(1024, 1024);

  scene.add(hemisphere);
  scene.add(ambient);
  scene.add(directional);

  return { ambient, directional, hemisphere };
}
