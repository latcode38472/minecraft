// Lifecycle for client-side entities — today that means arrows in flight.
//
// Mobs and dropped items are simulated elsewhere (the server in multiplayer, a
// local RoomSimulation in singleplayer) and drawn by WorldView, so nothing in
// here has to be authoritative: an arrow is a local effect whose *hits* are
// reported to whoever owns the target.

import * as THREE from 'three';
import { MOB_DESPAWN_DISTANCE } from '../constants';
import { Entity, type EntityContext } from './entity';

export class EntityManager {
  readonly entities: Entity[] = [];
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  add(entity: Entity): void {
    this.entities.push(entity);
    this.scene.add(entity.object);
  }

  private remove(entity: Entity): void {
    const index = this.entities.indexOf(entity);
    if (index === -1) return;
    this.entities.splice(index, 1);
    this.scene.remove(entity.object);
    entity.dispose();
  }

  /** Tick every entity, then retire the dead and the far-away. */
  update(ctx: EntityContext): void {
    for (const entity of this.entities) entity.update(ctx);
    // Iterate backwards: we splice as we go.
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i];
      const far =
        entity.position.distanceToSquared(ctx.playerPos) >
        MOB_DESPAWN_DISTANCE * MOB_DESPAWN_DISTANCE;
      if (entity.dead || far) this.remove(entity);
    }
  }

  clear(): void {
    for (const entity of [...this.entities]) this.remove(entity);
  }
}
