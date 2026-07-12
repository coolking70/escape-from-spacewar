// 舰队方案（FleetPreset）数据层：与战斗录像码（ReplayConfig）完全独立的数据类型。
//
// 设计：
//   - FleetPreset 只描述"单支舰队"（fleet + formation + doctrine + notes），不含 seed / 对方舰队 / 预算上限。
//   - fleet code 使用 JSON + base64url，且必须带 type: "spacewar-fleet"，
//     以此与战斗录像码（type 缺省或 "spacewar-battle"、含 teamA/teamB）明确区分。
//   - 该数据只用于"保存/载入/分享单支舰队"，不写入 replay code，不影响战斗结果。

import {
  FleetEntry,
  ShipClass,
  ShipVariant,
  FormationType,
  DoctrineType
} from './battleTypes';
import { VARIANTS_BY_CLASS } from './shipVariants';
import { validateFleet } from './fleetValidator';

/** 舰队方案 schema 版本 */
export const FLEET_PRESET_SCHEMA = 1;
/** fleet code 类型标识（与 battle replay code 区分） */
export const FLEET_CODE_TYPE = 'spacewar-fleet';
/** fleet code 版本 */
export const FLEET_CODE_V = '1';

export interface FleetPreset {
  schemaVersion: number;
  /** 用户本地唯一 ID（localStorage 用，导入/导出时重新生成） */
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  fleet: FleetEntry[];
  formation: FormationType;
  doctrine: DoctrineType;
  notes: string;
}

function toBase64Url(str: string): string {
  // UTF-8 安全：先转成字节再 base64，避免中文等字符触发 btoa 的 "Invalid character"
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const FORMATIONS: FormationType[] = ['line', 'wedge', 'wall', 'swarm', 'random'];
const DOCTRINES: DoctrineType[] = [
  'balanced',
  'aggressive',
  'defensive',
  'kite',
  'focusFire',
  'antiCapital',
  'screen'
];
const CLASSES: ShipClass[] = ['Fighter', 'Frigate', 'Cruiser'];

function asFormation(v: unknown): FormationType {
  return FORMATIONS.includes(v as FormationType) ? (v as FormationType) : 'line';
}
function asDoctrine(v: unknown): DoctrineType {
  return DOCTRINES.includes(v as DoctrineType) ? (v as DoctrineType) : 'balanced';
}
function asClass(v: unknown): ShipClass | null {
  return CLASSES.includes(v as ShipClass) ? (v as ShipClass) : null;
}
function asVariant(cls: ShipClass, v: unknown): ShipVariant {
  const allowed = VARIANTS_BY_CLASS[cls];
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as ShipVariant;
  throw new Error(`非法舰船改型组合：${cls} / ${v}`);
}

/** 生成本地唯一 ID（基于时间 + 随机，纯本地、不依赖后端） */
export function newFleetId(): string {
  return 'fp_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

/** 规范化一条 fleet 数组（非法舰种/改型直接抛错，不静默跳过） */
export function normalizeFleet(raw: unknown): FleetEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FleetEntry[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const cls = asClass(o.shipClass);
    if (!cls) throw new Error(`未知舰种：${String(o.shipClass)}`);
    const variant = asVariant(cls, o.variant);
    const count = Math.max(0, Math.floor(Number(o.count)));
    if (count > 0) out.push({ shipClass: cls, variant, count });
  }
  return out;
}

/** 校验某个对象是否像 battle replay code（用于类型区分提示） */
function looksLikeReplay(obj: unknown): boolean {
  const o = obj as Record<string, unknown>;
  if (!o || typeof o !== 'object') return false;
  if (o.type === 'spacewar-battle') return true;
  // 含 teamA/teamB 且非 fleet 结构的，判定为战斗录像码
  if (o.teamA && typeof o.teamA === 'object' && (o.teamA as Record<string, unknown>).fleet !== undefined) {
    return true;
  }
  if (o.teamB && typeof o.teamB === 'object') return true;
  return false;
}

/** 编码为可分享的 fleet code（含 type 标识） */
export function encodeFleet(preset: FleetPreset): string {
  const json = JSON.stringify({
    type: FLEET_CODE_TYPE,
    v: FLEET_CODE_V,
    name: preset.name,
    fleet: preset.fleet,
    formation: preset.formation,
    doctrine: preset.doctrine,
    notes: preset.notes
  });
  return toBase64Url(json);
}

/** 由 fleet code 解码为 FleetPreset。
 *  若粘贴的是战斗录像码，则抛出明确提示（"这是一段战斗录像码，不是舰队方案码"）。 */
export function decodeFleet(code: string): FleetPreset {
  if (!code || !code.trim()) throw new Error('舰队方案码为空');
  let obj: any;
  try {
    obj = JSON.parse(fromBase64Url(code.trim()));
  } catch {
    throw new Error('舰队方案码格式无法解析');
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('舰队方案码内容无效');
  if (obj.type && obj.type !== FLEET_CODE_TYPE) {
    if (obj.type === 'spacewar-battle' || looksLikeReplay(obj)) {
      throw new Error('这是一段战斗录像码，不是舰队方案码');
    }
    throw new Error('未知的方案码类型');
  }
  if (looksLikeReplay(obj)) {
    throw new Error('这是一段战斗录像码，不是舰队方案码');
  }
  const fleet = normalizeFleet(obj.fleet);
  if (fleet.length === 0) throw new Error('舰队方案码中没有任何有效舰船');
  // 严格校验舰队组合
  const vr = validateFleet(fleet);
  if (!vr.valid) throw new Error(`舰队方案码中存在无效配置：${vr.errors.join('；')}`);
  return {
    schemaVersion: FLEET_PRESET_SCHEMA,
    id: newFleetId(),
    name: typeof obj.name === 'string' && obj.name ? obj.name : '导入的舰队',
    createdAt: 0,
    updatedAt: 0,
    fleet,
    formation: asFormation(obj.formation),
    doctrine: asDoctrine(obj.doctrine),
    notes: typeof obj.notes === 'string' ? obj.notes : ''
  };
}

/** 由当前 UI 的舰队配置（fleet + formation + doctrine + 名称/备注）构造一个 FleetPreset 草稿 */
export function makeFleetPreset(opts: {
  name: string;
  fleet: FleetEntry[];
  formation: FormationType;
  doctrine: DoctrineType;
  notes?: string;
  id?: string;
  createdAt?: number;
}): FleetPreset {
  const now = Date.now();
  return {
    schemaVersion: FLEET_PRESET_SCHEMA,
    id: opts.id ?? newFleetId(),
    name: opts.name,
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
    fleet: opts.fleet.map((e) => ({ ...e })),
    formation: opts.formation,
    doctrine: opts.doctrine,
    notes: opts.notes ?? ''
  };
}
