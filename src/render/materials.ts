// 阵营材质系统 + 组件损伤配色。
// 从 shipMeshFactory 抽出，供飞船模型与预览复用。
// 所有颜色均为金属太空战舰风格；损伤配色遵循：蓝灰 → 黄 → 橙红 → 暗红 → 焦黑。

import * as THREE from 'three';
import { Team } from '../sim/battleTypes';

export type MaterialRole =
  | 'hull' // 主舰体
  | 'armor' // 装甲板
  | 'turret' // 炮塔基座
  | 'weapon' // 武器炮管
  | 'bridge' // 舰桥
  | 'sensor' // 传感器 / 雷达
  | 'engine' // 引擎喷管
  | 'engineGlow' // 引擎尾焰（自发光）
  | 'accent' // 阵营识别色
  | 'detail'; // 细节构件

export interface TeamPalette {
  hull: number;
  armor: number;
  turret: number;
  weapon: number;
  bridge: number;
  bridgeEmissive: number;
  sensor: number;
  sensorEmissive: number;
  engine: number;
  engineGlow: number;
  accent: number;
  accentEmissive: number;
  detail: number;
}

// Team A — 冷色阵营（蓝灰 / 青蓝）
export const PALETTE_A: TeamPalette = {
  hull: 0x2b3848,
  armor: 0x3a4658,
  turret: 0x4a5668,
  weapon: 0x556070,
  bridge: 0x3a6890,
  bridgeEmissive: 0x1a3a5a,
  sensor: 0x44ccdd,
  sensorEmissive: 0x2288aa,
  engine: 0x2a3040,
  engineGlow: 0x44aaff,
  accent: 0x3380bb,
  accentEmissive: 0x114466,
  detail: 0x1a2030
};

// Team B — 暖色阵营（暗红 / 橙红）
export const PALETTE_B: TeamPalette = {
  hull: 0x482b2b,
  armor: 0x583a3a,
  turret: 0x684a4a,
  weapon: 0x705560,
  bridge: 0x903a3a,
  bridgeEmissive: 0x5a1a1a,
  sensor: 0xddaa44,
  sensorEmissive: 0xaa6622,
  engine: 0x402a2a,
  engineGlow: 0xff8844,
  accent: 0xbb3333,
  accentEmissive: 0x661111,
  detail: 0x301a1a
};

export function palette(team: Team): TeamPalette {
  return team === 'A' ? PALETTE_A : PALETTE_B;
}

/** 引擎尾焰的基础自发光强度（threeScene 会按引擎 HP 动态调整） */
export const GLOW_BASE_INTENSITY = 2.5;

/** 创建指定阵营与角色的标准材质（每次返回新实例） */
export function makeMaterial(team: Team, role: MaterialRole): THREE.MeshStandardMaterial {
  const p = palette(team);
  switch (role) {
    case 'hull':
      return new THREE.MeshStandardMaterial({ color: p.hull, metalness: 0.75, roughness: 0.45 });
    case 'armor':
      return new THREE.MeshStandardMaterial({ color: p.armor, metalness: 0.8, roughness: 0.35 });
    case 'turret':
      return new THREE.MeshStandardMaterial({ color: p.turret, metalness: 0.7, roughness: 0.4 });
    case 'weapon':
      return new THREE.MeshStandardMaterial({ color: p.weapon, metalness: 0.85, roughness: 0.3 });
    case 'bridge':
      return new THREE.MeshStandardMaterial({
        color: p.bridge,
        metalness: 0.4,
        roughness: 0.15,
        emissive: p.bridgeEmissive,
        emissiveIntensity: 0.6
      });
    case 'sensor':
      return new THREE.MeshStandardMaterial({
        color: p.sensor,
        metalness: 0.5,
        roughness: 0.2,
        emissive: p.sensorEmissive,
        emissiveIntensity: 1.2
      });
    case 'engine':
      return new THREE.MeshStandardMaterial({ color: p.engine, metalness: 0.8, roughness: 0.4 });
    case 'engineGlow':
      return new THREE.MeshStandardMaterial({
        color: p.engineGlow,
        emissive: p.engineGlow,
        emissiveIntensity: GLOW_BASE_INTENSITY,
        metalness: 0,
        roughness: 1
      });
    case 'accent':
      return new THREE.MeshStandardMaterial({
        color: p.accent,
        metalness: 0.6,
        roughness: 0.3,
        emissive: p.accentEmissive,
        emissiveIntensity: 0.5
      });
    case 'detail':
      return new THREE.MeshStandardMaterial({ color: p.detail, metalness: 0.7, roughness: 0.5 });
    default:
      return new THREE.MeshStandardMaterial({ color: 0x444444 });
  }
}

// ======================== 损伤配色系统 ========================

/**
 * 根据损伤比例返回组件颜色（蓝灰 → 黄 → 橙 → 红 → 黑）。
 * 兼容旧接口，供需要纯颜色的场景使用。
 */
export function damageColor(ratio: number, destroyed: boolean): THREE.Color {
  if (destroyed || ratio <= 0) return new THREE.Color(0x1a1a1e);
  if (ratio >= 0.75) return new THREE.Color(0x6b7a99);
  if (ratio >= 0.5) return new THREE.Color(0xc4b032);
  if (ratio >= 0.25) return new THREE.Color(0xc04422);
  return new THREE.Color(0x802020);
}

/**
 * 根据基础材质和 HP 比例返回损伤后的材质（克隆后调整）。
 *
 * 规则：
 *   hpRatio >= 0.75   — 正常材质
 *   0.5 <= hp < 0.75  — 略微发黄
 *   0.25 <= hp < 0.5  — 橙红色
 *   0 < hp < 0.25     — 暗红色 + 轻微 emissive
 *   hp <= 0           — 黑色 / 深灰（摧毁）
 */
export function getDamageMaterial(
  base: THREE.MeshStandardMaterial,
  hpRatio: number
): THREE.MeshStandardMaterial {
  const m = base.clone();

  if (hpRatio <= 0) {
    m.color.set(0x141418);
    m.emissive.set(0x000000);
    m.emissiveIntensity = 0;
    return m;
  }

  if (hpRatio >= 0.75) {
    return m; // 正常，无需调整
  }

  const origColor = m.color.clone();
  const origEmissive = m.emissive.clone();
  const origEmI = m.emissiveIntensity;

  let tint: number;
  let amount: number;
  let emFactor: number;

  if (hpRatio >= 0.5) {
    tint = 0xccbb33;
    amount = 0.25;
    emFactor = 0.7;
  } else if (hpRatio >= 0.25) {
    tint = 0xcc4422;
    amount = 0.5;
    emFactor = 0.4;
  } else {
    tint = 0x882222;
    amount = 0.75;
    emFactor = 0.15;
  }

  m.color.copy(origColor).lerp(new THREE.Color(tint), amount);
  m.emissive.copy(origEmissive);
  m.emissiveIntensity = origEmI * emFactor;
  return m;
}

// 模块级临时变量（避免每帧创建 Color 对象产生 GC 压力）
const _tmpTint = new THREE.Color();
const _tmpOut = new THREE.Color();
const _tmpEm = new THREE.Color();

/**
 * 高效更新单个 Mesh 的损伤外观（直接修改材质属性，不克隆）。
 * 供 ThreeScene 每帧调用。
 */
export function applyDamageToMesh(
  mesh: THREE.Mesh,
  hpRatio: number,
  destroyed: boolean
): void {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  const baseColor = mesh.userData.baseColor as THREE.Color | undefined;
  const baseEmissive = mesh.userData.baseEmissive as THREE.Color | undefined;
  const baseEmI = (mesh.userData.baseEmissiveIntensity as number | undefined) ?? 0;

  if (destroyed || hpRatio <= 0) {
    mat.color.set(0x141418);
    mat.emissive.set(0x000000);
    mat.emissiveIntensity = 0;
    return;
  }

  if (!baseColor) return; // 没有存储基础色，跳过

  let tint: number;
  let amount: number;
  let emFactor: number;

  if (hpRatio >= 0.75) {
    // 正常 — 恢复基础色
    mat.color.copy(baseColor);
    if (baseEmissive) mat.emissive.copy(baseEmissive);
    mat.emissiveIntensity = baseEmI;
    return;
  } else if (hpRatio >= 0.5) {
    tint = 0xccbb33;
    amount = 0.25;
    emFactor = 0.7;
  } else if (hpRatio >= 0.25) {
    tint = 0xcc4422;
    amount = 0.5;
    emFactor = 0.4;
  } else {
    tint = 0x882222;
    amount = 0.75;
    emFactor = 0.15;
  }

  _tmpTint.set(tint);
  _tmpOut.copy(baseColor);
  _tmpOut.lerp(_tmpTint, amount);
  mat.color.copy(_tmpOut);

  if (baseEmissive) {
    _tmpEm.copy(baseEmissive);
    mat.emissive.copy(_tmpEm);
  }
  mat.emissiveIntensity = baseEmI * emFactor;
}
