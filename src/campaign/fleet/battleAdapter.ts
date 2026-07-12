import { createPRNG, PRNG } from '../../sim/prng';
import { createInitialState, createSimulator } from '../../sim/rulesets';
import { BattleState, ReplayConfig, TeamConfig } from '../../sim/battleTypes';
import { RULESET_V4, SIM_VERSION_V5 } from '../../sim/battleConfig';
import { assertValidFleet } from '../../sim/fleetValidator';
import { hash32 } from '../sector/sectorGenerator';
import { PersistentFleet, PersistentShip, activeShips, fleetEntries } from './persistentFleet';

export interface CampaignBattleBinding { campaignShipId: string; battleShipId: number; }
export interface CampaignBattleContext { origin: 'campaign'; replay: ReplayConfig; state: BattleState; rng: PRNG; bindings: CampaignBattleBinding[]; battleSeed: number; }

export function deriveBattleSeed(campaignSeed: number, sectorIndex: number, nodeId: string, battleIndex: number): number { return hash32(campaignSeed, sectorIndex, nodeId, battleIndex); }
export function enemyFleetFor(seed: number, sectorIndex: number, threatLevel: number) {
  const templates = [
    [{ shipClass: 'Fighter' as const, variant: 'standard' as const, count: 4 }],
    [{ shipClass: 'Fighter' as const, variant: 'interceptor' as const, count: 3 }, { shipClass: 'Frigate' as const, variant: 'standard' as const, count: 1 }],
    [{ shipClass: 'Frigate' as const, variant: 'artillery' as const, count: 2 }, { shipClass: 'Fighter' as const, variant: 'scout' as const, count: 1 }],
    [{ shipClass: 'Cruiser' as const, variant: 'carrier' as const, count: 1 }, { shipClass: 'Fighter' as const, variant: 'interceptor' as const, count: 3 }],
    [{ shipClass: 'Cruiser' as const, variant: 'fortress' as const, count: 1 }, { shipClass: 'Frigate' as const, variant: 'escort' as const, count: 1 }]
  ];
  const base = templates[hash32(seed, sectorIndex, threatLevel) % templates.length].map((e) => ({ ...e }));
  if (threatLevel >= 2) base[0].count += 1; assertValidFleet(base); return base;
}
export function campaignBattleReplay(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number): ReplayConfig {
  const teamA: TeamConfig = { fleet: fleetEntries(fleet), formation: fleet.formation, doctrine: fleet.doctrine };
  const teamB: TeamConfig = { fleet: enemy, formation: 'line', doctrine: 'balanced' };
  return { v: SIM_VERSION_V5, ruleset: RULESET_V4, seed, budget: { mode: 'unlimited', limit: 999999 }, teamA, teamB };
}
function sameHull(a: PersistentShip, battle: BattleState['ships'][number]): boolean { return a.shipClass === battle.type && a.variant === battle.variant; }

/** 创建唯一的战役战斗上下文，并将持久组件 HP 写入对应的 core-v4 舰船。 */
export function prepareCampaignBattle(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number): CampaignBattleContext {
  const replay = campaignBattleReplay(fleet, enemy, seed); const rng = createPRNG(seed); const state = createInitialState(replay, rng);
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
  const context = prepareCampaignBattle(fleet, enemy, seed); const sim = createSimulator(context.state, context.rng);
  while (!context.state.finished) sim.step(); return { state: context.state, context };
}
