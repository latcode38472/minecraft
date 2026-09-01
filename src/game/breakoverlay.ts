// The cracks that spread across a block as you mine it.
//
// One slightly-inflated cube sits on the targeted block with a crack texture
// chosen from mining progress. Ten stage geometries are built once and swapped
// between, so advancing a stage costs a pointer assignment rather than a
// buffer upload — which matters on a phone, where this runs every frame you
// hold the mine button.

import * as THREE from 'three';
import { CRACK_STAGES, CRACK_TILE_0, crackTileFor, getAtlasTexture, tileUVRect } from '../textures';

/** Grown slightly so the overlay sits proud of the block's own faces. */
const INFLATE = 1.006;

const stageGeometries = new Map<number, THREE.BufferGeometry>();

function stageGeometry(tile: number): THREE.BufferGeometry {
  let geo = stageGeometries.get(tile);
  if (!geo) {
    geo = new THREE.BoxGeometry(INFLATE, INFLATE, INFLATE);
    // Remap every face's [0,1] UVs onto this crack tile.
    const [u0, v0, u1, v1] = tileUVRect(tile);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    }
    uv.needsUpdate = true;
    stageGeometries.set(tile, geo);
  }
  return geo;
}

export class BreakOverlay {
  /** Public for inspection in tests; treat both as read-only. */
  readonly mesh: THREE.Mesh;
  currentTile = -1;

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Mesh(
      stageGeometry(CRACK_TILE_0),
      new THREE.MeshBasicMaterial({
        map: getAtlasTexture(),
        transparent: true,
        // Blend into the block rather than painting over it, so cracks read as
        // damage to the surface instead of a decal floating in front of it.
        blending: THREE.NormalBlending,
        depthWrite: false,
        // Belt and braces with INFLATE: stops z-fighting on distant blocks
        // where depth precision is thin.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      }),
    );
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /** Show cracks on a block. `progress` is the same 0..1 the HUD bar uses. */
  show(x: number, y: number, z: number, progress: number): void {
    const tile = crackTileFor(progress);
    if (tile !== this.currentTile) {
      this.currentTile = tile;
      this.mesh.geometry = stageGeometry(tile);
    }
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
    this.currentTile = -1;
  }

  dispose(): void {
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Exposed for tests: how many stages the overlay steps through. */
export const BREAK_STAGES = CRACK_STAGES;
