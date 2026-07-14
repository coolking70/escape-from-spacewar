import { createPRNG, PRNG } from '../../sim/prng';
import { createInitialState, createSimulator } from '../../sim/rulesets';
import { BattleState, FleetEntry, ReplayConfig, TeamConfig } from '../../sim/battleTypes';
import { RULESET_V4, SIM_VERSION_V5 } from '../../sim/battleConfig';
import { assertValidFleet } from '../../sim/fleetValidator';
import { getShipDef } from '../../sim/shipVariants';
import { hash32 } from '../sector/sectorGenerator';
import { PersistentFleet, PersistentShip, activeShips, fleetEntries } from './persistentFleet';
import { campaignFleetEntryCost, campaignFleetPower, campaignShipCost } from './campaignPower';

/** 战役与战略战斗共用的绑定：持久舰 shipId ↔ 战斗舰 shipId。 */
export interface PersistentBattleBinding { campaignShipId: string; battleShipId: number; }

/** 战役 / 战略共用的持久战斗上下文。 */
export interface PersistentBattleContext {
  origin: 'campaign' | 'strategy';
  replay: ReplayConfig;
  state: BattleState;
  rng: PRNG;
  bindings: PersistentBattleBinding[];
  battleSeed: number;
}

export type CampaignBattleBinding = PersistentBattleBinding;
export type CampaignBattleContext = PersistentBattleContext & { origin: 'campaign' };
export type StrategicBattleContext = PersistentBattleContext & { origin: 'strategy' };

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

/** 战役与战略战斗共用的 replay 构造（不压缩敌军，敌军强度由调用方决定）。 */
export function persistentBattleReplay(fleet: PersistentFleet, enemy: FleetEntry[], seed: number): ReplayConfig {
  const teamA: TeamConfig = { fleet: fleetEntries(fleet), formation: fleet.formation, doctrine: fleet.doctrine };
  const teamB: TeamConfig = { fleet: enemy, formation: 'line', doctrine: 'balanced' };
  return { v: SIM_VERSION_V5, ruleset: RULESET_V4, seed, budget: { mode: 'unlimited', limit: 999999 }, teamA, teamB };
}

export function campaignBattleReplay(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number): ReplayConfig {
  return persistentBattleReplay(fleet, capEnemyToFleet(enemy, campaignFleetPower(fleet)), seed);
}

/**
 * 战略敌军舰队生成。
 * 以 StarSystem.enemyPower 为主要权威预算来源，相同 seed / 星域 / 星系 / enemyPower
 * 必须生成完全相同的敌方舰队（确定性）。不新增舰种、不改舰船参数。
 * 不采用战役式的"按玩家战力压缩"安全上限——敌方强度即设计强度。
 */
export function strategicEnemyFleetFor(
  seed: number,
  enemyPower: number,
  opts: { sectorIndex: number; gateGuard: boolean; cruiserAllowed: boolean }
): FleetEntry[] {
  const threatLevel = Math.min(4, Math.max(0, opts.sectorIndex - 1) + (opts.gateGuard ? 2 : 0));
  const pool = candidatePool(opts.sectorIndex, threatLevel, opts.gateGuard)
    .filter((entry) => opts.cruiserAllowed || entry.shipClass !== 'Cruiser');
  const target = Math.max(50, Math.round(enemyPower));
  const result = new Map<string, FleetEntry>();
  let total = 0;
  for (let slot = 0; slot < 24 && total < target; slot++) {
    const choices = pool
      .map((entry) => ({
        entry,
        cost: campaignShipCost(entry.shipClass, entry.variant),
        tie: hash32(seed, 'strategic', opts.sectorIndex, slot, entry.shipClass, entry.variant)
      }))
      .filter(({ cost }) => total + cost <= target + 0.001)
      .sort((a, b) => {
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

function sameHull(a: PersistentShip, battle: BattleState['ships'][number]): boolean {
  return a.shipClass === battle.type && a.variant === battle.variant;
}

/**
 * 严格校验战略/战役战斗 binding：
 * - campaignShipId 唯一、battleShipId 唯一；
 * - 每个 binding 都能在持久舰队中找到对应舰，且未部署舰不得参战；
 * - 每个 binding 都能在 Team A 战斗舰中找到对应舰；
 * - 持久舰 shipClass/variant 与 battle ship type/variant 一致（hull 与改型一致）；
 * - 组件数组长度与舰船定义一致（顺序由同一 ship 定义保证）；
 * - 组件 HP 有限且落在 [0, maxHp]；
 * - 每艘实际参战的玩家舰有且只有一个 binding（未参战舰不得被错误修改）。
 * 任何一项不成立都抛出明确错误。
 */
export function validatePersistentBattleBindings(
  bindings: ReadonlyArray<PersistentBattleBinding>,
  fleet: PersistentFleet,
  battle: BattleState
): void {
  const campaignIds = new Set<string>();
  const battleIds = new Set<number>();
  for (const binding of bindings) {
    if (campaignIds.has(binding.campaignShipId)) throw new Error('战斗绑定包含重复的 campaignShipId。');
    campaignIds.add(binding.campaignShipId);
    if (battleIds.has(binding.battleShipId)) throw new Error('战斗绑定包含重复的 battleShipId。');
    battleIds.add(binding.battleShipId);

    const ship = fleet.ships.find((candidate) => candidate.campaignShipId === binding.campaignShipId);
    if (!ship) throw new Error(`绑定 campaignShipId ${binding.campaignShipId} 找不到对应的持久舰。`);
    if (ship.deployed === false) throw new Error(`未部署舰 ${binding.campaignShipId} 不应出现在战斗绑定中。`);

    const battleShip = battle.ships.find((candidate) => candidate.id === binding.battleShipId && candidate.team === 'A');
    if (!battleShip) throw new Error(`绑定 battleShipId ${binding.battleShipId} 找不到对应的 Team A 战斗舰。`);
    if (ship.shipClass !== battleShip.type) throw new Error('持久舰 shipClass 与战斗舰 hull 不匹配。');
    if (ship.variant !== battleShip.variant) throw new Error('持久舰 variant 与战斗舰改型不匹配。');

    const def = getShipDef(ship.shipClass, ship.variant).def;
    if (ship.componentHp && ship.componentHp.length !== def.components.length) {
      throw new Error('持久舰 componentHp 长度与舰船定义不一致。');
    }
    if (battleShip.components.length !== def.components.length) {
      throw new Error('战斗舰组件数量与舰船定义不一致。');
    }
    if (ship.componentHp) {
      for (let i = 0; i < ship.componentHp.length; i++) {
        const hp = ship.componentHp[i];
        if (!Number.isFinite(hp) || hp < 0 || hp > def.components[i].maxHp) {
          throw new Error('持久舰组件 HP 越界（应为有限值且落在 [0, maxHp]）。');
        }
      }
    }
  }
  const participating = battle.ships.filter((candidate) => candidate.team === 'A');
  for (const battleShip of participating) {
    const count = bindings.filter((binding) => binding.battleShipId === battleShip.id).length;
    if (count !== 1) throw new Error(`Team A 战斗舰 #${battleShip.id} 的绑定数量不为 1（实际 ${count}）。`);
  }
}

/** 将持久舰队的已部署未失能舰与战斗 Team A 舰建成稳定绑定，并注入组件 HP。缺失/重复/结构不匹配立即报错。 */
function bindPersistentBattle(state: BattleState, fleet: PersistentFleet, label: string): PersistentBattleBinding[] {
  const remaining = [...activeShips(fleet)].sort((a, b) => a.campaignShipId.localeCompare(b.campaignShipId));
  const bindings: PersistentBattleBinding[] = [];
  for (const battleShip of state.ships.filter((ship) => ship.team === 'A').sort((a, b) => a.id - b.id)) {
    const index = remaining.findIndex((ship) => sameHull(ship, battleShip));
    if (index < 0) throw new Error(`无法为战斗舰船 #${battleShip.id} 建立${label}绑定。`);
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
  if (remaining.length) throw new Error(`存在未绑定的可参战${label}舰船。`);
  return bindings;
}

export function prepareCampaignBattle(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number): CampaignBattleContext {
  const balancedEnemy = capEnemyToFleet(enemy, campaignFleetPower(fleet));
  const replay = campaignBattleReplay(fleet, balancedEnemy, seed);
  const rng = createPRNG(seed);
  const state = createInitialState(replay, rng);
  const bindings = bindPersistentBattle(state, fleet, '战役');
  return { origin: 'campaign', replay, state, rng, bindings, battleSeed: seed };
}

/** 战略战斗准备：不压缩敌军（敌方强度由 StarSystem.enemyPower 决定），其余与战役一致。 */
export function prepareStrategicBattle(fleet: PersistentFleet, enemy: FleetEntry[], seed: number): StrategicBattleContext {
  const replay = persistentBattleReplay(fleet, enemy, seed);
  const rng = createPRNG(seed);
  const state = createInitialState(replay, rng);
  const bindings = bindPersistentBattle(state, fleet, '战略');
  return { origin: 'strategy', replay, state, rng, bindings, battleSeed: seed };
}

export function runCampaignBattle(fleet: PersistentFleet, enemy: ReturnType<typeof enemyFleetFor>, seed: number) {
  const context = prepareCampaignBattle(fleet, enemy, seed);
  const sim = createSimulator(context.state, context.rng);
  while (!context.state.finished) sim.step();
  return { state: context.state, context };
}
