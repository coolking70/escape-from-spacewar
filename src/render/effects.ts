// 战斗特效管理：激光、命中闪光、组件火花、爆炸、受损烟雾。
// 全部由 BattleState 的 shots / explosions 与派发的 BattleEvent 驱动，
// 渲染只负责把这些数据可视化，不影响模拟结果。
//
// 视觉对象（火花/烟雾/闪烁）允许使用渲染层的随机/时间，因为它们绝不回写 sim。

import * as THREE from 'three';
import { BattleState, BattleEvent, Vec3, ShipTypeName } from '../sim/battleTypes';

const TEAM_COLOR: Record<'A' | 'B', number> = { A: 0x44ddff, B: 0xff5a8c };
// 不同舰种 laser 粗细
const LASER_RADIUS: Record<ShipTypeName, number> = {
  Fighter: 0.16,
  Frigate: 0.3,
  Cruiser: 0.5
};

interface LaserVis {
  mesh: THREE.Mesh;
  tick: number;
  radius: number;
}
interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rot: THREE.Vector3;
}
interface ExplosionVis {
  group: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  debris: Debris[];
  age: number;
}
interface HitFlash {
  mesh: THREE.Mesh;
  age: number;
  max: number;
}
interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  max: number;
}
interface Smoke {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  max: number;
}
interface BeamVis {
  mesh: THREE.Mesh;
  age: number;
  max: number;
}
interface RingVis {
  mesh: THREE.Mesh;
  age: number;
  max: number;
}

const EXPLOSION_FRAMES = 50;
const MAX_SMOKE = 150;

function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

function shipTypeOf(state: BattleState, id: number): ShipTypeName | null {
  const sh = state.ships.find((s) => s.id === id);
  return sh ? sh.type : null;
}

function shipOf(state: BattleState, id: number) {
  return state.ships.find((s) => s.id === id) ?? null;
}

export class EffectsManager {
  private group: THREE.Group;
  private lasers = new Map<number, LaserVis>();
  private explosions = new Map<number, ExplosionVis>();
  private hitFlashes: HitFlash[] = [];
  private sparks: Spark[] = [];
  private smokes: Smoke[] = [];
  private beams: BeamVis[] = [];
  private rings: RingVis[] = [];

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  /** 用当前 state 的 shots/explosions 同步持续型特效（激光 / 爆炸） */
  sync(state: BattleState): void {
    // ---- 激光：以 shot id 为键，新增/移除 ----
    const shotIds = new Set(state.shots.map((s) => s.id));
    for (const [id, o] of this.lasers) {
      if (!shotIds.has(id)) {
        this.disposeMesh(o.mesh);
        this.lasers.delete(id);
      }
    }
    for (const s of state.shots) {
      if (this.lasers.has(s.id)) continue;
      const type = shipTypeOf(state, s.fromShip) ?? 'Fighter';
      const radius = LASER_RADIUS[type];
      const start = new THREE.Vector3(s.start.x, s.start.y, s.start.z);
      const end = new THREE.Vector3(s.end.x, s.end.y, s.end.z);
      const dir = end.clone().sub(start);
      const len = dir.length() || 0.001;
      const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        color: TEAM_COLOR[s.fromTeam],
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(start).add(end).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      this.group.add(mesh);
      this.lasers.set(s.id, { mesh, tick: s.tick, radius });
    }

    // ---- 爆炸：以 shipId 为键 ----
    const exIds = new Set(state.explosions.map((e) => e.shipId));
    for (const [id, o] of this.explosions) {
      if (!exIds.has(id)) {
        this.disposeExplosion(o);
        this.explosions.delete(id);
      }
    }
    for (const e of state.explosions) {
      if (this.explosions.has(e.shipId)) continue;
      this.explosions.set(e.shipId, this.spawnExplosion(e.pos));
    }
  }

  /** 处理本帧由 sim 派发的视觉事件：命中闪光 + 组件火花 + 改型特效 */
  syncEvents(events: BattleEvent[], state: BattleState): void {
    for (const ev of events) {
      if (ev.type === 'hit') {
        this.spawnHitFlash(ev.pos);
      } else if (ev.type === 'componentDamaged' && ev.hpRatio < 0.25) {
        const ship = shipOf(state, ev.shipId);
        if (ship && ship.alive) {
          const comp = ship.components[ev.compIndex];
          if (comp) {
            const off = rotateY(comp.def.offset, ship.heading);
            const pos = new THREE.Vector3(
              ship.pos.x + off.x * ship.def.scale,
              ship.pos.y + off.y * ship.def.scale,
              ship.pos.z + off.z * ship.def.scale
            );
            this.spawnSpark(pos);
          }
        }
      } else if (ev.type === 'pointDefenseFired') {
        // 点防御：青色短束激光
        this.spawnBeam(ev.start, ev.end, 0x66ffdd, 0.1, 5);
      } else if (ev.type === 'droneStrike') {
        // 无人机打击：从航母到各目标的橙色脉冲束
        for (const tid of ev.targetIds) {
          const tgt = shipOf(state, tid);
          if (tgt && tgt.alive) this.spawnBeam(ev.pos, tgt.pos, 0xffaa44, 0.13, 9);
        }
      } else if (ev.type === 'supportEffect') {
        // 支援光环：在来源舰处生成一圈淡光环（护盾=绿 / 传感器=蓝）
        const src = shipOf(state, ev.sourceShipId);
        if (src && src.alive) {
          const color = ev.effectType === 'shield' ? 0x66ffaa : 0x66ccff;
          this.spawnRing(src.pos, color);
        }
      }
    }
  }

  /** 每帧动画（按渲染帧推进，与 sim tick 解耦，仅视觉） */
  update(state: BattleState): void {
    // ---- 激光淡出（按 tick 年龄） ----
    for (const o of this.lasers.values()) {
      const age = state.tick - o.tick;
      const op = Math.max(0, 1 - age / 3);
      (o.mesh.material as THREE.MeshBasicMaterial).opacity = op;
    }

    // ---- 爆炸动画 ----
    for (const o of this.explosions.values()) {
      o.age++;
      const t = o.age / EXPLOSION_FRAMES;
      // 核心闪光：快速膨胀并淡出
      const cs = 0.4 + t * 6;
      o.core.scale.setScalar(cs);
      (o.core.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 1.6);
      // 冲击波环：扩张并淡出
      const rs = 0.5 + t * 9;
      o.ring.scale.set(rs, rs, 1);
      (o.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - t * 1.3);
      // 碎片：飞散 + 旋转 + 淡出
      for (const d of o.debris) {
        d.mesh.position.addScaledVector(d.vel, 0.06);
        d.vel.multiplyScalar(0.96);
        d.mesh.rotation.x += d.rot.x;
        d.mesh.rotation.y += d.rot.y;
        d.mesh.rotation.z += d.rot.z;
        (d.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 1.3);
      }
      if (o.age >= EXPLOSION_FRAMES) {
        // 动画结束后留待 sync() 依据 state 清理（避免提前消失）
      }
    }

    // ---- 命中闪光 ----
    this.animatePool(
      this.hitFlashes,
      (h) => {
        h.age++;
        const t = h.age / h.max;
        h.mesh.scale.setScalar(1 + t * 1.5);
        (h.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);
      },
      (h) => h.age >= h.max
    );

    // ---- 火花 ----
    this.animatePool(
      this.sparks,
      (s) => {
        s.age++;
        s.mesh.position.addScaledVector(s.vel, 0.08);
        s.vel.multiplyScalar(0.94);
        const t = s.age / s.max;
        (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);
      },
      (s) => s.age >= s.max
    );

    // ---- 烟雾 ----
    this.animatePool(
      this.smokes,
      (s) => {
        s.age++;
        s.mesh.position.addScaledVector(s.vel, 0.04);
        s.vel.y += 0.002; // 缓慢上浮
        const t = s.age / s.max;
        s.mesh.scale.setScalar(0.6 + t * 1.6);
        (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.5 * (1 - t));
      },
      (s) => s.age >= s.max
    );

    // ---- 点防御 / 无人机 光束 ----
    this.animatePool(
      this.beams,
      (b) => {
        b.age++;
        const t = b.age / b.max;
        (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t);
      },
      (b) => b.age >= b.max
    );

    // ---- 支援光环 ----
    this.animatePool(
      this.rings,
      (r) => {
        r.age++;
        const t = r.age / r.max;
        const s = 1 + t * 8;
        r.mesh.scale.set(s, s, 1);
        (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 * (1 - t));
      },
      (r) => r.age >= r.max
    );

    // ---- 持续烟雾：扫描重损组件，按概率冒烟（纯视觉，不影响 sim） ----
    if (this.smokes.length < MAX_SMOKE) {
      for (const ship of state.ships) {
        if (!ship.alive) continue;
        for (const comp of ship.components) {
          if (comp.destroyed) continue;
          const ratio = comp.hp / comp.maxHp;
          if (ratio < 0.3 && Math.random() < 0.08) {
            const off = rotateY(comp.def.offset, ship.heading);
            const pos = new THREE.Vector3(
              ship.pos.x + off.x * ship.def.scale,
              ship.pos.y + off.y * ship.def.scale,
              ship.pos.z + off.z * ship.def.scale
            );
            this.spawnSmoke(pos);
            if (this.smokes.length >= MAX_SMOKE) break;
          }
        }
        if (this.smokes.length >= MAX_SMOKE) break;
      }
    }
  }

  // ---------------- 生成器 ----------------

  private spawnHitFlash(pos: Vec3): void {
    const geo = new THREE.SphereGeometry(0.7, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff0c0,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    this.group.add(mesh);
    this.hitFlashes.push({ mesh, age: 0, max: 8 });
  }

  private spawnSpark(pos: THREE.Vector3): void {
    const geo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd070,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 1.6,
      Math.random() * 1.2,
      (Math.random() - 0.5) * 1.6
    );
    this.group.add(mesh);
    this.sparks.push({ mesh, vel, age: 0, max: 18 });
  }

  private spawnSmoke(pos: THREE.Vector3): void {
    const geo = new THREE.SphereGeometry(0.5, 6, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x55585f,
      transparent: true,
      opacity: 0.5,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.4 + Math.random() * 0.4, (Math.random() - 0.5) * 0.5);
    this.group.add(mesh);
    this.smokes.push({ mesh, vel, age: 0, max: 40 });
  }

  /** 短寿命光束（点防御青束 / 无人机橙束），纯视觉 */
  private spawnBeam(start: Vec3, end: Vec3, color: number, radius: number, max: number): void {
    const s = new THREE.Vector3(start.x, start.y, start.z);
    const e = new THREE.Vector3(end.x, end.y, end.z);
    const dir = e.clone().sub(s);
    const len = dir.length() || 0.001;
    const geo = new THREE.CylinderGeometry(radius, radius, len, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(s).add(e).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.group.add(mesh);
    this.beams.push({ mesh, age: 0, max });
  }

  /** 支援光环（护盾=绿 / 传感器=蓝），水平展开后淡出，纯视觉 */
  private spawnRing(pos: Vec3, color: number): void {
    const geo = new THREE.RingGeometry(0.8, 1.1, 24);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.x = -Math.PI / 2;
    this.group.add(mesh);
    this.rings.push({ mesh, age: 0, max: 22 });
  }

  private spawnExplosion(pos: Vec3): ExplosionVis {
    const g = new THREE.Group();
    g.position.set(pos.x, pos.y, pos.z);

    // 核心闪光
    const coreGeo = new THREE.SphereGeometry(1, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffd070,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    g.add(core);

    // 冲击波环
    const ringGeo = new THREE.RingGeometry(0.6, 1.0, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.lookAt(0, 0, 1); // 朝向相机方向近似（面向 +Z），后续由场景相机观看
    g.add(ring);

    // 碎片
    const debris: Debris[] = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const dgeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
      const dmat = new THREE.MeshBasicMaterial({
        color: 0xff8844,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const d = new THREE.Mesh(dgeo, dmat);
      const dir = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5
      ).normalize();
      d.position.copy(dir.clone().multiplyScalar(0.5));
      debris.push({
        mesh: d,
        vel: dir.multiplyScalar(1.5 + Math.random()),
        rot: new THREE.Vector3(
          (Math.random() - 0.5) * 0.4,
          (Math.random() - 0.5) * 0.4,
          (Math.random() - 0.5) * 0.4
        )
      });
      g.add(d);
    }

    this.group.add(g);
    return { group: g, core, ring, debris, age: 0 };
  }

  // ---------------- 工具 ----------------

  private animatePool<T extends { mesh: THREE.Mesh }>(
    pool: T[],
    step: (item: T) => void,
    dead: (item: T) => boolean
  ): void {
    for (let i = pool.length - 1; i >= 0; i--) {
      const item = pool[i];
      step(item);
      if (dead(item)) {
        this.disposeMesh(item.mesh);
        pool.splice(i, 1);
      }
    }
  }

  private disposeMesh(mesh: THREE.Mesh): void {
    this.group.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  private disposeExplosion(o: ExplosionVis): void {
    this.group.remove(o.group);
    o.core.geometry.dispose();
    (o.core.material as THREE.Material).dispose();
    o.ring.geometry.dispose();
    (o.ring.material as THREE.Material).dispose();
    for (const d of o.debris) {
      d.mesh.geometry.dispose();
      (d.mesh.material as THREE.Material).dispose();
    }
  }

  dispose(): void {
    for (const o of this.lasers.values()) this.disposeMesh(o.mesh);
    for (const o of this.explosions.values()) this.disposeExplosion(o);
    for (const h of this.hitFlashes) this.disposeMesh(h.mesh);
    for (const s of this.sparks) this.disposeMesh(s.mesh);
    for (const s of this.smokes) this.disposeMesh(s.mesh);
    for (const b of this.beams) this.disposeMesh(b.mesh);
    for (const r of this.rings) this.disposeMesh(r.mesh);
    this.lasers.clear();
    this.explosions.clear();
    this.hitFlashes.length = 0;
    this.sparks.length = 0;
    this.smokes.length = 0;
    this.beams.length = 0;
    this.rings.length = 0;
  }
}
