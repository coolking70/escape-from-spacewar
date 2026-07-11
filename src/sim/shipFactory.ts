// 飞船工厂：定义三种飞船的组件构成，并能由定义实例化运行时 Ship。
//
// 每种飞船由多个组件组成，组件拥有独立 HP 与损毁状态：
//   - core    核心舰体（被摧毁则飞船爆炸）
//   - engine  引擎（损毁降低速度/转向）
//   - weapon  武器（损毁降低开火能力）
//   - sensor  传感器（损毁降低命中率/索敌范围）
//   - shield  护盾发生器（损毁降低最大护盾/恢复）
//   - armor   装甲板（纯缓冲 HP）

import { ShipDef, ShipTypeName, Ship, ShipVariant, VariantMods, Team, Vec3 } from './battleTypes';
import { recomputeDerived } from './damageModel';

export const SHIP_DEFS: Record<ShipTypeName, ShipDef> = {
  // ---------------- Fighter：小型战斗机 ----------------
  Fighter: {
    type: 'Fighter',
    maxSpeed: 0.26,
    turnRate: 0.1,
    baseRange: 60,
    scale: 0.6,
    components: [
      {
        type: 'core',
        name: '舰体核心',
        maxHp: 70,
        offset: { x: 0, y: 0, z: 0 },
        size: { x: 1.6, y: 0.9, z: 2.6 },
        shape: 'box'
      },
      {
        type: 'engine',
        name: '主引擎',
        maxHp: 28,
        offset: { x: 0, y: 0, z: -1.6 },
        size: { x: 0.7, y: 0.7, z: 1.1 },
        shape: 'cylinder'
      },
      {
        type: 'weapon',
        name: '前射激光',
        maxHp: 32,
        // offset 改为 +X 朝前（适配新舰船模型正面方向）
        offset: { x: 0.9, y: 0.1, z: 0 },
        size: { x: 0.5, y: 0.5, z: 1.0 },
        shape: 'box',
        weapon: {
          name: 'Laser',
          range: 42,
          damage: 9,
          cooldownTicks: 18,
          offset: { x: 0.9, y: 0.1, z: 0 },
          arc: 'front',
          arcDegrees: 45,
          role: 'laser',
          visualSize: 0.16
        }
      },
      {
        type: 'sensor',
        name: '传感器',
        maxHp: 22,
        offset: { x: 0, y: 0.5, z: 0.8 },
        size: { x: 0.5, y: 0.5, z: 0.5 },
        shape: 'sphere'
      }
    ]
  },

  // ---------------- Frigate：护卫舰 ----------------
  Frigate: {
    type: 'Frigate',
    maxSpeed: 0.16,
    turnRate: 0.05,
    baseRange: 85,
    scale: 1.0,
    components: [
      {
        type: 'core',
        name: '舰体核心',
        maxHp: 170,
        offset: { x: 0, y: 0, z: 0 },
        size: { x: 3.0, y: 1.4, z: 5.0 },
        shape: 'box'
      },
      {
        type: 'engine',
        name: '左引擎',
        maxHp: 55,
        offset: { x: -0.9, y: 0, z: -3.2 },
        size: { x: 0.9, y: 0.9, z: 1.4 },
        shape: 'cylinder'
      },
      {
        type: 'engine',
        name: '右引擎',
        maxHp: 55,
        offset: { x: 0.9, y: 0, z: -3.2 },
        size: { x: 0.9, y: 0.9, z: 1.4 },
        shape: 'cylinder'
      },
      {
        type: 'weapon',
        name: '前方主炮',
        maxHp: 70,
        // offset 改为 +X 朝前
        offset: { x: 2.6, y: 0.55, z: 0 },
        size: { x: 1.0, y: 1.0, z: 2.0 },
        shape: 'box',
        weapon: {
          name: 'MainCannon',
          range: 68,
          damage: 24,
          cooldownTicks: 34,
          offset: { x: 2.6, y: 0.55, z: 0 },
          arc: 'front',
          arcDegrees: 60,
          role: 'cannon',
          visualSize: 0.32
        }
      },
      {
        type: 'weapon',
        name: '左舷炮',
        maxHp: 45,
        // offset 改为 +X 朝前体系：左舷 = -Z 方向
        offset: { x: 0.3, y: 0.45, z: -1.3 },
        size: { x: 0.6, y: 0.6, z: 1.4 },
        shape: 'box',
        weapon: {
          name: 'SideGunL',
          range: 46,
          damage: 11,
          cooldownTicks: 24,
          offset: { x: 0.3, y: 0.45, z: -1.3 },
          arc: 'broadside',
          arcDegrees: 110,
          role: 'laser',
          visualSize: 0.22
        }
      },
      {
        type: 'weapon',
        name: '右舷炮',
        maxHp: 45,
        // offset 改为 +X 朝前体系：右舷 = +Z 方向
        offset: { x: 0.3, y: 0.45, z: 1.3 },
        size: { x: 0.6, y: 0.6, z: 1.4 },
        shape: 'box',
        weapon: {
          name: 'SideGunR',
          range: 46,
          damage: 11,
          cooldownTicks: 24,
          offset: { x: 0.3, y: 0.45, z: 1.3 },
          arc: 'broadside',
          arcDegrees: 110,
          role: 'laser',
          visualSize: 0.22
        }
      },
      {
        type: 'sensor',
        name: '传感器',
        maxHp: 45,
        offset: { x: 0, y: 0.9, z: 1.8 },
        size: { x: 0.6, y: 0.6, z: 0.6 },
        shape: 'sphere'
      },
      {
        type: 'shield',
        name: '护盾发生器',
        maxHp: 70,
        offset: { x: 0, y: 0.2, z: -1.2 },
        size: { x: 1.2, y: 1.0, z: 1.6 },
        shape: 'box'
      }
    ]
  },

  // ---------------- Cruiser：巡洋舰 ----------------
  Cruiser: {
    type: 'Cruiser',
    maxSpeed: 0.1,
    turnRate: 0.03,
    baseRange: 115,
    scale: 1.6,
    components: [
      {
        type: 'core',
        name: '舰体核心',
        maxHp: 380,
        offset: { x: 0, y: 0, z: 0 },
        size: { x: 4.5, y: 2.0, z: 7.5 },
        shape: 'box'
      },
      {
        type: 'engine',
        name: '左引擎',
        maxHp: 95,
        offset: { x: -1.4, y: 0, z: -5.0 },
        size: { x: 1.1, y: 1.1, z: 1.8 },
        shape: 'cylinder'
      },
      {
        type: 'engine',
        name: '中引擎',
        maxHp: 95,
        offset: { x: 0, y: 0, z: -5.0 },
        size: { x: 1.1, y: 1.1, z: 1.8 },
        shape: 'cylinder'
      },
      {
        type: 'engine',
        name: '右引擎',
        maxHp: 95,
        offset: { x: 1.4, y: 0, z: -5.0 },
        size: { x: 1.1, y: 1.1, z: 1.8 },
        shape: 'cylinder'
      },
      {
        type: 'weapon',
        name: '前方主炮',
        maxHp: 95,
        // offset 改为 +X 朝前（× scale 1.6 后对齐模型炮口位置）
        offset: { x: 5.4, y: 1.4, z: 0 },
        size: { x: 1.4, y: 1.4, z: 2.6 },
        shape: 'box',
        weapon: {
          name: 'MainCannon',
          range: 95,
          damage: 38,
          cooldownTicks: 40,
          offset: { x: 5.4, y: 1.4, z: 0 },
          arc: 'front',
          arcDegrees: 60,
          role: 'cannon',
          visualSize: 0.5
        }
      },
      {
        type: 'weapon',
        name: '左舷炮',
        maxHp: 60,
        // offset 改为 +X 朝前体系：左舷 = -Z 方向
        offset: { x: 0.8, y: 1.4, z: -3.4 },
        size: { x: 0.9, y: 0.9, z: 2.0 },
        shape: 'box',
        weapon: {
          name: 'SideGunL',
          range: 62,
          damage: 17,
          cooldownTicks: 30,
          offset: { x: 0.8, y: 1.4, z: -3.4 },
          arc: 'broadside',
          arcDegrees: 110,
          role: 'laser',
          visualSize: 0.32
        }
      },
      {
        type: 'weapon',
        name: '右舷炮',
        maxHp: 60,
        // offset 改为 +X 朝前体系：右舷 = +Z 方向
        offset: { x: 0.8, y: 1.4, z: 3.4 },
        size: { x: 0.9, y: 0.9, z: 2.0 },
        shape: 'box',
        weapon: {
          name: 'SideGunR',
          range: 62,
          damage: 17,
          cooldownTicks: 30,
          offset: { x: 0.8, y: 1.4, z: 3.4 },
          arc: 'broadside',
          arcDegrees: 110,
          role: 'laser',
          visualSize: 0.32
        }
      },
      {
        type: 'weapon',
        name: '顶部炮塔',
        maxHp: 70,
        offset: { x: -0.6, y: 1.9, z: 0 },
        size: { x: 1.0, y: 0.7, z: 1.0 },
        shape: 'box',
        weapon: {
          name: 'TopTurret',
          range: 80,
          damage: 22,
          cooldownTicks: 36,
          offset: { x: -0.6, y: 2.4, z: 0 },
          arc: 'turret',
          arcDegrees: 170,
          role: 'cannon',
          visualSize: 0.4
        }
      },
      {
        type: 'sensor',
        name: '左传感器',
        maxHp: 75,
        offset: { x: -1.6, y: 1.2, z: 2.5 },
        size: { x: 0.7, y: 0.7, z: 0.7 },
        shape: 'sphere'
      },
      {
        type: 'sensor',
        name: '右传感器',
        maxHp: 75,
        offset: { x: 1.6, y: 1.2, z: 2.5 },
        size: { x: 0.7, y: 0.7, z: 0.7 },
        shape: 'sphere'
      },
      {
        type: 'shield',
        name: '左护盾',
        maxHp: 120,
        offset: { x: -1.6, y: 0.3, z: -2.0 },
        size: { x: 1.6, y: 1.3, z: 2.2 },
        shape: 'box'
      },
      {
        type: 'shield',
        name: '右护盾',
        maxHp: 120,
        offset: { x: 1.6, y: 0.3, z: -2.0 },
        size: { x: 1.6, y: 1.3, z: 2.2 },
        shape: 'box'
      },
      {
        type: 'armor',
        name: '左装甲',
        maxHp: 130,
        offset: { x: -1.4, y: 0.2, z: 1.0 },
        size: { x: 1.4, y: 1.4, z: 3.0 },
        shape: 'box'
      },
      {
        type: 'armor',
        name: '右装甲',
        maxHp: 130,
        offset: { x: 1.4, y: 0.2, z: 1.0 },
        size: { x: 1.4, y: 1.4, z: 3.0 },
        shape: 'box'
      }
    ]
  }
};

/** 由 ShipDef 实例化一艘飞船（组件 HP 满，未损毁）。
 *  variant / variantMods 来自 shipVariants.resolveShipDef 的解析结果，
 *  仅携带 sim 所需的修正数据，渲染层不会读取它们。 */
export function createShip(
  def: ShipDef,
  variant: ShipVariant,
  mods: VariantMods,
  id: number,
  team: Team,
  pos: Vec3,
  heading: number
): Ship {
  const components = def.components.map((c, i) => ({
    id: i,
    def: c,
    hp: c.maxHp,
    maxHp: c.maxHp,
    destroyed: false
  }));

  const ship: Ship = {
    id,
    team,
    type: def.type,
    variant,
    variantMods: mods,
    def,
    pos: { ...pos },
    heading,
    alive: true,
    components,
    targetId: null,
    shield: 0,
    maxShield: 0,
    shieldRegen: 0,
    lastFireTick: new Map<number, number>(),
    effectiveSpeed: def.maxSpeed,
    effectiveTurnRate: def.turnRate,
    effectiveRange: def.baseRange,
    accuracy: 0.9,
    droneNextTick: mods.droneStrike ? mods.droneStrike.intervalTicks : 0,
    // ---- core-v4 战斗状态机默认值（旧 core-v3 不读取） ----
    combatState: 'normal',
    mobilityDisabled: false,
    weaponsDisabled: false,
    sensorsDisabled: false,
    targetLockUntilTick: 0,
    lastTargetEvaluationTick: 0,
    engineRatio: 1,
    weaponEfficiency: 1,
    sensorRatio: 1,
    exposedZones: [],
    isAnchor: false
  };

  recomputeDerived(ship);
  ship.shield = ship.maxShield;
  return ship;
}
