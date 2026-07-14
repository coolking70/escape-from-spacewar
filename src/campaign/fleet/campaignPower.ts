import { BattleState, FleetEntry, ShipClass, ShipVariant, Team } from '../../sim/battleTypes';
import { getShipDef, getVariantDef } from '../../sim/shipVariants';
import { DeploymentSelection } from '../deployment/deploymentSystem';
import { PersistentFleet, PersistentShip, createStarterFleet } from './persistentFleet';

const STANDARD_COST: Record<ShipClass, number> = {
  Fighter: 50,
  Frigate: 150,
  Cruiser: 360
};

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
  return Math.max(50, Math.round(baseline * factor));
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
