// 舰船改型注册表（V0.4）。
// 在 Fighter / Frigate / Cruiser 三种基础舰体之上，提供多种改型（loadout）。
// 每个改型包含：成本、中文文案、属性修正、武器覆盖、支援光环 / 特殊效果。
// 所有数值均为确定性固定表（与 seed 无关），由 shipFactory.resolveShipDef 解析为具体 ShipDef。
//
// 设计原则：改型【不增减组件数量】，只修改已有组件的 HP / 武器参数与舰体级属性，
// 这样组件下标保持稳定，渲染层（按组件下标映射 Mesh）无需改动即可显示损伤。
// 视觉差异通过在 shipMeshFactory 中按 variant 追加装饰性 Mesh 实现。

import {
  ShipClass,
  ShipVariant,
  ShipDef,
  ComponentDef,
  VariantMods,
  FleetEntry,
  FiringArc,
  HitZone
} from './battleTypes';
import { SHIP_DEFS } from './shipFactory';

// ---------------- 中文文案 ----------------

export const SHIP_CN: Record<ShipClass, string> = {
  Fighter: '战斗机',
  Frigate: '护卫舰',
  Cruiser: '巡洋舰'
};

export const VARIANT_CN: Record<ShipVariant, string> = {
  standard: '标准型',
  interceptor: '截击型',
  bomber: '轰炸型',
  scout: '侦察型',
  escort: '护航型',
  artillery: '炮击型',
  support: '支援型',
  battleship: '战列型',
  carrier: '航母型',
  fortress: '堡垒型'
};

/** 每个基础舰体允许使用的改型（UI 下拉过滤用） */
export const VARIANTS_BY_CLASS: Record<ShipClass, ShipVariant[]> = {
  Fighter: ['standard', 'interceptor', 'bomber', 'scout'],
  Frigate: ['standard', 'escort', 'artillery', 'support'],
  Cruiser: ['standard', 'battleship', 'carrier', 'fortress']
};

/** 改型 key 用于损失统计： `${class}:${variant}` */
export function variantKey(cls: ShipClass, variant: ShipVariant): string {
  return `${cls}:${variant}`;
}

// ---------------- 改型定义结构 ----------------

interface WeaponOverride {
  /** 匹配基础武器名称 */
  match: string;
  damageMul?: number;
  cooldownMul?: number;
  rangeMul?: number;
  role?: 'laser' | 'cannon' | 'pd';
  name?: string;
  arc?: FiringArc;
  arcDegrees?: number;
  visualSize?: number;
}

interface VariantDef {
  id: ShipVariant;
  shipClass: ShipClass;
  displayName: string;
  cost: number;
  description: string;
  role: string;
  strength: string;
  weakness: string;
  recFormation: string;
  recDoctrine: string;
  weaponNote: string;
  componentNote: string;
  tags: string[];
  mods: VariantMods;
  weaponOverrides?: WeaponOverride[];
  /** 预览页数值条（0~1，纯展示用） */
  bars: { speed: number; firepower: number; defense: number; range: number; support: number };
}

function baseMods(): VariantMods {
  return {
    maxSpeedMul: 1,
    turnRateMul: 1,
    baseRangeMul: 1,
    coreHpMul: 1,
    shieldMul: 1,
    armorHpMul: 1,
    sensorHpMul: 1,
    weaponDamageMul: 1,
    weaponCooldownMul: 1,
    classDamageMul: {},
    accuracyBonusVs: {},
    accuracyPenaltyVs: {},
    closeRangePenalty: 0,
    pointDefense: false
  };
}

// ---------------- 改型注册表 ----------------

export const VARIANTS: Record<ShipVariant, VariantDef> = {
  standard: {
    id: 'standard',
    shipClass: 'Fighter',
    displayName: '标准型',
    cost: 50,
    description: '通用均衡配置，无特殊偏向。',
    role: '均衡基线',
    strength: '无短板',
    weakness: '无突出优势',
    recFormation: '横列阵',
    recDoctrine: '均衡',
    weaponNote: '标准武器，无强化。',
    componentNote: '标准组件配置。',
    tags: ['baseline'],
    mods: baseMods(),
    bars: { speed: 0.7, firepower: 0.4, defense: 0.3, range: 0.4, support: 0 }
  },

  interceptor: {
    id: 'interceptor',
    shipClass: 'Fighter',
    displayName: '截击型',
    cost: 55,
    description: '反小船、追击、拦截。速度更快、转向更好、武器冷却短，但单发伤害略低、核心偏脆。',
    role: '反小船 / 拦截',
    strength: '克制 Fighter，机动极强',
    weakness: '对 Cruiser 伤害低、较脆',
    recFormation: '蜂群阵',
    recDoctrine: '积极 / 拦截',
    weaponNote: '武器冷却 -20%，伤害 -10%。',
    componentNote: '核心 HP -10%，引擎/转向 +20%。',
    tags: ['anti-fighter', 'fast'],
    mods: {
      ...baseMods(),
      maxSpeedMul: 1.2,
      turnRateMul: 1.2,
      weaponCooldownMul: 0.8,
      weaponDamageMul: 0.9,
      coreHpMul: 0.9
    },
    bars: { speed: 1, firepower: 0.35, defense: 0.25, range: 0.4, support: 0 }
  },

  bomber: {
    id: 'bomber',
    shipClass: 'Fighter',
    displayName: '轰炸型',
    cost: 70,
    description: '反大型舰。速度较慢，主炮改为重型脉冲炮，对 Cruiser/Frigate 有伤害加成，但易被点防御压制、对 Fighter 命中低。',
    role: '反大型舰',
    strength: '克制 Cruiser / Frigate',
    weakness: '被 Interceptor、点防御压制；对 Fighter 命中低',
    recFormation: '楔形阵',
    recDoctrine: '积极',
    weaponNote: '主炮伤害 +70%、冷却 +50%（重型脉冲炮）。',
    componentNote: '速度 -15%，转向 -10%。',
    tags: ['anti-capital', 'heavy'],
    mods: {
      ...baseMods(),
      maxSpeedMul: 0.85,
      turnRateMul: 0.9,
      classDamageMul: { Cruiser: 1.3, Frigate: 1.15 },
      accuracyPenaltyVs: { Fighter: 0.15 }
    },
    weaponOverrides: [{ match: 'Laser', damageMul: 1.7, cooldownMul: 1.5, role: 'cannon', name: 'HeavyPulse', visualSize: 0.24 }],
    bars: { speed: 0.5, firepower: 0.6, defense: 0.3, range: 0.45, support: 0 }
  },

  scout: {
    id: 'scout',
    shipClass: 'Fighter',
    displayName: '侦察型',
    cost: 45,
    description: '传感器支援。低伤害、高传感器，为半径内友军提供命中/索敌加成。',
    role: '传感器支援',
    strength: '提升友军命中/索敌',
    weakness: '火力弱',
    recFormation: '横列阵',
    recDoctrine: '均衡',
    weaponNote: '武器伤害 -30%。',
    componentNote: '传感器 HP +50%，索敌 +20%。',
    tags: ['support', 'sensor'],
    mods: {
      ...baseMods(),
      weaponDamageMul: 0.7,
      sensorHpMul: 1.5,
      baseRangeMul: 1.2,
      supportAura: { type: 'sensor', radius: 45, value: 0.05 }
    },
    bars: { speed: 0.8, firepower: 0.2, defense: 0.3, range: 0.5, support: 1 }
  },

  // ---------------- Frigate ----------------

  escort: {
    id: 'escort',
    shipClass: 'Frigate',
    displayName: '护航型',
    cost: 170,
    description: '保护主力舰，反 Fighter。点防御武器多，对 Fighter/Bomber 命中更高，对大型舰伤害略低。',
    role: '护航 / 反 Fighter',
    strength: '对 Fighter/Bomber 命中高；screen 战术表现强',
    weakness: '对大型舰伤害偏低',
    recFormation: '防御墙',
    recDoctrine: '拦截 / 均衡',
    weaponNote: '舷炮改为点防御（短射程快速），命中 +15%（对 Fighter/Bomber）。',
    componentNote: '武器冷却 -10%。',
    tags: ['pd', 'screen'],
    mods: {
      ...baseMods(),
      weaponCooldownMul: 0.9,
      pointDefense: true,
      accuracyBonusVs: { Fighter: 0.15 },
      classDamageMul: { Cruiser: 0.85, Frigate: 0.95 }
    },
    weaponOverrides: [
      { match: 'SideGunL', role: 'pd', name: 'PointDefense', damageMul: 1.1, cooldownMul: 0.8 },
      { match: 'SideGunR', role: 'pd', name: 'PointDefense', damageMul: 1.1, cooldownMul: 0.8 }
    ],
    bars: { speed: 0.5, firepower: 0.55, defense: 0.55, range: 0.55, support: 0.4 }
  },

  artillery: {
    id: 'artillery',
    shipClass: 'Frigate',
    displayName: '炮击型',
    cost: 185,
    description: '远程火力。射程更远、伤害更高，转向与近距离表现较差，适合防御/拉扯。',
    role: '远程火力',
    strength: '射程远、火力高',
    weakness: '转向慢、近距离命中低',
    recFormation: '防御墙',
    recDoctrine: '防御 / 拉扯',
    weaponNote: '主炮射程 +30%、伤害 +20%；全武器伤害 +15%、冷却 +15%。',
    componentNote: '转向 -15%，近距离命中 -15%。',
    tags: ['range', 'firepower'],
    mods: {
      ...baseMods(),
      baseRangeMul: 1.25,
      weaponDamageMul: 1.15,
      weaponCooldownMul: 1.15,
      turnRateMul: 0.85,
      closeRangePenalty: 0.15
    },
    weaponOverrides: [{ match: 'MainCannon', rangeMul: 1.3, damageMul: 1.2 }],
    bars: { speed: 0.4, firepower: 0.8, defense: 0.5, range: 1, support: 0 }
  },

  support: {
    id: 'support',
    shipClass: 'Frigate',
    displayName: '支援型',
    cost: 175,
    description: '护盾或维修支援。自身火力较低，为半径内友军提供缓慢护盾恢复增强。',
    role: '护盾支援',
    strength: '提升友军护盾恢复',
    weakness: '火力弱',
    recFormation: '防御墙',
    recDoctrine: '防御',
    weaponNote: '武器伤害 -20%。',
    componentNote: '护盾 HP +20%，传感器 +20%。',
    tags: ['support', 'shield'],
    mods: {
      ...baseMods(),
      weaponDamageMul: 0.8,
      shieldMul: 1.2,
      sensorHpMul: 1.2,
      supportAura: { type: 'shield', radius: 40, value: 0.6 }
    },
    bars: { speed: 0.5, firepower: 0.4, defense: 0.6, range: 0.6, support: 1 }
  },

  // ---------------- Cruiser ----------------

  battleship: {
    id: 'battleship',
    shipClass: 'Cruiser',
    displayName: '战列型',
    cost: 470,
    description: '重火力主力舰。主炮更强、冷却更长，移动更慢，对 Frigate/Cruiser 威胁高。',
    role: '重火力主力',
    strength: '主炮爆发高',
    weakness: '移动慢、较脆以外的舰体仍慢',
    recFormation: '防御墙',
    recDoctrine: '防御 / 反大舰',
    weaponNote: '主炮伤害 +25%、冷却 +10%；全武器伤害 +10%。',
    componentNote: '速度 -10%，核心 HP +10%。',
    tags: ['firepower', 'capital'],
    mods: {
      ...baseMods(),
      weaponDamageMul: 1.1,
      maxSpeedMul: 0.9,
      coreHpMul: 1.1
    },
    weaponOverrides: [{ match: 'MainCannon', damageMul: 1.25, cooldownMul: 1.1 }],
    bars: { speed: 0.25, firepower: 1, defense: 0.85, range: 0.8, support: 0 }
  },

  carrier: {
    id: 'carrier',
    shipClass: 'Cruiser',
    displayName: '航母型',
    cost: 480,
    description: '舰载机/无人机支援。主炮略弱，每隔固定 tick 对若干目标释放无人机打击（sim 层产生）。对分散目标有优势。',
    role: '无人机支援',
    strength: '周期性无人机打击，覆盖多目标',
    weakness: '主炮偏弱',
    recFormation: '防御墙',
    recDoctrine: '防御 / 均衡',
    weaponNote: '主炮伤害 -15%。',
    componentNote: '每 90 tick 释放一次无人机打击（伤害 6，最多 3 目标）。',
    tags: ['drone', 'support'],
    mods: {
      ...baseMods(),
      weaponDamageMul: 0.85,
      droneStrike: { intervalTicks: 90, damage: 6, maxTargets: 3 }
    },
    bars: { speed: 0.3, firepower: 0.75, defense: 0.8, range: 0.8, support: 0.8 }
  },

  fortress: {
    id: 'fortress',
    shipClass: 'Cruiser',
    displayName: '堡垒型',
    cost: 460,
    description: '超高耐久防线。护盾与装甲更高、速度更慢、火力略低，适合墙阵 / 防御。',
    role: '超高耐久防线',
    strength: '极耐打',
    weakness: '移动慢、火力略低',
    recFormation: '防御墙',
    recDoctrine: '防御',
    weaponNote: '全武器伤害 -10%。',
    componentNote: '速度 -25%，护盾 +35%，装甲/核心 HP +25%。',
    tags: ['tank', 'defense'],
    mods: {
      ...baseMods(),
      maxSpeedMul: 0.75,
      shieldMul: 1.35,
      armorHpMul: 1.25,
      coreHpMul: 1.25,
      turnRateMul: 0.8,
      weaponDamageMul: 0.9
    },
    bars: { speed: 0.2, firepower: 0.7, defense: 1, range: 0.8, support: 0.3 }
  }
};

// ---------------- 解析：基础 ShipDef + variant → 具体 ShipDef ----------------

function cloneComponent(c: ComponentDef): ComponentDef {
  return {
    type: c.type,
    name: c.name,
    maxHp: c.maxHp,
    offset: { ...c.offset },
    size: { ...c.size },
    shape: c.shape,
    weapon: c.weapon
      ? { ...c.weapon, offset: { ...c.weapon.offset } }
      : undefined,
    // core-v4 命中模型字段（旧 core-v3 不读取，仅 v4 命中选择使用）
    hitZones: c.hitZones ? [...c.hitZones] : undefined,
    hitWeight: c.hitWeight,
    exposedWhen: c.exposedWhen ? [...c.exposedWhen] : undefined,
    protects: c.protects ? [...c.protects] : undefined
  };
}

function cloneShipDef(d: ShipDef): ShipDef {
  return {
    type: d.type,
    maxSpeed: d.maxSpeed,
    turnRate: d.turnRate,
    baseRange: d.baseRange,
    scale: d.scale,
    components: d.components.map(cloneComponent)
  };
}

function cloneMods(m: VariantMods): VariantMods {
  return {
    ...m,
    classDamageMul: { ...m.classDamageMul },
    accuracyBonusVs: { ...m.accuracyBonusVs },
    accuracyPenaltyVs: { ...m.accuracyPenaltyVs },
    supportAura: m.supportAura ? { ...m.supportAura } : undefined,
    droneStrike: m.droneStrike ? { ...m.droneStrike } : undefined
  };
}

/**
 * core-v4 命中模型：依据组件类型与本地偏移，推导其"易受攻击方位"、
 * 命中权重与"保护关系"。纯函数（与 seed 无关），仅 v4 命中选择使用。
 *
 * 约定（与武器开火弧一致）：前向 = +x；右舷 = +z，左舷 = -z，后方 = -x。
 * 引擎一律标为 rear（后方攻击更易命中引擎）；舷炮按 ±z 归于 left/right；
 * 护盾/装甲按 ±x（左右）保护核心。核心全向但权重低，对应方位装甲被摧毁后暴露。
 */
function attachHitZones(def: ShipDef): void {
  for (const c of def.components) {
    switch (c.type) {
      case 'core':
        c.hitZones = ['front', 'left', 'right', 'rear'];
        c.hitWeight = 0.5;
        c.exposedWhen = ['left', 'right'];
        break;
      case 'engine':
        // 引擎在舰尾（-z 长轴的尾端），归为 rear：后方攻击优先命中
        c.hitZones = ['rear'];
        c.hitWeight = 1.0;
        break;
      case 'sensor':
        c.hitZones = ['front'];
        c.hitWeight = 0.8;
        break;
      case 'shield':
        c.hitZones = ['left', 'right'];
        c.hitWeight = 0.9;
        c.protects = ['core'];
        break;
      case 'armor': {
        if (c.offset.x < -0.1) {
          c.hitZones = ['left'];
        } else if (c.offset.x > 0.1) {
          c.hitZones = ['right'];
        } else {
          c.hitZones = ['front', 'left', 'right', 'rear'];
        }
        c.hitWeight = 1.0;
        c.protects = ['core'];
        break;
      }
      case 'weapon': {
        const w = c.weapon;
        if (w && w.arc === 'turret') {
          c.hitZones = ['front', 'left', 'right', 'rear'];
          c.hitWeight = 0.9;
        } else if (c.offset.z < -0.1) {
          c.hitZones = ['left'];
          c.hitWeight = 1.0;
        } else if (c.offset.z > 0.1) {
          c.hitZones = ['right'];
          c.hitWeight = 1.0;
        } else {
          c.hitZones = ['front'];
          c.hitWeight = 1.0;
        }
        break;
      }
    }
  }
}

/**
 * 解析出某个 (舰体, 改型) 的具体 ShipDef 与 sim 修正项。
 * 纯函数：相同输入恒得相同输出，绝不读取 seed / 随机 / 真实时间。
 */
export function resolveShipDef(
  base: ShipDef,
  variant: ShipVariant
): { def: ShipDef; mods: VariantMods } {
  const def = cloneShipDef(base);
  const v = VARIANTS[variant] ?? VARIANTS.standard;
  const m = v.mods;

  def.maxSpeed *= m.maxSpeedMul;
  def.turnRate *= m.turnRateMul;
  def.baseRange *= m.baseRangeMul;

  for (const comp of def.components) {
    switch (comp.type) {
      case 'core':
        comp.maxHp = Math.round(comp.maxHp * m.coreHpMul);
        break;
      case 'shield':
        comp.maxHp = Math.round(comp.maxHp * m.shieldMul);
        break;
      case 'armor':
        comp.maxHp = Math.round(comp.maxHp * m.armorHpMul);
        break;
      case 'sensor':
        comp.maxHp = Math.round(comp.maxHp * m.sensorHpMul);
        break;
    }
    if (comp.weapon) {
      comp.weapon.damage *= m.weaponDamageMul;
      comp.weapon.cooldownTicks = Math.round(comp.weapon.cooldownTicks * m.weaponCooldownMul);
    }
  }

  // 武器覆盖（按名称匹配基础武器）
  if (v.weaponOverrides) {
    for (const ov of v.weaponOverrides) {
      const comp = def.components.find((c) => c.weapon && c.weapon.name === ov.match);
      const w = comp?.weapon;
      if (!w) continue;
      if (ov.damageMul != null) w.damage *= ov.damageMul;
      if (ov.cooldownMul != null) w.cooldownTicks = Math.round(w.cooldownTicks * ov.cooldownMul);
      if (ov.rangeMul != null) w.range *= ov.rangeMul;
      if (ov.role != null) w.role = ov.role;
      if (ov.name != null) w.name = ov.name;
      if (ov.arc != null) w.arc = ov.arc;
      if (ov.arcDegrees != null) w.arcDegrees = ov.arcDegrees;
      if (ov.visualSize != null) w.visualSize = ov.visualSize;
    }
  }

  // 圆整武器数值（仅美观，避免浮点展示噪声）
  for (const comp of def.components) {
    if (comp.weapon) {
      comp.weapon.damage = Math.round(comp.weapon.damage * 10) / 10;
      comp.weapon.range = Math.round(comp.weapon.range * 10) / 10;
    }
  }

  // core-v4：依据组件类型与本地偏移推导"命中方位 / 命中权重 / 受保护关系"。
  // 纯函数（与 seed 无关），仅 v4 命中选择使用；旧 core-v3 不读取这些字段。
  attachHitZones(def);

  return { def, mods: cloneMods(m) };
}

const _shipDefCache = new Map<string, { def: ShipDef; mods: VariantMods }>();

/** 取 (舰体, 改型) 的解析结果。
 * 带缓存以节省重复解析；但每次返回【深拷贝】，保证调用方拿到的
 * def / mods 不会被战斗实例（或后续逻辑）意外共享引用并修改，
 * 从而满足"shipDefs / shipVariants 不能被战斗实例直接修改"的确定性约束。 */
export function getShipDef(cls: ShipClass, variant: ShipVariant): { def: ShipDef; mods: VariantMods } {
  const key = `${cls}:${variant}`;
  let r = _shipDefCache.get(key);
  if (!r) {
    r = resolveShipDef(SHIP_DEFS[cls], variant);
    _shipDefCache.set(key, r);
  }
  // 深拷贝：克隆缓存里的 def 与 mods，切断共享引用
  const def = cloneShipDef(r.def);
  const mods = cloneMods(r.mods);
  return { def, mods };
}

/** 计算一支舰队的总点数成本 */
export function fleetCost(fleet: FleetEntry[]): number {
  let sum = 0;
  for (const e of fleet) {
    const cost = VARIANTS[e.variant]?.cost ?? VARIANTS.standard.cost;
    sum += cost * Math.max(0, Math.floor(e.count || 0));
  }
  return sum;
}

/** 取改型定义（未知回退 standard） */
export function getVariantDef(variant: ShipVariant): VariantDef {
  return VARIANTS[variant] ?? VARIANTS.standard;
}
