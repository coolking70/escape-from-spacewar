import { BattleState, FleetEntry, ShipClass, ShipVariant, Team } from '../../sim/battleTypes';
import { getShipDef, getVariantDef, VARIANTS } from '../../sim/shipVariants';
import { hash32 } from '../sector/sectorGenerator';
import { DeploymentSelection } from '../deployment/deploymentSystem';
import { PersistentFleet, PersistentShip, createStarterFleet } from './persistentFleet';

const STANDARD_COST: Record<ShipClass, number> = {
  Fighter: 50,
  Frigate: 150,
  Cruiser: 360
};

/**
 * 战略敌军实际可用的最低合法舰船成本（= 所有舰种/改型中的最小成本）。
 * 当前为侦察型 Fighter（45）。任何低于此值的"残余敌方战力"无法代表一艘合法舰船，
 * 必须归零并转为 neutral，否则会导致存档无法满足"敌方控制 → 合法正预算"的校验（无法保存）。
 * 所有相关模块（strategicEnemyFleetFor / validateUniverseState / 战后残余归一化 / 存档迁移 /
 * enemyExpansion / 测试）都必须复用此权威值，不得散落魔法数字 45 / 50。
 */
const MINIMUM_STRATEGIC_FLEET_COST = Math.min(...Object.values(VARIANTS).map((variant) => variant.cost));

export function minimumStrategicFleetCost(): number {
  return MINIMUM_STRATEGIC_FLEET_COST;
}

/**
 * 战略敌军候选舰池（与 `enemyFleetFor` 共用同一套确定性候选规则）。
 * 注意：Fighter 的 standard / interceptor / scout 改型在任意 sectorIndex / gateGuard 下都恒在池中，
 * 因此候选池最低成本始终等于全局最低改型成本（侦察型 Fighter = 45）。
 * 该池被 `strategicEnemyFleetFor` 与 `minimumStrategicFleetCostFor` 共同复用，避免两处各自维护名单。
 */
export function candidatePool(sectorIndex: number, threatLevel: number, gateGuard: boolean): FleetEntry[] {
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

/**
 * 给定战略参数时，战略敌军候选池中实际可用的最低合法舰船成本。
 * 与 `minimumStrategicFleetCost()` 不同，本函数仅考虑该 sectorIndex / gateGuard / cruiserAllowed
 * 下真正可能进入战场的候选改型（例如 cruiserAllowed=false 时剔除所有 Cruiser）。
 * 由于 Fighter:scout（45）恒在池中，本函数对任意合法 opts 都应等于 `minimumStrategicFleetCost()`——
 * 测试必须证明这一点（候选池最低成本 === 全局最低改型成本），而非仅等于全项目所有改型的最低成本。
 */
export function minimumStrategicFleetCostFor(opts: {
  sectorIndex: number;
  gateGuard: boolean;
  cruiserAllowed: boolean;
}): number {
  const threatLevel = Math.min(4, Math.max(0, opts.sectorIndex - 1) + (opts.gateGuard ? 2 : 0));
  const pool = candidatePool(opts.sectorIndex, threatLevel, opts.gateGuard).filter(
    (entry) => opts.cruiserAllowed || entry.shipClass !== 'Cruiser'
  );
  if (!pool.length) throw new Error('战略敌军候选池为空，无法计算最低合法成本。');
  return Math.min(...pool.map((entry) => campaignShipCost(entry.shipClass, entry.variant)));
}

/**
 * 敌军战力归一化：任何低于最低合法舰船成本的残余战力一律归零（转为 neutral），
 * 否则既不能代表一艘合法舰船，又会使存档无法通过校验（无法保存）。
 * 对于合法预算（>= 最低成本）原样保留其四舍五入后的值。
 */
export function normalizeStrategicEnemyPower(rawPower: number): number {
  const value = Math.max(0, Math.round(rawPower));
  return value < minimumStrategicFleetCost() ? 0 : value;
}

export type EncounterDanger = 'favorable' | 'even' | 'dangerous' | 'overwhelming';

export interface EncounterAssessment {
  playerPower: number;
  enemyPower: number;
  ratio: number;
  danger: EncounterDanger;
  label: string;
}

export function campaignShipCost(shipClass: ShipClass, variant: ShipVariant): number {
  return variant === 'standard' ? STANDARD_COST[shipClass] : getVariantDef(variant).cost;
}

export function campaignFleetEntryCost(entries: FleetEntry[]): number {
  return entries.reduce(
    (sum, entry) => sum + campaignShipCost(entry.shipClass, entry.variant) * Math.max(0, Math.floor(entry.count)),
    0
  );
}

/**
 * 舰队预算别名（与 `campaignFleetEntryCost` 等价），用于表示"一份 FleetEntry 的权威价值"。
 * 战略敌军生成、战后敌方剩余战力、迁移换算都必须复用同一套成本单位。
 */
export function fleetEntryBudget(entries: FleetEntry[]): number {
  return campaignFleetEntryCost(entries);
}

/**
 * 计算一场真实 core-v4 战斗中某一方（Team A / B）的剩余战略价值。
 * 与持久舰战力使用同一套成本单位：
 * - destroyed / disabled 不贡献价值（0）；
 * - operational / escaped 按 cost × 组件完整度计算；
 * - 不存在于战斗中的虚构单位贡献 0。
 * 取整误差在共享函数层统一解决（Math.round），避免不同调用处各自四舍五入导致
 * 战前 26 因换算变成战后 50 这类明显上涨。
 */
export function battleTeamRemainingPower(state: BattleState, team: Team): number {
  let total = 0;
  for (const ship of state.ships.filter((candidate) => candidate.team === team)) {
    if (ship.combatState === 'destroyed' || ship.combatState === 'disabled') continue;
    const cost = campaignShipCost(ship.type, ship.variant);
    const max = ship.components.reduce((sum, component) => sum + component.maxHp, 0);
    const current = ship.components.reduce(
      (sum, component) => sum + Math.max(0, Math.min(component.maxHp, component.hp)),
      0
    );
    const integrity = max > 0 ? current / max : 0;
    total += cost * integrity;
  }
  return Math.max(0, Math.round(total));
}

/** 新游戏起始舰队（三艘初始舰）的满状态 core-v4 价值，用作敌方预算基准。 */
export function strategicBaselineFleetPower(): number {
  return campaignFleetPower(createStarterFleet());
}

/**
 * 新星域敌方预算的官方系数表（相对基准舰队价值）。
 * - 普通据点：约 55%～85%；
 * - 星门守卫：约 95%～150%；
 * 整体随星域序号提升，保证难度随推进上升且第一星域星门构成真实战斗。
 */
const OUTPOST_FACTORS = [0.55, 0.78, 0.85];
const GATE_FACTORS = [0.95, 1.2, 1.5];

/**
 * 权威敌方预算：某星域（普通据点 / 星门守卫）按 core-v4 舰船成本计算应生成的敌军总价值。
 * 不得再使用与舰船成本无关的 20～70 小数值。
 */
export function systemEnemyBudget(sectorIndex: number, gateGuard: boolean): number {
  const baseline = strategicBaselineFleetPower();
  const index = Math.min(2, Math.max(0, Math.floor(sectorIndex) - 1));
  const factor = gateGuard ? GATE_FACTORS[index] : OUTPOST_FACTORS[index];
  // 下限使用权威最低合法舰船成本（不再使用与舰船成本无关的魔法数字 50）。
  return Math.max(minimumStrategicFleetCost(), Math.round(baseline * factor));
}

function componentIntegrity(ship: PersistentShip): number {
  if (!ship.componentHp?.length) return 1;
  const def = getShipDef(ship.shipClass, ship.variant).def;
  const max = def.components.reduce((sum, component) => sum + component.maxHp, 0);
  const current = ship.componentHp.reduce((sum, hp, index) => {
    const cap = def.components[index]?.maxHp ?? 0;
    return sum + Math.max(0, Math.min(cap, hp));
  }, 0);
  return max > 0 ? current / max : 0;
}

export function persistentShipPower(ship: PersistentShip): number {
  if (ship.disabled) return 0;
  return Math.round(campaignShipCost(ship.shipClass, ship.variant) * (0.35 + componentIntegrity(ship) * 0.65));
}

export function campaignFleetPower(
  fleet: PersistentFleet,
  deployment?: DeploymentSelection
): number {
  const selected = deployment ? new Set(deployment.selectedShipIds) : null;
  return fleet.ships.reduce((sum, ship) => {
    if (selected && !selected.has(ship.campaignShipId)) return sum;
    if (!selected && ship.deployed === false) return sum;
    return sum + persistentShipPower(ship);
  }, 0);
}

export function assessEncounter(playerPower: number, enemyPower: number): EncounterAssessment {
  const ratio = playerPower > 0 ? enemyPower / playerPower : Number.POSITIVE_INFINITY;
  const danger: EncounterDanger =
    ratio <= 0.8 ? 'favorable' : ratio <= 1.1 ? 'even' : ratio <= 1.35 ? 'dangerous' : 'overwhelming';
  const label = {
    favorable: '优势',
    even: '势均力敌',
    dangerous: '危险',
    overwhelming: '极度危险'
  }[danger];
  return { playerPower, enemyPower, ratio, danger, label };
}
