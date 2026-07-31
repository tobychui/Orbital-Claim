import { Turret } from './Turret.js';

/**
 * Pulser — higher sustained damage and reach, at a steep power cost.
 *
 * Alternates barrels so the muzzle flash reads as a rapid stream rather than a
 * single stuttering point.
 */
export class Pulser extends Turret {
  constructor(x, y, def) {
    super(x, y, def, 'pulser');
    this.barrel = 0;
    this.turnSpeed = 9;
  }

  fire(world) {
    this.barrel ^= 1;
    const off = this.barrel ? 5 : -5;
    const perp = this.angle + Math.PI / 2;
    world.spawnProjectile({
      kind: this.projectileKind,
      x: this.pos.x + Math.cos(this.angle) * this.radius + Math.cos(perp) * off,
      y: this.pos.y + Math.sin(this.angle) * this.radius + Math.sin(perp) * off,
      target: this.target,
      damage: this.attackDamage,
      splash: this.splash,
    });
    this.recoil = 1;
  }
}
