// 全局模拟常量与配置。
// 这些值影响战斗结果，因此也必须纳入"确定性"约束（不随运行环境变化）。

export const SIM_VERSION = '0.5';

/**
 * 规则集标识。replay code 中携带，用于在未来规则变更时区分/兼容旧战斗。
 * 当前唯一正式规则为 spacewar-core-v4；旧版本录像不再兼容，导入时直接报错提示。
 */
export const RULESET = 'spacewar-core-v4';

/** 新建战斗默认使用的 replay 版本与规则集（V0.5.1 起为 v0.5 + core-v4） */
export const SIM_VERSION_V5 = '0.5';
export const RULESET_V4 = 'spacewar-core-v4';

/** 默认舰队预算点数（Team A / B 各 1000 点） */
export const DEFAULT_BUDGET_LIMIT = 1000;

/** 每秒模拟 tick 数（固定步长 = 30 tick/s）。
 * 这是模拟时间的唯一权威常量；所有 sim 时间换算都必须使用 TICKS_PER_SECOND，
 * 严禁用 maxTicks / 时长 反推 tick rate。 */
export const TICKS_PER_SECOND = 30;
/** 兼容别名（部分旧代码仍引用 TICK_RATE 表示每秒 tick 数） */
export const TICK_RATE = TICKS_PER_SECOND;

/** 每 tick 的真实毫秒数（仅用于渲染层计时，不影响战斗结果） */
export const TICK_MS = 1000 / TICKS_PER_SECOND;

/** 最大模拟 tick 数（默认约 120 秒 = 3600 tick）。与时间换算无关。 */
export const MAX_TICKS = TICKS_PER_SECOND * 120;

/** 模拟 tick → 模拟秒（唯一时间换算入口；与 maxTicks 无关） */
export function tickToSeconds(tick: number): number {
  return tick / TICKS_PER_SECOND;
}

/** 模拟秒 → 模拟 tick（向上取整，确定性） */
export function secondsToTicks(seconds: number): number {
  return Math.ceil(seconds * TICKS_PER_SECOND);
}

/** 舰队出生点布局参数 */
export const SPAWN = {
  /** 双方距中线的 x 距离 */
  x: 35,
  /** 同一队内飞船沿 z 轴的基准间距 */
  spacing: 7,
  /** y 轴错开幅度 */
  yStep: 2.5,
  /** wedge 阵型中，按舰种前后错开的步长 */
  wedgeStep: 6,
  /** swarm 阵型放大的间距系数 */
  swarmScale: 1.6,
  /** 初始出生点 x 方向抖动幅度（确定性，来自 PRNG） */
  jitterX: 1.5,
  /** 初始出生点 z 方向抖动幅度 */
  jitterZ: 1.5
};

/** 竞技场边界（仅用于防止飞船无限漂移） */
export const ARENA = {
  x: 200,
  y: 60,
  z: 200
};

/** 各 doctrine 对理想交火距离（desiredRange）的乘性调整 */
export const DOCTRINE_RANGE_FACTOR: Record<string, number> = {
  balanced: 1.0,
  aggressive: 0.78,
  defensive: 1.18,
  kite: 1.12,
  focusFire: 0.95,
  antiCapital: 1.0,
  screen: 0.9
};

/** 各舰种的基础理想交火距离系数（乘以最远射程） */
export const SHIP_RANGE_FACTOR: Record<string, number> = {
  Fighter: 0.82,
  Frigate: 0.9,
  Cruiser: 0.98
};
