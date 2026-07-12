// 平衡实验室核心（纯 sim，无渲染、无 DOM）：批量确定性重模拟并聚合统计。
// V0.5：可配置 A/B 舰队/阵型/战术、runs、seed、seed-step、max-ticks、swap-sides；
//   统计胜/平局率、平均 tick、min/max 剩余舰船、剩余点数、伤害、
//   每改型伤害/击毁/损失率/damagePerCost/存活、winner-vs-seed 列表、
//   长战斗列表、零伤害异常，以及 swap-sides 位置偏差警告。
// 所有随机性来自 seed 派生的 PRNG，与是否使用 Worker / 主线程无关。

import { createPRNG } from './prng';
import { createInitialState, createSimulator } from './rulesets';
import { summarizeStats } from './battleStats';
import { getShipPointValue } from './combatState';
import { BattleState, ReplayConfig, TeamConfig, ShipClass, ShipVariant } from './battleTypes';
import { SIM_VERSION_V5, RULESET_V4 } from './battleConfig';
import { getVariantDef } from './shipVariants';
import { assertValidFleet } from './fleetValidator';

export interface BalanceRunConfig {
  teamA: TeamConfig;
  teamB: TeamConfig;
  seed: number;
  /** 每局之间的 seed 步长（确定性派生） */
  seedStep: number;
  runs: number;
  maxTicks: number;
  swapSides: boolean;
  ruleset?: string;
}

export interface VariantStatRow {
  team: 'A' | 'B';
  shipClass: ShipClass;
  variant: ShipVariant;
  deployed: number;
  lost: number;
  lossRate: number;
  survival: number;
  damage: number;
  kills: number;
  damagePerCost: number;
  killsPerCost: number;
}

export interface RunRecord {
  index: number;
  seed: number;
  winner: 'A' | 'B' | null;
  ticks: number;
  teamARemaining: number;
  teamBRemaining: number;
  teamADamage: number;
  teamBDamage: number;
}

export interface PositionBias {
  sideAWins: number;
  sideBWins: number;
  diffPct: number;
  warning: boolean;
}

/** 平衡实验室累计舰队价值摘要（core-v4 价值口径，跨所有 runs 累加后取平均） */
export interface FleetValueSummary {
  initialFleetCost: number;
  remainingOperationalValue: number;
  remainingDecisionValue: number;
}

export interface BalanceResult {
  config: BalanceRunConfig;
  ruleset: string;
  simVersion: string;
  runs: number;
  winsA: number;
  winsB: number;
  draws: number;
  winRateA: number;
  winRateB: number;
  drawRate: number;
  avgTicks: number;
  minTicks: number;
  maxTicks: number;
  avgRemainA: number;
  avgRemainB: number;
  minRemainA: number;
  minRemainB: number;
  maxRemainA: number;
  maxRemainB: number;
  avgPointsA: number;
  avgPointsB: number;
  avgDamageA: number;
  avgDamageB: number;
  variantStats: VariantStatRow[];
  runsList: RunRecord[];
  longBattles: RunRecord[];
  zeroDamageAnomalies: { seed: number; team: 'A' | 'B' }[];
  positionBias: PositionBias | null;
  /** 各结束原因出现次数（core-v4 提供；v3 多为 annihilation/draw） */
  victoryReasons: Record<string, number>;
  /** 累计最终状态计数（core-v4；escaped/disabled/destroyed 才有意义） */
  outcome: { destroyed: { A: number; B: number }; disabled: { A: number; B: number }; escaped: { A: number; B: number } };
  /** 累计舰队价值（core-v4 价值口径：operational=仍在场且具战斗力，decision=点数判定价值） */
  fleetValue: { A: FleetValueSummary; B: FleetValueSummary };
}

function runHeadless(teamA: TeamConfig, teamB: TeamConfig, seed: number, maxTicks: number, ruleset: string): BattleState {
  // core-v4 唯一正式规则：所有 replay 统一使用 SIM_VERSION_V5 + core-v4。
  const cfg: ReplayConfig = {
    v: SIM_VERSION_V5,
    ruleset,
    seed: seed >>> 0,
    budget: { mode: 'unlimited', limit: 999999 },
    teamA,
    teamB
  };
  const rng = createPRNG(cfg.seed);
  const state = createInitialState(cfg, rng);
  state.maxTicks = maxTicks;
  const sim = createSimulator(state, rng);
  let guard = 0;
  while (!state.finished && guard <= maxTicks + 1) {
    sim.step();
    guard++;
  }
  return state;
}

function remainingPoints(state: BattleState, team: 'A' | 'B'): number {
  let p = 0;
  for (const s of state.ships) {
    if (s.team === team) p += getShipPointValue(s);
  }
  return p;
}

const LONG_BATTLE_RATIO = 0.9;

/**
 * 批量运行平衡测试（纯函数、确定性）。
 * onProgress 用于在 Worker / 主线程中汇报进度（done 已完成的局数）。
 */
export function runBalance(
  config: BalanceRunConfig,
  onProgress?: (done: number, total: number) => void
): BalanceResult {
  assertValidFleet(config.teamA.fleet);
  assertValidFleet(config.teamB.fleet);
  const total = Math.max(1, config.runs);
  const ruleset = config.ruleset ?? RULESET_V4;
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let sumTick = 0;
  let sumRemainA = 0;
  let sumRemainB = 0;
  let sumPtsA = 0;
  let sumPtsB = 0;
  let sumDmgA = 0;
  let sumDmgB = 0;
  let minTick = Infinity;
  let maxTick = 0;
  let minRemainA = Infinity;
  let minRemainB = Infinity;
  let maxRemainA = 0;
  let maxRemainB = 0;

  const runsList: RunRecord[] = [];
  const zeroDamageAnomalies: { seed: number; team: 'A' | 'B' }[] = [];
  const variantAgg = new Map<string, VariantStatRow>();
  const victoryReasons: Record<string, number> = {};
  const outcome = {
    destroyed: { A: 0, B: 0 },
    disabled: { A: 0, B: 0 },
    escaped: { A: 0, B: 0 }
  };
  const fvSum = {
    A: { initialFleetCost: 0, remainingOperationalValue: 0, remainingDecisionValue: 0 },
    B: { initialFleetCost: 0, remainingOperationalValue: 0, remainingDecisionValue: 0 }
  };

  // swap-sides 位置偏差统计
  let sideAWins = 0;
  let sideBWins = 0;

  const progressEvery = Math.max(1, Math.floor(total / 50));

  for (let i = 0; i < total; i++) {
    const seed = (config.seed + i * config.seedStep) >>> 0;
    const state = runHeadless(config.teamA, config.teamB, seed, config.maxTicks, ruleset);
    const st = summarizeStats(state);
    const winner = state.winner;
    if (winner === 'A') winsA++;
    else if (winner === 'B') winsB++;
    else draws++;

    sumTick += state.tick;
    sumRemainA += state.teamACount;
    sumRemainB += state.teamBCount;
    sumDmgA += st.totalDamage.A;
    sumDmgB += st.totalDamage.B;
    sumPtsA += remainingPoints(state, 'A');
    sumPtsB += remainingPoints(state, 'B');
    minTick = Math.min(minTick, state.tick);
    maxTick = Math.max(maxTick, state.tick);
    minRemainA = Math.min(minRemainA, state.teamACount);
    minRemainB = Math.min(minRemainB, state.teamBCount);
    maxRemainA = Math.max(maxRemainA, state.teamACount);
    maxRemainB = Math.max(maxRemainB, state.teamBCount);

    if (st.totalDamage.A === 0) zeroDamageAnomalies.push({ seed, team: 'A' });
    if (st.totalDamage.B === 0) zeroDamageAnomalies.push({ seed, team: 'B' });

    // v4 结局统计
    const vr = state.victoryReason ?? 'unknown';
    victoryReasons[vr] = (victoryReasons[vr] ?? 0) + 1;
    for (const s of state.ships) {
      if (s.combatState === 'destroyed') outcome.destroyed[s.team]++;
      else if (s.combatState === 'disabled') outcome.disabled[s.team]++;
      else if (s.combatState === 'escaped') outcome.escaped[s.team]++;
    }

    // 累计舰队价值（core-v4 价值口径）
    fvSum.A.initialFleetCost += st.fleetValue.A.initialFleetCost;
    fvSum.A.remainingOperationalValue += st.fleetValue.A.remainingOperationalValue;
    fvSum.A.remainingDecisionValue += st.fleetValue.A.remainingDecisionValue;
    fvSum.B.initialFleetCost += st.fleetValue.B.initialFleetCost;
    fvSum.B.remainingOperationalValue += st.fleetValue.B.remainingOperationalValue;
    fvSum.B.remainingDecisionValue += st.fleetValue.B.remainingDecisionValue;

    const rec: RunRecord = {
      index: i,
      seed,
      winner,
      ticks: state.tick,
      teamARemaining: state.teamACount,
      teamBRemaining: state.teamBCount,
      teamADamage: Math.round(st.totalDamage.A),
      teamBDamage: Math.round(st.totalDamage.B)
    };
    runsList.push(rec);

    // 每改型聚合
    for (const v of st.variantStats) {
      const k = `${v.team}|${v.shipClass}|${v.variant}`;
      let a = variantAgg.get(k);
      if (!a) {
        a = {
          team: v.team,
          shipClass: v.shipClass,
          variant: v.variant,
          deployed: 0,
          lost: 0,
          lossRate: 0,
          survival: 0,
          damage: 0,
          kills: 0,
          damagePerCost: 0,
          killsPerCost: 0
        };
        variantAgg.set(k, a);
      }
      a.deployed += v.deployed;
      a.lost += v.lost;
      a.damage += Math.round(v.damage);
      a.kills += v.kills;
    }

    if (config.swapSides) {
      // 交换双方舰队（含阵型/战术），同 seed 再跑一局，用于检测位置偏差
      const swapped = runHeadless(config.teamB, config.teamA, seed, config.maxTicks, ruleset);
      if (swapped.winner === 'A') sideAWins++;
      else if (swapped.winner === 'B') sideBWins++;
      // 注意：swapped 中 winner==='A' 表示 side A（此刻承载 fleet B）获胜
    } else {
      if (winner === 'A') sideAWins++;
      else if (winner === 'B') sideBWins++;
    }

    if (onProgress && (i % progressEvery === 0 || i === total - 1)) {
      onProgress(i + 1, total);
    }
  }

  const variantStats: VariantStatRow[] = [];
  for (const a of variantAgg.values()) {
    const cost = getVariantDef(a.variant).cost;
    const depCost = a.deployed * cost;
    a.lossRate = a.deployed > 0 ? a.lost / a.deployed : 0;
    a.survival = a.deployed > 0 ? (a.deployed - a.lost) / a.deployed : 0;
    a.damagePerCost = depCost > 0 ? a.damage / depCost : 0;
    a.killsPerCost = depCost > 0 ? a.kills / depCost : 0;
    variantStats.push(a);
  }
  variantStats.sort((x, y) =>
    x.team === y.team ? 0 : x.team === 'A' ? -1 : 1
  );

  const longBattles = runsList.filter((r) => r.ticks >= config.maxTicks * LONG_BATTLE_RATIO);

  let positionBias: PositionBias | null = null;
  if (config.swapSides) {
    const pairs = total;
    const diffPct = (Math.abs(sideAWins - sideBWins) / (2 * pairs)) * 100;
    positionBias = {
      sideAWins,
      sideBWins,
      diffPct,
      warning: diffPct > 5
    };
  }

  const avg = (x: number) => Math.round((x / total) * 100) / 100;

  return {
    config,
    ruleset,
    simVersion: SIM_VERSION_V5,
    runs: total,
    winsA,
    winsB,
    draws,
    winRateA: (winsA / total) * 100,
    winRateB: (winsB / total) * 100,
    drawRate: (draws / total) * 100,
    avgTicks: avg(sumTick),
    minTicks: minTick === Infinity ? 0 : minTick,
    maxTicks: maxTick,
    avgRemainA: avg(sumRemainA),
    avgRemainB: avg(sumRemainB),
    minRemainA: minRemainA === Infinity ? 0 : minRemainA,
    minRemainB: minRemainB === Infinity ? 0 : minRemainB,
    maxRemainA: maxRemainA,
    maxRemainB: maxRemainB,
    avgPointsA: avg(sumPtsA),
    avgPointsB: avg(sumPtsB),
    avgDamageA: avg(sumDmgA),
    avgDamageB: avg(sumDmgB),
    variantStats,
    runsList,
    longBattles,
    zeroDamageAnomalies,
    positionBias,
    victoryReasons,
    outcome,
    fleetValue: fvSum
  };
}
