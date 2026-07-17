import { minimumStrategicFleetCost, normalizeStrategicEnemyPower } from '../campaign/fleet/campaignPower';

export type StrategicMobileEncounterRole = 'raider' | 'gateDefense';

/**
 * C.5 的移动敌军压力表。它只决定战略层投放预算，不改动任何 core-v4 舰船成本或战斗规则。
 *
 * D.1 的有限主基地生产不会改变遭遇预算；移动敌军继续受两个上限约束：
 * 1. 随星域递增的目标预算，保证完整舰队面对的压力逐域上升；
 * 2. 当前可作战舰队价值的一定比例，避免继承舰损后生成数学上无法突破的强制战斗。
 */
const RAIDER_TARGETS = [100, 110, 120];
const GATE_DEFENSE_TARGETS = [115, 125, 140];
const PLAYER_POWER_CAP: Record<StrategicMobileEncounterRole, number> = {
  raider: 0.55,
  gateDefense: 0.65
};

export function strategicMobileEnemyBudget(
  sectorIndex: number,
  playerPower: number,
  role: StrategicMobileEncounterRole
): number {
  if (!Number.isFinite(playerPower) || playerPower <= 0) return 0;
  const index = Math.min(2, Math.max(0, Math.floor(sectorIndex) - 1));
  const target = (role === 'gateDefense' ? GATE_DEFENSE_TARGETS : RAIDER_TARGETS)[index];
  const capped = Math.min(target, Math.floor(playerPower * PLAYER_POWER_CAP[role]));
  if (capped < minimumStrategicFleetCost()) return 0;
  return normalizeStrategicEnemyPower(capped);
}

/** 危机压力是撤离风险刻度；回合硬截止仍由 CrisisState.finalTurn 单独负责。 */
export function strategicPressureAtStart(sectorIndex: number): number {
  return 8 + Math.max(1, Math.floor(sectorIndex)) * 2;
}

export function strategicPressurePerTurn(sectorIndex: number, forecasting = false): number {
  return Math.max(2, 3 + Math.max(1, Math.floor(sectorIndex)) - (forecasting ? 2 : 0));
}
