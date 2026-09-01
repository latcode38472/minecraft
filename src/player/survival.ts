// Health, hunger, damage and death.
//
// Hunger drains with time and distance walked. Above REGEN_HUNGER_THRESHOLD it
// slowly buys back health; at zero it starts costing health instead.

import * as THREE from 'three';
import {
  BLOCK_DAMAGE_REDUCTION,
  FALL_DAMAGE_THRESHOLD,
  HUNGER_DRAIN_PER_BLOCK,
  HUNGER_DRAIN_PER_S,
  HURT_INVULN_S,
  MAX_HEALTH,
  MAX_HUNGER,
  REGEN_HUNGER_COST,
  REGEN_HUNGER_THRESHOLD,
  REGEN_INTERVAL_S,
  STARVE_INTERVAL_S,
} from '../constants';
import type { Player } from './player';

export interface SurvivalHooks {
  onHurt(amount: number): void;
  onDeath(): void;
  /** Armour points currently worn (0-20); scales damage reduction. */
  armorPoints(): number;
  /** True while a shield is raised. */
  isBlocking(): boolean;
  /** Wear down gear that absorbed a hit. */
  onAbsorb(blocked: boolean): void;
}

export class Survival {
  health = MAX_HEALTH;
  hunger = MAX_HUNGER;
  dead = false;
  /** Seconds of red screen flash left, purely cosmetic. */
  hurtFlash = 0;
  /** Bumped whenever health/hunger change so the HUD can re-render lazily. */
  version = 0;

  private invulnerable = 0;
  private regenTimer = 0;
  private starveTimer = 0;
  private readonly lastPos = new THREE.Vector3();
  private posInitialised = false;

  constructor(private readonly hooks: SurvivalHooks) {}

  update(dt: number, player: Player): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.dead) return;

    this.drainHunger(dt, player);
    this.applyFallDamage(player);
    this.tickRegenAndStarvation(dt);
  }

  private drainHunger(dt: number, player: Player): void {
    if (!this.posInitialised) {
      this.lastPos.copy(player.position);
      this.posInitialised = true;
    }
    const dx = player.position.x - this.lastPos.x;
    const dz = player.position.z - this.lastPos.z;
    const walked = Math.hypot(dx, dz);
    this.lastPos.copy(player.position);

    const before = this.hunger;
    this.hunger = Math.max(
      0,
      this.hunger - HUNGER_DRAIN_PER_S * dt - walked * HUNGER_DRAIN_PER_BLOCK,
    );
    if (Math.floor(before) !== Math.floor(this.hunger)) this.version++;
  }

  private applyFallDamage(player: Player): void {
    const fall = player.takeFallDistance();
    if (fall > FALL_DAMAGE_THRESHOLD) {
      this.damage(Math.floor(fall - FALL_DAMAGE_THRESHOLD));
    }
  }

  private tickRegenAndStarvation(dt: number): void {
    if (this.hunger >= REGEN_HUNGER_THRESHOLD && this.health < MAX_HEALTH) {
      this.regenTimer += dt;
      if (this.regenTimer >= REGEN_INTERVAL_S) {
        this.regenTimer = 0;
        this.health = Math.min(MAX_HEALTH, this.health + 1);
        this.hunger = Math.max(0, this.hunger - REGEN_HUNGER_COST);
        this.version++;
      }
    } else {
      this.regenTimer = 0;
    }

    if (this.hunger <= 0) {
      this.starveTimer += dt;
      if (this.starveTimer >= STARVE_INTERVAL_S) {
        this.starveTimer = 0;
        this.damage(1, true);
      }
    } else {
      this.starveTimer = 0;
    }
  }

  /**
   * Reduce incoming damage by armour and an active block.
   * Armour follows Minecraft's curve: each point removes 4%, capped at 80%.
   * Blocking is applied after armour, so a shield helps even when unarmoured.
   */
  mitigate(amount: number): { final: number; blocked: boolean } {
    const armor = Math.max(0, Math.min(20, this.hooks.armorPoints()));
    let result = amount * (1 - armor * 0.04);
    const blocked = this.hooks.isBlocking();
    if (blocked) result *= 1 - BLOCK_DAMAGE_REDUCTION;
    // Any hit that got through should still cost at least half a heart.
    return { final: result > 0 ? Math.max(0.5, result) : 0, blocked };
  }

  /**
   * Apply damage. `ignoreInvulnerability` is for damage-over-time like starving,
   * which also bypasses armour (you cannot armour against hunger).
   */
  damage(amount: number, ignoreInvulnerability = false): void {
    if (this.dead || amount <= 0) return;
    if (this.invulnerable > 0 && !ignoreInvulnerability) return;
    if (!ignoreInvulnerability) this.invulnerable = HURT_INVULN_S;

    if (!ignoreInvulnerability) {
      const { final, blocked } = this.mitigate(amount);
      if (final < amount) this.hooks.onAbsorb(blocked);
      amount = final;
      if (amount <= 0) return;
    }

    this.health = Math.max(0, this.health - amount);
    this.hurtFlash = 0.35;
    this.version++;
    this.hooks.onHurt(amount);

    if (this.health <= 0) {
      this.dead = true;
      this.hooks.onDeath();
    }
  }

  /** Returns false when already full, so the caller can keep the food. */
  eat(hungerRestored: number): boolean {
    if (this.hunger >= MAX_HUNGER) return false;
    this.hunger = Math.min(MAX_HUNGER, this.hunger + hungerRestored);
    this.version++;
    return true;
  }

  respawn(): void {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.dead = false;
    this.invulnerable = HURT_INVULN_S * 4; // brief grace period on respawn
    this.regenTimer = 0;
    this.starveTimer = 0;
    this.hurtFlash = 0;
    this.posInitialised = false;
    this.version++;
  }

  load(health: number, hunger: number): void {
    this.health = Math.max(1, Math.min(MAX_HEALTH, health));
    this.hunger = Math.max(0, Math.min(MAX_HUNGER, hunger));
    this.dead = false;
    this.version++;
  }
}
