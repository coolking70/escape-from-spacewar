import { createPRNG, PRNG } from '../../sim/prng';
import { createInitialState, createSimulator } from '../../sim/rulesets';
import { BattleState, FleetEntry, ReplayConfig, TeamConfig } from '../../sim/battleTypes';
import { RULESET_V4, SIM_VERSION_V5 } from '../../sim/battleConfig';
import { assertValidFleet } from '../../sim/fleetValidator';
import { hash32 } from '../sector/sectorGenerator';
import { PersistentFleet, PersistentShip, activeShips, fleetEntries } from './persistentFleet';
import { campaignFleetEntryCost, campaignFleetPower, campaignShipCost } from './campaignPower';

export interface CampaignBattleBinding { campaignShipId: string; battleShipId: number; }
export interface CampaignBattleContext { origin: 'campaign'; replay: ReplayConfig; state: BattleState; rng: PRNG; bindings: CampaignBattleBinding[]; battleSeed: number; }

export function deriveBattleSeed(campaignSeed: number, sectorIndex: number, nodeId: string, battleIndex: number): number {
  return hash32(campaignSeed, sectorIndex, nodeId, battleIndex);
}

function encounterRatio(sectorIndex: number, threatLevel: number, gateGuard: boolean): number {
  const normal = 0.72 + Math.max(0, sectorIndex - 1) * 0.08 + threatLevel * 0.05;
  return Math.min(gateGuard ? 1.45 : 1.08, normal + (gateGuard ? 0.22 : 0));
}

export function enemyBudgetFor(sectorIndex: number, threatLevel: number, gateGuard = false, playerPower = 155): number {
  return Math.round(Math.max(50, playerPower) * encounterRatio(sectorIndex, threatLevel, gateGuard));
}

function candidatePool(sectorIndex: number, threatLevel: number, gateGuard: boolean): FleetEntry[] {
  const pool: FleetEntry[] = [
    { shipClass: 'Fighter', variant: 'standard', count: 1 },
    { shipClass: 'Fighter', variant: 'interceptor', count: 1 },
    { shipClass: 'Fighter', variant: 'scout', count: 1 }
  ];
  if (threatLevel >= 1 || sectorIndex >= 2) pool.push({ shipClass: 'Frigate', variant: 'standard', count: 1 });
  if (threatLevel >= 2) {
    pool.push({ shipClass: 'Fighter', variant: 'bomber', count: 1 });
    pool.push({ shipClass: 'Frigate', variant: 'escort', count: 1 });
  }
  if (threatLevel >= 3 || sectorIndex >= 2) {
    pool.push({ shipClass: 'Frigate', variant: 'artillery', count: 1 });
    pool.push({ shipClass: 'Frigate', variant: 'support', count: 1 });
  }
  if (threatLevel >= 4 || sectorIndex >= 3 || gateGuard) pool.push({ shipClass: 'Cruiser', variant: 'standard', count: 1 });
  if (sectorIndex >= 3 || gateGuard) {
    pool.push({ shipClass: 'Cruiser', variant: 'carrier', count: 1 });
    pool.push({ shipClass: 'Cruiser', variant: 'fortress', count: 1 });
  }
  return pool;
}

export function enemyFleetFor(seed: number, sectorIndex: number, threatLevel: number, gateGuard = false, playerPower = 155): FleetEntry[] {
  const target = enemyBudgetFor(sectorIndex, threatLevel, gateGuard, playerPower);
  const maxPower = Math.max(50, playerPower) * (gateGuard ? 1.5 : threatLevel >= 4 ? 1.25 : 1.15);
  const pool = candidatePool(sectorIndex, threatLevel, gateGuard);
  const result = new Map<string, FleetEntry>();
  let total = 0;
  for (let slot = 0; slot < 20 && total < target; slot++) {
    const choices = pool.map((entry) => ({
      entry,
      cost: campaignShipCost(entry.shipClass, entry.variant),
      tie: hash32(seed, sectorIndex, threatLevel, slot, entry.shipClass, entry.variant)
    })).filter(({ cost }) => total + cost <= maxPower + 0.001).sort((a, b) => {
      const aGap = Math.abs(target - (total + a.cost));
      const bGap = Math.abs(target - (total + b.cost));
      return aGap - bGap || a.tie - b.tie;
    });
    const picked = choices[0];
    if (!picked) break;
    const key = `${picked.entry.shipClass}:${picked.entry.variant}`;
    const existing = result.get(key);
    if (existing) existing.count++;
    else result.set(key, { ...picked.entry });
    total += picked.cost;
  }
  if (!result.size) result.set('Fighter:standard', { shipClass: 'Fighter', variant: 'standard', count: 1 });
  const fleet = [...result.values()];
  assertValidFleet(fleet);
  return fleet;
}

function capEnemyToFleet(enemy: FleetEntry[], playerPower: number): FleetEntry[] {
  const cap = Math.max(50, playerPower) * 1.25;
  const next = enemy.map((entry) => ({ ...entry }));
  while (campaignFleetEntryCost(next) > cap && next.some((entry) => entry.count > 0)) {
    const removable = next.filter((entry) => entry.count > 0).sort((a, b) => campaignShipCost(b.shipClass, b.variant) - campaignShipCost(a.shipClass, a.variant))[0];
    removable.count--;
  }
  const filtered = next.filter((entry) => entry.count > 0);
  return filtered.length ? filtered : [{ shipClass: 'Fighter', variant: 'standard', count: 1 }];
}

export function campaignBattleReplay(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number): ReplayConfig {
  const teamA: TeamConfig = { fleet: fleetEntries(fleet), formation: fleet.formation, doctrine: fleet.doctrine };
  const teamB: TeamConfig = { fleet: enemy, formation: 'line', doctrine: 'balanced' };
  return { v: SIM_VERSION_V5, ruleset: RULESET_V4, seed, budget: { mode: 'unlimited', limit: 999999 }, teamA, teamB };
}

function sameHull(a: PersistentShip, battle: BattleState['ships'][number]): boolean {
  return a.shipClass === battle.type && a.variant === battle.variant;
}

export function prepareCampaignBattle(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number): CampaignBattleContext {
  const balancedEnemy = capEnemyToFleet(enemy, campaignFleetPower(fleet));
  const replay = campaignBattleReplay(fleet, balancedEnemy, seed);
  const rng = createPRNG(seed);
  const state = createInitialState(replay, rng);
  const remaining = [...activeShips(fleet)].sort((a, b) => a.campaignShipId.localeCompare(b.campaignShipId));
  const bindings: CampaignBattleBinding[] = [];
  for (const battleShip of state.ships.filter((ship) => ship.team === 'A').sort((a, b) => a.id - b.id)) {
    const index = remaining.findIndex((ship) => sameHull(ship, battleShip));
    if (index < 0) throw new Error(`无法为战斗舰船 #${battleShip.id} 建立战役绑定。`);
    const persistent = remaining.splice(index, 1)[0];
    if (persistent.componentHp) {
      if (persistent.componentHp.length !== battleShip.components.length) throw new Error(`舰船 ${persistent.campaignShipId} 的组件结构不匹配。`);
      persistent.componentHp.forEach((hp, i) => {
        if (!Number.isFinite(hp) || hp < 0) throw new Error(`舰船 ${persistent.campaignShipId} 的组件 HP 无效。`);
        battleShip.components[i].hp = Math.min(hp, battleShip.components[i].maxHp);
        battleShip.components[i].destroyed = battleShip.components[i].hp <= 0;
      });
    }
    bindings.push({ campaignShipId: persistent.campaignShipId, battleShipId: battleShip.id });
  }
  if (remaining.length) throw new Error('存在未绑定的可参战战役舰船。');
  return { origin: 'campaign', replay, state, rng, bindings, battleSeed: seed };
}

export function runCampaignBattle(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number) {
  const context = prepareCampaignBattle(fleet, enemy, seed);
  const sim = createSimulator(context.state, context.rng);
  while (!context.state.finished) sim.step();
  return { state: context.state, context };
}
