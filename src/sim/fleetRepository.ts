// 舰队方案本地仓库：基于 localStorage，无后端。
//
// 职责：
//   - 读取时遇到损坏数据不崩溃，返回明确错误提示（"本地舰队方案数据无效"）。
//   - 保存/重命名/复制/删除均做 JSON 序列化与基本校验。
//   - 不依赖任何战斗/渲染逻辑；FleetPreset 结构与 replay code 完全无关。
//
// 所有函数的 localStorage 访问都被 try/catch 包裹；非浏览器环境（如测试）安全降级。

import { FleetPreset, FLEET_PRESET_SCHEMA, newFleetId } from './fleetPreset';

const STORAGE_KEY = 'spacewar:fleetPresets';

export interface LoadResult {
  ok: boolean;
  presets: FleetPreset[];
  /** 读取/解析失败时的提示（ok=false 时存在） */
  error?: string;
}

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/** 把一个未知对象校验为合法的 FleetPreset（不合法项会被丢弃） */
function sanitize(raw: unknown): FleetPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fleet = Array.isArray(o.fleet) ? o.fleet : null;
  if (!fleet) return null;
  const name = typeof o.name === 'string' && o.name ? o.name : '未命名舰队';
  let fleetArr: FleetPreset['fleet'] = [];
  try {
    // 复用 fleetPreset.normalizeFleet 的语义（此处内联以避免循环导入带来的体积问题）
    fleetArr = (fleet as unknown[])
      .map((it) => {
        const i = (it ?? {}) as Record<string, unknown>;
        const cls = i.shipClass;
        if (cls !== 'Fighter' && cls !== 'Frigate' && cls !== 'Cruiser') return null;
        const count = Math.max(0, Math.floor(Number(i.count)));
        if (count <= 0) return null;
        const variant = typeof i.variant === 'string' ? i.variant : 'standard';
        return { shipClass: cls as FleetPreset['fleet'][number]['shipClass'], variant: variant as any, count };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  } catch {
    return null;
  }
  if (fleetArr.length === 0) return null;
  const formation = (['line', 'wedge', 'wall', 'swarm', 'random'] as const).includes(
    o.formation as any
  )
    ? (o.formation as FleetPreset['formation'])
    : 'line';
  const doctrine = (['balanced', 'aggressive', 'defensive', 'kite', 'focusFire', 'antiCapital', 'screen'] as const).includes(
    o.doctrine as any
  )
    ? (o.doctrine as FleetPreset['doctrine'])
    : 'balanced';
  return {
    schemaVersion: typeof o.schemaVersion === 'number' ? o.schemaVersion : FLEET_PRESET_SCHEMA,
    id: typeof o.id === 'string' && o.id ? o.id : newFleetId(),
    name,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    fleet: fleetArr,
    formation,
    doctrine,
    notes: typeof o.notes === 'string' ? o.notes : ''
  };
}

/** 读取全部本地舰队方案；损坏时返回 ok=false 与明确错误提示 */
export function loadPresets(): LoadResult {
  if (!hasStorage()) return { ok: true, presets: [] };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { ok: true, presets: [] };
  }
  if (!raw) return { ok: true, presets: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, presets: [], error: '本地舰队方案数据无效（无法解析 JSON）' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, presets: [], error: '本地舰队方案数据无效（根节点不是数组）' };
  }
  const out: FleetPreset[] = [];
  for (const item of parsed) {
    const p = sanitize(item);
    if (p) out.push(p);
  }
  // 数组存在但全部项无效也视为损坏
  if (parsed.length > 0 && out.length === 0) {
    return { ok: false, presets: [], error: '本地舰队方案数据无效（没有可读的有效方案）' };
  }
  return { ok: true, presets: out };
}

function persist(presets: FleetPreset[]): string | null {
  if (!hasStorage()) return null;
  // 去除不需要持久化的运行时字段前先深拷贝（不修改调用方传入对象）
  const safe = presets.map((p) => ({
    schemaVersion: p.schemaVersion,
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    fleet: p.fleet.map((e) => ({ ...e })),
    formation: p.formation,
    doctrine: p.doctrine,
    notes: p.notes
  }));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    return null;
  } catch (e) {
    return '本地存储写入失败：' + ((e as Error)?.message ?? '未知错误');
  }
}

/** 保存（新增或更新：按 id 合并）。返回 null 表示成功，字符串为错误提示。 */
export function savePreset(preset: FleetPreset): string | null {
  const { presets } = loadPresets();
  const idx = presets.findIndex((p) => p.id === preset.id);
  const next: FleetPreset = {
    ...preset,
    fleet: preset.fleet.map((e) => ({ ...e })),
    updatedAt: Date.now()
  };
  if (idx >= 0) presets[idx] = next;
  else presets.push(next);
  return persist(presets);
}

/** 删除（按 id）。返回 null 表示成功，字符串为错误提示。 */
export function deletePreset(id: string): string | null {
  const { presets } = loadPresets();
  return persist(presets.filter((p) => p.id !== id));
}

/** 重命名（按 id），同时刷新 updatedAt。返回 null 表示成功，字符串为错误提示。 */
export function renamePreset(id: string, name: string): string | null {
  const { presets } = loadPresets();
  const p = presets.find((x) => x.id === id);
  if (!p) return '未找到该方案';
  p.name = name;
  p.updatedAt = Date.now();
  return persist(presets);
}

/** 复制：生成新 id 与"（副本）"后缀名称，保留舰队配置。
 *  返回 null 表示成功，字符串为错误提示。 */
export function duplicatePreset(id: string): string | null {
  const { presets } = loadPresets();
  const src = presets.find((x) => x.id === id);
  if (!src) return '未找到该方案';
  const copy: FleetPreset = {
    schemaVersion: src.schemaVersion,
    id: newFleetId(),
    name: uniqueName(src.name + '（副本）', presets),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fleet: src.fleet.map((e) => ({ ...e })),
    formation: src.formation,
    doctrine: src.doctrine,
    notes: src.notes
  };
  presets.push(copy);
  return persist(presets);
}

/** 若名称与现有重复，自动追加序号保证可读（仍允许保存） */
export function uniqueName(name: string, presets: FleetPreset[]): string {
  const base = name.trim() || '未命名舰队';
  const taken = new Set(presets.map((p) => p.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

/** 清空全部（谨慎使用，调用方需二次确认） */
export function clearAll(): void {
  if (!hasStorage()) return;
  localStorage.removeItem(STORAGE_KEY);
}
