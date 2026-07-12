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
export function validateFleetEntry(entry: unknown): ValidationResult {
  const errors: string[] = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['编队项不是对象'] };
  }
  const value = entry as Record<string, unknown>;
  const shipClass = value.shipClass;
  const variant = value.variant;
  const count = value.count;

  // shipClass 检查
  if (!KNOWN_CLASSES.includes(shipClass as ShipClass)) {
    errors.push(`未知舰种：${String(shipClass)}`);
    return { valid: false, errors };
  }

  // variant 检查
  if (!ALL_VARIANTS.includes(variant as ShipVariant)) {
    errors.push(`未知改型：${String(variant)}`);
    return { valid: false, errors };
  }

  const allowed = VARIANTS_BY_CLASS[shipClass as ShipClass];
  if (!allowed.includes(variant as ShipVariant)) {
    errors.push(`非法舰船改型组合：${shipClass} / ${variant}`);
  }

  // count 检查
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    errors.push(`数量不是有限数值：${String(count)}`);
  } else if (!Number.isInteger(count)) {
    errors.push(`数量不是整数：${count}`);
  } else if (count <= 0) {
    errors.push(`数量必须为正整数：${count}`);
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
export function validateFleet(fleet: unknown): ValidationResult {
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
      errors.push(`条目 #${i}：${r.errors.join('；')}`);
    }

    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;

    // 重复检查
    const key = `${String(value.shipClass)}:${String(value.variant)}`;
    if (seen.has(key)) {
      errors.push(`重复条目：${String(value.shipClass)}/${String(value.variant)}（建议合并）`);
    }
    seen.add(key);

    if (typeof value.count === 'number' && Number.isFinite(value.count) && value.count > 0) {
      totalCount += Math.floor(value.count);
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
export function assertValidFleetEntry(entry: unknown): asserts entry is FleetEntry {
  const r = validateFleetEntry(entry);
  if (!r.valid) {
    throw new Error(`非法 FleetEntry：${r.errors.join('；')}`);
  }
}

/**
 * 断言整个舰队合法（开发/测试模式）。
 * 非法时直接抛错，不静默回退。
 */
export function assertValidFleet(fleet: unknown): asserts fleet is FleetEntry[] {
  const r = validateFleet(fleet);
  if (!r.valid) {
    throw new Error(`非法舰队配置：${r.errors.join('；')}`);
  }
}

/**
 * 规范化舰队：仅合并已通过单项校验的重复条目。
 * 不改变 variant、不转换数量；任何非法配置都会抛错。
 */
export function normalizeFleet(fleet: FleetEntry[]): FleetEntry[] {
  if (!Array.isArray(fleet)) throw new Error('舰队配置不是数组');
  for (const entry of fleet) assertValidFleetEntry(entry);

  const map = new Map<string, FleetEntry>();
  for (const entry of fleet) {
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

/**
 * 从外部输入严格解析舰队。此函数不补默认值、不转换数量，也不丢弃非法条目。
 * Replay、Fleet Code、本地存储和 UI 边界统一从这里进入。
 */
export function parseFleet(raw: unknown): FleetEntry[] {
  assertValidFleet(raw);
  return raw.map((entry) => ({ ...entry }));
}
