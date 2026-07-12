import { createPRNG } from '../../sim/prng';
import { createInitialState, createSimulator } from '../../sim/rulesets';
import { ReplayConfig, TeamConfig } from '../../sim/battleTypes';
import { RULESET_V4, SIM_VERSION_V5 } from '../../sim/battleConfig';
import { assertValidFleet } from '../../sim/fleetValidator';
import { hash32 } from '../sector/sectorGenerator';
import { PersistentFleet, fleetEntries } from './persistentFleet';

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
export function runCampaignBattle(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number) {
  const replay = campaignBattleReplay(fleet, enemy, seed); const rng = createPRNG(seed); const state = createInitialState(replay, rng); const sim = createSimulator(state, rng);
  while (!state.finished) sim.step(); return state;
}
