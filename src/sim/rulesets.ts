// 规则集分发（core-v4 唯一正式规则）。
//
// V0.6 起统一为 spacewar-core-v4，停止维护 core-v1/v2/v3 与 v0.1~v0.4 录像。
//  - 所有 replay 仅保证 v0.5 可正常导入导出；
//  - 旧版本 replay 导入时直接报错提示"当前快速开发版已不再兼容历史测试录像，请重新生成录像代码"；
//  - 未知 ruleset 抛错，绝不静默回退到最新版。
// 所有规则共用同一套确定性 PRNG 与固定 tick，相同 (config, ruleset, seed) 必得相同结果；
// 分发只依据 replay.ruleset（解码时已正确映射），绝不读取渲染/UI 状态。

import {
  ReplayConfig,
  BattleState,
  BattleStepResult,
  Team
} from './battleTypes';
import { PRNG } from './prng';
import { createInitialStateV4, BattleSimulatorV4 } from './simulatorV4';

export type RulesetId = 'spacewar-core-v4';

/** 模拟引擎统一接口（v4 实现，供 App / 时间线 / 平衡实验室统一调用） */
export interface SimContext {
  /** 推进一个固定 tick，返回本 tick 产生的视觉事件（不影响结果） */
  step(): BattleStepResult;
  /** 供 Ship Inspector 只读读取本 tick 该舰受到的支援光环加成（不回写 sim） */
  getAuraStatus(id: number): { accuracy: number; shieldRegen: number };
  /** 可选：释放内部缓存（如光环/目标缓存） */
  dispose?(): void;
}

/** 规则集定义：如何构建初始状态、如何创建模拟器 */
export interface RulesetDefinition {
  id: RulesetId;
  /** 该规则集对应的 replay 版本号 */
  replayVersion: string;
  createInitialState(replay: ReplayConfig, rng: PRNG, ruleset: RulesetId): BattleState;
  createSimulator(state: BattleState, rng: PRNG): SimContext;
}

export const V4 = 'spacewar-core-v4' as const;

function stamp(state: BattleState, ruleset: RulesetId): BattleState {
  state.ruleset = ruleset;
  return state;
}

export const RULESETS: Record<RulesetId, RulesetDefinition> = {
  'spacewar-core-v4': {
    id: V4,
    replayVersion: '0.5',
    createInitialState: (r, rng) => createInitialStateV4(r, rng, V4),
    createSimulator: (s, rng) => new BattleSimulatorV4(s, rng)
  }
};

/** UI 可选规则集（当前唯一正式规则 core-v4） */
export interface RulesetOption {
  id: RulesetId;
  label: string;
  isLatest: boolean;
}

export const RULESET_OPTIONS: RulesetOption[] = [
  { id: V4, label: 'core-v4（方向命中 / 失能 / 撤退）', isLatest: true }
];

/** 受支持的 ruleset 集合（与 replayCodec.KNOWN_RULESETS 保持一致） */
export const KNOWN_RULESETS: RulesetId[] = ['spacewar-core-v4'];

function assertKnown(id: string | undefined): RulesetId {
  if (id && (KNOWN_RULESETS as string[]).includes(id)) return id as RulesetId;
  throw new Error(`不支持的战斗规则版本：${id ?? '(空)'}`);
}

/** 由 replay 解析出应使用的规则集 id（已信任 decode 映射结果，仅做兜底）。
 *  未知 ruleset 直接抛错，绝不静默回退到最新版。 */
export function resolveRuleset(replay: ReplayConfig): RulesetId {
  return assertKnown(replay.ruleset);
}

/** 校验 ruleset 字符串是否受支持（供 UI / 测试使用） */
export function isKnownRuleset(id: string | undefined): boolean {
  return !!id && (KNOWN_RULESETS as string[]).includes(id);
}

/** 统一构建初始战斗状态（按 replay.ruleset 分发，并把 ruleset 写入 state 供后续分发） */
export function createInitialState(replay: ReplayConfig, rng: PRNG): BattleState {
  const id = resolveRuleset(replay);
  return RULESETS[id].createInitialState(replay, rng, id);
}

/** 统一创建模拟器（按 state.ruleset 分发；未知 ruleset 抛错，不静默回退） */
export function createSimulator(state: BattleState, rng: PRNG): SimContext {
  const id = assertKnown(state.ruleset);
  return RULESETS[id].createSimulator(state, rng);
}

/** 供 UI 显示当前 replay 的 ruleset 友好名 */
export function rulesetLabel(id: string | undefined): string {
  return RULESETS[(id as RulesetId) ?? V4]?.id ?? (id ?? V4);
}

export type { Team };
