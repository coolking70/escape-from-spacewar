// 严格 FleetEntry 校验模块。
// 提供两种模式：
//   - 用户导入模式：返回结构化错误信息，不抛异常
//   - 开发/测试模式：直接抛错，禁止自动回退
// replay 编解码、舰队方案、预设、Balance Lab、测试配置都应复用本模块。

import { FleetEntry, ShipClass, ShipVariant } from './battleTypes';
import { VARIANTS_BY_CLASS } from './shipVariants';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** 合法的 ShipClass 集合 */
const KNOWN_CLASSES: ShipClass[] = ['Fighter', 'Frigate', 'Cruiser'];

/** 所有已知 variant */
const ALL_VARIANTS: ShipVariant[] = [
  'standard', 'interceptor', 'bomber', 'scout',
  'escort', 'artillery', 'support',
  'battleship', 'carrier', 'fortress'
];

/** 合理的舰队总舰船上限（防止意外构造超大舰队导致卡死） */
export const MAX_FLEET_SHIPS = 200;

/**
 * 校验单个 FleetEntry。
 * 检查内容：
 * 1. shipClass 是否已知。
 * 2. variant 是否属于对应 shipClass。
 * 3. count 是否为有限正整数。
 */
export function validateFleetEntry(entry: FleetEntry): ValidationResult {
  const errors: string[] = [];

  // shipClass 检查
  if (!KNOWN_CLASSES.includes(entry.shipClass)) {
    errors.push(`未知舰种：${String(entry.shipClass)}`);
    return { valid: false, errors };
  }

  // variant 检查
  if (!ALL_VARIANTS.includes(entry.variant)) {
    errors.push(`未知改型：${String(entry.variant)}`);
    return { valid: false, errors };
  }

  const allowed = VARIANTS_BY_CLASS[entry.shipClass];
  if (!allowed.includes(entry.variant)) {
    errors.push(`非法舰船改型组合：${entry.shipClass} / ${entry.variant}`);
  }

  // count 检查
  if (typeof entry.count !== 'number' || !Number.isFinite(entry.count)) {
    errors.push(`数量不是有限数值：${String(entry.count)}`);
  } else if (!Number.isInteger(entry.count)) {
    errors.push(`数量不是整数：${entry.count}`);
  } else if (entry.count <= 0) {
    errors.push(`数量必须为正整数：${entry.count}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 校验整个舰队。
 * 检查内容：
 * 1. 每个条目通过 validateFleetEntry。
 * 2. 是否存在空舰队。
 * 3. 是否有重复条目（同 shipClass + variant）。
 * 4. 总舰船数量是否超过合理上限。
 */
export function validateFleet(fleet: FleetEntry[]): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(fleet)) {
    return { valid: false, errors: ['舰队配置不是数组'] };
  }

  if (fleet.length === 0) {
    return { valid: false, errors: ['舰队为空'] };
  }

  let totalCount = 0;
  const seen = new Set<string>();

  for (let i = 0; i < fleet.length; i++) {
    const entry = fleet[i];
    const r = validateFleetEntry(entry);
    if (!r.valid) {
      errors.push(`条目 #${i}（${entry.shipClass}/${entry.variant}×${entry.count}）：${r.errors.join('；')}`);
    }

    // 重复检查
    const key = `${entry.shipClass}:${entry.variant}`;
    if (seen.has(key)) {
      errors.push(`重复条目：${entry.shipClass}/${entry.variant}（建议合并）`);
    }
    seen.add(key);

    if (Number.isFinite(entry.count) && entry.count > 0) {
      totalCount += Math.floor(entry.count);
    }
  }

  if (totalCount > MAX_FLEET_SHIPS) {
    errors.push(`总舰船数 ${totalCount} 超过上限 ${MAX_FLEET_SHIPS}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 断言单个 FleetEntry 合法（开发/测试模式）。
 * 非法时直接抛错，不静默回退。
 */
export function assertValidFleetEntry(entry: FleetEntry): void {
  const r = validateFleetEntry(entry);
  if (!r.valid) {
    throw new Error(`非法 FleetEntry：${r.errors.join('；')}`);
  }
}

/**
 * 断言整个舰队合法（开发/测试模式）。
 * 非法时直接抛错，不静默回退。
 */
export function assertValidFleet(fleet: FleetEntry[]): void {
  const r = validateFleet(fleet);
  if (!r.valid) {
    throw new Error(`非法舰队配置：${r.errors.join('；')}`);
  }
}

/**
 * 规范化舰队：合并重复条目，过滤 count<=0 的条目。
 * 不改变合法条目的 variant（不做静默回退）。
 * 如果存在非法组合，抛错。
 */
export function normalizeFleet(fleet: FleetEntry[]): FleetEntry[] {
  const r = validateFleet(fleet);
  if (!r.valid) {
    // 允许重复和空舰队以外的错误通过，只拒绝非法组合
    const hardErrors = r.errors.filter(
      (e) => e.includes('非法舰船改型组合') || e.includes('未知舰种') || e.includes('未知改型') || e.includes('不是有限数值')
    );
    if (hardErrors.length > 0) {
      throw new Error(hardErrors.join('；'));
    }
  }

  const map = new Map<string, FleetEntry>();
  for (const entry of fleet) {
    if (!Number.isFinite(entry.count) || entry.count <= 0) continue;
    const key = `${entry.shipClass}:${entry.variant}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += Math.floor(entry.count);
    } else {
      map.set(key, { ...entry, count: Math.floor(entry.count) });
    }
  }

  return Array.from(map.values());
}
