// core-v4 轻量转向（steering）：不使用物理引擎，只在 XZ 平面合成若干力。
// 纯函数（不消耗 PRNG，不读取渲染 / 真实时间），由模拟器在固定 tick 调用。
//
// 力构成（来自 V0.5.1 规范）：
//   targetForce    朝/离目标（取决于理想交火距离带）
//   separationForce 友军排斥（避免重叠，由调用方按 shipId 稳定顺序累加）
//   cohesionForce  朝本方质心（保持结构）
//   anchorForce    朝 anchor（defensive / screen 较强）
//   retreatForce   朝本方出生边界（retreating 时）
//   lateralForce  沿目标切向（确定性 side sign，避免全体同向抖动）

import { Ship, Vec3, DoctrineType } from './battleTypes';

export interface SteerContext {
  ship: Ship;
  target: Ship | null;
  doc: DoctrineType;
  /** 本方质心（无则为 null） */
  centroid: Vec3 | null;
  /** 已归一化的分离合力方向（无邻居则为 0 向量） */
  separation: Vec3;
  /** 横向方向确定性符号：+1 / -1（由 shipId 决定，不随 tick 抖动） */
  lateralSign: number;
  /** 是否正在撤退（此时朝出生边界移动） */
  retreating: boolean;
  /** 撤退目标 x：本方出生边界再向外 ESCAPE_MARGIN+缓冲（A 为负，B 为正） */
  escapeTargetX: number;
}

export interface SteerResult {
  /** 归一化后的期望移动方向（XZ 平面，y=0） */
  dir: Vec3;
  /** 速度系数 0~1（乘 effectiveSpeed） */
  speedFactor: number;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: 0, z: a.z - b.z };
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, y: 0, z: v.z / l };
}
function len(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

const SEP_W = 0.9;
const COH_W = 0.18;
const ANCHOR_W = 0.5;
const LAT_W = 0.32;

/** 合成转向：返回期望方向与速度系数。保证确定性（仅依赖输入，无随机）。 */
export function computeSteering(ctx: SteerContext): SteerResult {
  const { ship, target, doc, centroid, separation, lateralSign, retreating, escapeTargetX } = ctx;
  const forces: Vec3[] = [];
  let speedFactor = 1;

  // ---- 撤退优先：朝出生边界再向外（越过点即脱战，不触发爆炸） ----
  if (retreating) {
    // 撤退时忽略友军分离力：否则后方友舰的分离力会抵消逃离方向，导致卡在原地无法脱战
    const away = norm({ x: escapeTargetX - ship.pos.x, y: 0, z: 0 });
    forces.push({ x: away.x * 1.5, y: 0, z: away.z * 1.5 });
    const sum = addAll(forces);
    // 撤退时略微提速，使其能真正脱离追兵抵达边界（否则会被持续点射至毁）
    return { dir: norm(sum), speedFactor: 1.3 };
  }

  if (!target) {
    // 无目标：朝质心/锚点保持队形，或原地维持
    if (centroid) {
      const toC = sub(centroid, ship.pos);
      if (len(toC) > 3) forces.push({ x: norm(toC).x * COH_W, y: 0, z: norm(toC).z * COH_W });
    }
    if (len(separation) > 0) forces.push({ x: separation.x * SEP_W, y: 0, z: separation.z * SEP_W });
    const sum = addAll(forces);
    const d = norm(sum);
    return { dir: d, speedFactor: 0.4 };
  }

  const toT = norm(sub(target.pos, ship.pos));
  const d = len(sub(target.pos, ship.pos));
  const dr = desiredBand(ship, doc);

  const tooClose = d < dr * 0.72;
  const inBand = d <= dr * 1.08 && d >= dr * 0.72;
  const tooFar = d > dr * 1.08;

  if (tooClose && (doc === 'defensive' || doc === 'kite' || doc === 'screen')) {
    // 太近：后撤（朝远离目标）
    forces.push({ x: -toT.x, y: 0, z: -toT.z });
    speedFactor = 1;
  } else if (tooFar) {
    // 太远：接近
    forces.push({ x: toT.x, y: 0, z: toT.z });
    speedFactor = 1;
  } else if (inBand) {
    // 理想距离带：基本停步，仅做横向 + 分离微调，显著降低抖动
    speedFactor = 0.3;
  }

  // ---- 横向切向（确定性 sign） ----
  const tangent = { x: -toT.z * lateralSign, y: 0, z: toT.x * lateralSign };
  forces.push({ x: tangent.x * LAT_W, y: 0, z: tangent.z * LAT_W });

  // ---- 分离（防重叠） ----
  if (len(separation) > 0) {
    forces.push({ x: separation.x * SEP_W, y: 0, z: separation.z * SEP_W });
  }

  // ---- 队形保持 / 锚点 ----
  if (centroid) {
    const toC = sub(centroid, ship.pos);
    const cw = doc === 'defensive' || doc === 'screen' ? ANCHOR_W : COH_W;
    if (len(toC) > 3) forces.push({ x: norm(toC).x * cw, y: 0, z: norm(toC).z * cw });
  }

  const sum = addAll(forces);
  if (len(sum) < 1e-6) {
    // 合力接近 0：原地保持（避免 NaN / 抖动）
    return { dir: { x: 1, y: 0, z: 0 }, speedFactor: 0 };
  }
  return { dir: norm(sum), speedFactor };
}

/** 理想交火距离带中心（取最远武器射程 × 舰种/战术系数） */
export function desiredBand(ship: Ship, doc: DoctrineType): number {
  let maxR = 0;
  for (const c of ship.components) {
    if (c.def.weapon && !c.destroyed) maxR = Math.max(maxR, c.def.weapon.range);
  }
  if (maxR === 0) maxR = ship.effectiveRange;
  const tf = ship.type === 'Cruiser' ? 0.98 : ship.type === 'Frigate' ? 0.9 : 0.82;
  const df =
    doc === 'aggressive' ? 0.78 : doc === 'defensive' ? 1.18 : doc === 'kite' ? 1.12 : doc === 'focusFire' ? 0.95 : doc === 'antiCapital' ? 1.0 : doc === 'screen' ? 0.9 : 1.0;
  return maxR * tf * df;
}

function addAll(vs: Vec3[]): Vec3 {
  let x = 0;
  let z = 0;
  for (const v of vs) {
    x += v.x;
    z += v.z;
  }
  return { x, y: 0, z };
}
