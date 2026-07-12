// Replay Code 编解码。
// ReplayConfig = { v, ruleset, seed, budget, teamA: TeamConfig, teamB: TeamConfig }
//   TeamConfig = { fleet: FleetEntry[], formation, doctrine }
// 仅支持 v0.5 与 spacewar-core-v4。

import {
  FleetEntry,
  ReplayConfig,
  TeamConfig,
  FormationType,
  DoctrineType,
  BudgetConfig,
  ShipVariant
} from './battleTypes';
import { RULESET_V4, DEFAULT_BUDGET_LIMIT } from './battleConfig';
import { VARIANTS } from './shipVariants';
import { assertValidFleet, parseFleet } from './fleetValidator';

/** 受支持的战斗规则集（未知 ruleset 必须报错，不得静默回退到最新版）。 */
export const KNOWN_RULESETS: string[] = ['spacewar-core-v4'];

/** 显式 replay 版本 → 规则集映射表。 */
export const REPLAY_VERSION_RULESET: Record<string, string> = {
  '0.5': 'spacewar-core-v4'
};

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

function asFormation(v: unknown): FormationType {
  return FORMATIONS.includes(v as FormationType) ? (v as FormationType) : 'line';
}
function asDoctrine(v: unknown): DoctrineType {
  return DOCTRINES.includes(v as DoctrineType) ? (v as DoctrineType) : 'balanced';
}
/** 把 team 结构规范化为 TeamConfig（v0.5：仅接受 fleet 数组格式） */
function normalizeTeam(raw: unknown): TeamConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.fleet)) {
    throw new Error('舰队数据格式不支持：仅接受 v0.5 fleet 数组格式');
  }
  return {
    fleet: parseFleet(o.fleet),
    formation: asFormation(o.formation),
    doctrine: asDoctrine(o.doctrine)
  };
}

/** 解析 budget 配置（缺省按 legacy / 无限） */
function normalizeBudget(raw: unknown): BudgetConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.mode;
  if (mode === 'limited' || mode === 'unlimited' || mode === 'legacy') {
    const limit = Number(o.limit);
    return {
      mode,
      limit: isFinite(limit) && limit > 0 ? limit : DEFAULT_BUDGET_LIMIT
    };
  }
  return { mode: 'legacy', limit: DEFAULT_BUDGET_LIMIT };
}

function fleetTotal(fleet: FleetEntry[]): number {
  return fleet.reduce((s, e) => s + Math.max(0, Math.floor(e.count || 0)), 0);
}

export function encodeReplay(cfg: ReplayConfig): string {
  assertValidFleet(cfg.teamA.fleet);
  assertValidFleet(cfg.teamB.fleet);
  const budget = cfg.budget ?? { mode: 'legacy', limit: DEFAULT_BUDGET_LIMIT };
  const json = JSON.stringify({
    v: cfg.v,
    // 编码固定使用 v0.5 + core-v4
    ruleset: cfg.ruleset ?? RULESET_V4,
    seed: cfg.seed >>> 0,
    budget,
    teamA: {
      fleet: cfg.teamA.fleet,
      formation: cfg.teamA.formation,
      doctrine: cfg.teamA.doctrine
    },
    teamB: {
      fleet: cfg.teamB.fleet,
      formation: cfg.teamB.formation,
      doctrine: cfg.teamB.doctrine
    }
  });
  return toBase64Url(json);
}

export function decodeReplay(code: string): ReplayConfig {
  if (!code || !code.trim()) throw new Error('录像码为空');
  let obj: any;
  try {
    obj = JSON.parse(fromBase64Url(code.trim()));
  } catch {
    throw new Error('录像码格式无法解析');
  }
  if (typeof obj !== 'object' || obj === null) throw new Error('录像码内容无效');
  // 类型区分：若粘贴的是舰队方案码（fleet code），明确提示
  if (obj.type === 'spacewar-fleet') {
    throw new Error('这是一段舰队方案码，不是战斗录像码');
  }
  if (typeof obj.v !== 'string') throw new Error('缺少模拟版本 v');
  if (typeof obj.seed !== 'number' && typeof obj.seed !== 'string') {
    throw new Error('缺少随机种子 seed');
  }

  // 仅支持 v0.5。
  if (obj.v !== '0.5') {
    throw new Error(`不支持的录像版本：${obj.v}`);
  }

  const teamA = normalizeTeam(obj.teamA);
  const teamB = normalizeTeam(obj.teamB);

  // v0.5 固定映射至 core-v4；显式携带的 ruleset 必须与之一致，否则报错。
  const expected = REPLAY_VERSION_RULESET[obj.v];
  let ruleset: string;
  if (typeof obj.ruleset === 'string' && obj.ruleset) {
    if (!KNOWN_RULESETS.includes(obj.ruleset)) {
      throw new Error(`不支持的战斗规则版本：${obj.ruleset}`);
    }
    if (expected && obj.ruleset !== expected) {
      throw new Error(`录像版本 ${obj.v} 与规则集 ${obj.ruleset} 不匹配（应为 ${expected}）`);
    }
    ruleset = obj.ruleset;
  } else {
    ruleset = expected;
  }

  const budget = normalizeBudget(obj.budget);

  return {
    v: obj.v,
    ruleset,
    budget,
    seed: Number(obj.seed) >>> 0,
    teamA,
    teamB
  };
}

/** 校验某个改型是否存在（用于配置生成/测试） */
export function isKnownVariant(v: ShipVariant): boolean {
  return !!VARIANTS[v];
}
