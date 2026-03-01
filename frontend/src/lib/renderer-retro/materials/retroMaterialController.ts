import type { IUniform, Material, Scene } from 'three';
import type { RetroQualityProfile } from '../types.js';

interface PatchedMaterialEntry {
  originalOnBeforeCompile: Material['onBeforeCompile'];
  uniform: IUniform<number> | null;
}

type ShaderWithUniforms = {
  uniforms: Record<string, IUniform<unknown>>;
  vertexShader: string;
};

function toMaterialList(materialValue: unknown): Material[] {
  if (Array.isArray(materialValue)) {
    return materialValue.filter((material): material is Material => material != null);
  }
  if (materialValue && typeof materialValue === 'object') {
    return [materialValue as Material];
  }
  return [];
}

export class RetroMaterialController {
  private profile: RetroQualityProfile;
  private readonly entries = new WeakMap<Material, PatchedMaterialEntry>();
  private readonly trackedMaterials = new Set<Material>();

  constructor(profile: RetroQualityProfile) {
    this.profile = profile;
  }

  public setQuality(profile: RetroQualityProfile): void {
    this.profile = profile;
    this.syncUniforms();
  }

  public applyToScene(scene: Scene): void {
    scene.traverse((object) => {
      const materials = toMaterialList((object as { material?: unknown }).material);
      for (const material of materials) {
        this.patchMaterial(material);
      }
    });
    this.syncUniforms();
  }

  private patchMaterial(material: Material): void {
    if (this.entries.has(material)) {
      return;
    }

    const entry: PatchedMaterialEntry = {
      originalOnBeforeCompile: material.onBeforeCompile,
      uniform: null,
    };

    material.onBeforeCompile = (shader, renderer) => {
      entry.originalOnBeforeCompile(shader, renderer);
      const shaderWithUniforms = shader as ShaderWithUniforms;
      this.injectRetroVertexSnap(shaderWithUniforms);
      const uniform = shaderWithUniforms.uniforms.uRetroResolution as IUniform<number>;
      uniform.value = this.profile.vertexSnapResolution;
      entry.uniform = uniform;
    };

    this.entries.set(material, entry);
    this.trackedMaterials.add(material);
    material.needsUpdate = true;
  }

  private injectRetroVertexSnap(shader: ShaderWithUniforms): void {
    if (shader.vertexShader.includes('uRetroResolution')) {
      return;
    }

    shader.uniforms.uRetroResolution = { value: this.profile.vertexSnapResolution };
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `
      #include <common>
      uniform float uRetroResolution;
      `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      #include <project_vertex>
      if (uRetroResolution > 0.0) {
        vec4 snappedPosition = gl_Position;
        snappedPosition.xyz = snappedPosition.xyz / snappedPosition.w;
        snappedPosition.xy = floor(snappedPosition.xy * uRetroResolution) / uRetroResolution;
        snappedPosition.xyz *= snappedPosition.w;
        gl_Position = snappedPosition;
      }
      `,
    );
  }

  private syncUniforms(): void {
    for (const material of this.trackedMaterials) {
      const entry = this.entries.get(material);
      if (!entry || !entry.uniform) {
        continue;
      }
      entry.uniform.value = this.profile.vertexSnapResolution;
    }
  }
}
