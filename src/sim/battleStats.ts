// 战斗统计：在 sim 层累积与汇总，完全由 BattleState 派生，不依赖任何渲染/DOM 对象。

import {
  BattleState,
  BattleStats,
  ShipClass,
  ShipVariant,
  Team,
  VictoryReason,
  CombatState
} from './battleTypes';
import { variantKey, VARIANTS, VARIANT_CN, getVariantDef } from './shipVariants';
import { tickToSeconds } from './battleConfig';
import {
  isCombatCapable,
  getShipCost,
  getShipOperationalValue,
  getShipDecisionValue
} from './combatState';
import { isPresentOnBattlefield } from './shipFlags';

/** 记录一次命中造成的伤害（攻击者累计 + 团队累计） */
export function addDamage(
  stats: BattleStats,
  attackerId: number,
  team: Team,
  amount: number
): void {
  const s = stats.ships[attackerId];
  if (s) s.damageDealt += amount;
  stats.team[team].totalDamage += amount;
}

/** 记录一次击毁（攻击者击毁数 + 双方团队击毁/损失，按改型统计损失） */
export function addKill(
  stats: BattleStats,
  attackerId: number,
  team: Team,
  victimType: ShipClass,
  victimTeam: Team,
  victimVariant: ShipVariant
): void {
  const s = stats.ships[attackerId];
  if (s) s.kills += 1;
  stats.team[team].kills += 1;
  const key = variantKey(victimType, victimVariant);
  stats.team[victimTeam].losses[key] = (stats.team[victimTeam].losses[key] ?? 0) + 1;
}

export interface MvpInfo {
  id: number;
  team: Team;
  type: ShipClass;
  variant: ShipVariant;
  value: number;
}

/** 按改型聚合的战损/效率统计 */
export interface VariantStat {
  team: Team;
  shipClass: ShipClass;
  variant: ShipVariant;
  deployed: number;
  lost: number;
  damage: number;
  kills: number;
  cost: number;
  damagePerCost: number;
  killsPerCost: number;
}

export interface StatsSummary {
  winner: Team | null;
  totalTicks: number;
  simSeconds: number;
  remaining: { A: number; B: number };
  totalDamage: { A: number; B: number };
  kills: { A: number; B: number };
  losses: { A: Record<string, number>; B: Record<string, number> };
  startCounts: { A: { shipClass: ShipClass; variant: ShipVariant; count: number }[]; B: { shipClass: ShipClass; variant: ShipVariant; count: number }[] };
  variantStats: VariantStat[];
  mvpDamage: MvpInfo | null;
  mvpKills: MvpInfo | null;
  /** 战斗结束原因（core-v4 提供；v3 为 undefined） */
  victoryReason?: VictoryReason;
  /** 各战斗状态的最终计数（core-v4） */
  counts: {
    A: Record<CombatState, number>;
    B: Record<CombatState, number>;
  };
  /** 明确拆分的战后统计语义（core-v4 必填；v3 仍可用但部分字段恒 0） */
  battlefieldRemaining: { A: number; B: number };
  combatCapableRemaining: { A: number; B: number };
  escaped: { A: number; B: number };
  disabled: { A: number; B: number };
  destroyed: { A: number; B: number };
  /** 舰队价值拆分（纯由 CombatState 派生，互斥计数，绝不以 alive 为依据）。
   *  - initialFleetCost：初始总建造成本（恒等于各舰原始成本之和）
   *  - remainingOperationalValue：仍在场且具战斗力的作战价值（normal/damaged/critical/retreating = 100% cost）
   *  - remainingDecisionValue：点数判定价值（normal/damaged/critical/retreating/escaped = 100%、disabled = 50%、destroyed = 0）
   *  - destroyedValue：按原始成本计的损毁价值（destroyed = 100% cost）
   *  - disabledValue：按原始成本计的失能价值（disabled = 100% cost）
   *  - escapedValue：按原始成本计的脱战保存价值（escaped = 100% cost）
   *  守恒：destroyedValue + disabledValue + escapedValue + remainingOperationalValue = initialFleetCost（均为原始成本）。 */
  fleetValue: {
    A: FleetValueBreakdown;
    B: FleetValueBreakdown;
  };
}

/** 单队舰队价值拆分（原始成本口径，互斥） */
export interface FleetValueBreakdown {
  initialFleetCost: number;
  remainingOperationalValue: number;
  remainingDecisionValue: number;
  destroyedValue: number;
  disabledValue: number;
  escapedValue: number;
}

function best(
  state: BattleState,
  pick: (s: { damageDealt: number; kills: number }) => number
): MvpInfo | null {
  let bestId = -1;
  let bestVal = -1;
  for (const ship of state.ships) {
    const st = state.stats.ships[ship.id];
    if (!st) continue;
    const val = pick(st);
    if (val > bestVal) {
      bestVal = val;
      bestId = ship.id;
    }
  }
  if (bestId < 0 || bestVal <= 0) return null;
  const ship = state.ships.find((s) => s.id === bestId)!;
  return { id: bestId, team: ship.team, type: ship.type, variant: ship.variant, value: bestVal };
}

/** 构建某队的按改型统计（投入/损失/伤害/击毁/点数效率） */
function buildVariantStats(state: BattleState, team: Team): VariantStat[] {
  const sc = state.stats.startCounts[team];
  const losses = state.stats.team[team].losses;

  const deployedMap = new Map<string, number>();
  for (const e of sc) {
    const k = variantKey(e.shipClass, e.variant);
    deployedMap.set(k, (deployedMap.get(k) ?? 0) + Math.max(0, Math.floor(e.count || 0)));
  }

  const agg = new Map<string, { d: number; k: number }>();
  for (const ship of state.ships) {
    if (ship.team !== team) continue;
    const st = state.stats.ships[ship.id];
    if (!st) continue;
    const k = variantKey(ship.type, ship.variant);
    const cur = agg.get(k) ?? { d: 0, k: 0 };
    cur.d += st.damageDealt;
    cur.k += st.kills;
    agg.set(k, cur);
  }

  const out: VariantStat[] = [];
  for (const [k, deployed] of deployedMap) {
    const [cls, variant] = k.split(':') as [ShipClass, ShipVariant];
    const cost = getVariantDef(variant).cost;
    const dv = agg.get(k) ?? { d: 0, k: 0 };
    const lost = losses[k] ?? 0;
    const groupCost = cost * Math.max(1, deployed);
    out.push({
      team,
      shipClass: cls,
      variant,
      deployed,
      lost,
      damage: Math.round(dv.d),
      kills: dv.k,
      cost,
      damagePerCost: Math.round((dv.d / groupCost) * 10) / 10,
      killsPerCost: Math.round((dv.k / groupCost) * 100) / 100
    });
  }
  return out;
}

/** 汇总当前战斗统计，供战后面板展示（纯数据，不触碰渲染） */
export function summarizeStats(state: BattleState): StatsSummary {
  // 注意：simSeconds 必须使用权威常量 TICKS_PER_SECOND，绝不依赖 maxTicks。
  const simSeconds = Math.round(tickToSeconds(state.tick) * 10) / 10;
  const emptyCounts = (): Record<CombatState, number> => ({
    normal: 0,
    damaged: 0,
    critical: 0,
    disabled: 0,
    retreating: 0,
    escaped: 0,
    destroyed: 0
  });
  const counts = { A: emptyCounts(), B: emptyCounts() };
  const battlefieldRemaining = { A: 0, B: 0 };
  const combatCapableRemaining = { A: 0, B: 0 };
  const escaped = { A: 0, B: 0 };
  const disabled = { A: 0, B: 0 };
  const destroyed = { A: 0, B: 0 };
  const fleetValue = {
    A: {
      initialFleetCost: 0,
      remainingOperationalValue: 0,
      remainingDecisionValue: 0,
      destroyedValue: 0,
      disabledValue: 0,
      escapedValue: 0
    },
    B: {
      initialFleetCost: 0,
      remainingOperationalValue: 0,
      remainingDecisionValue: 0,
      destroyedValue: 0,
      disabledValue: 0,
      escapedValue: 0
    }
  };

  for (const sh of state.ships) {
    if (counts[sh.team]) counts[sh.team][sh.combatState]++;
    // battlefieldRemaining：仍在场（含 disabled；escaped/destroyed 已离场不计）
    if (isPresentOnBattlefield(sh)) battlefieldRemaining[sh.team]++;
    if (isCombatCapable(sh)) combatCapableRemaining[sh.team]++;
    if (sh.combatState === 'escaped') escaped[sh.team]++;
    if (sh.combatState === 'disabled') disabled[sh.team]++;
    // destroyed 仅按 combatState 判定：escaped 满足 isPresentOnBattlefield=false，
    // 但绝不可计入 destroyed（脱战 ≠ 击毁）。
    if (sh.combatState === 'destroyed') destroyed[sh.team]++;

    // 舰队价值拆分：互斥计数，纯由 CombatState 派生。
    const cost = getShipCost(sh);
    const fv = fleetValue[sh.team];
    fv.initialFleetCost += cost;
    switch (sh.combatState) {
      case 'destroyed':
        fv.destroyedValue += cost;
        break;
      case 'disabled':
        fv.disabledValue += cost;
        fv.remainingDecisionValue += cost * 0.5;
        break;
      case 'escaped':
        fv.escapedValue += cost;
        fv.remainingDecisionValue += cost;
        break;
      case 'normal':
      case 'damaged':
      case 'critical':
      case 'retreating':
        fv.remainingOperationalValue += cost;
        fv.remainingDecisionValue += cost;
        break;
    }
  }

  return {
    winner: state.winner,
    totalTicks: state.tick,
    simSeconds,
    remaining: { A: state.teamACount, B: state.teamBCount },
    totalDamage: {
      A: Math.round(state.stats.team.A.totalDamage),
      B: Math.round(state.stats.team.B.totalDamage)
    },
    kills: {
      A: state.stats.team.A.kills,
      B: state.stats.team.B.kills
    },
    losses: {
      A: { ...state.stats.team.A.losses },
      B: { ...state.stats.team.B.losses }
    },
    startCounts: {
      A: state.stats.startCounts.A.map((e) => ({ ...e })),
      B: state.stats.startCounts.B.map((e) => ({ ...e }))
    },
    variantStats: [
      ...buildVariantStats(state, 'A'),
      ...buildVariantStats(state, 'B')
    ],
    mvpDamage: best(state, (s) => s.damageDealt),
    mvpKills: best(state, (s) => s.kills),
    victoryReason: state.victoryReason,
    counts,
    battlefieldRemaining,
    combatCapableRemaining,
    escaped,
    disabled,
    destroyed,
    fleetValue
  };
}

export function formatMvp(mvp: MvpInfo | null): string {
  if (!mvp) return '—';
  return `#${mvp.id} (${mvp.team === 'A' ? 'A' : 'B'}-${mvp.type}·${VARIANT_CN[mvp.variant] ?? mvp.variant})`;
}
