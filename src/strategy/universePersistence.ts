import { generateUniverse, hash32 } from './universeGenerator';
import { FACILITY_DEFINITIONS, RESEARCH_DEFINITIONS } from './universeRules';
import { getShipDef, VARIANTS, VARIANTS_BY_CLASS } from '../sim/shipVariants';
import { validateFleet } from '../sim/fleetValidator';
import { strategicEnemyFleetFor } from '../campaign/fleet/battleAdapter';
import { campaignFleetEntryCost, campaignFleetPower, campaignShipCost, minimumStrategicFleetCost, normalizeStrategicEnemyPower } from '../campaign/fleet/campaignPower';
import { createStarterFleet } from '../campaign/fleet/persistentFleet';
import type { FleetEntry, ShipClass, ShipVariant } from '../sim/battleTypes';
import type { PersistentFleet, PersistentShip } from '../campaign/fleet/persistentFleet';
import {
  SECTOR_EXPEDITION_VERSION,
  type SectorExpeditionVersion
} from './universeTypes';
import type {
  CrisisPhase,
  FacilityType,
  PendingStrategicBattle,
  PermanentBlueprintId,
  ResearchProjectId,
  SpaceEntityKind,
  StarType,
  SystemControl,
  UniverseState
} from './universeTypes';

const STORAGE_KEY = 'spacewar.strategic-universe.current.v1';
const FACILITIES = Object.keys(FACILITY_DEFINITIONS) as FacilityType[];
const RESEARCH = Object.keys(RESEARCH_DEFINITIONS) as ResearchProjectId[];
const BLUEPRINTS: PermanentBlueprintId[] = ['fieldLogistics', 'hardenedBulkheads', 'compactFoundry'];
const ENTITY_KINDS: SpaceEntityKind[] = ['planet', 'moon', 'station', 'asteroidField', 'relicSite', 'jumpGate'];
const STAR_TYPES: StarType[] = ['yellowDwarf', 'redDwarf', 'blueGiant', 'whiteDwarf', 'binary'];
const CONTROLS: SystemControl[] = ['unknown', 'neutral', 'player', 'enemy'];
const CRISIS_PHASES: CrisisPhase[] = ['foothold', 'contest', 'collapse', 'evacuation'];

interface UniverseEnvelope {
  type: 'spacewar-sector-expedition';
  v: SectorExpeditionVersion;
  state: UniverseState;
}

/** 一份 FleetEntry 的离散装箱容差：实际舰队成本与预算的差值应小于最便宜合法舰船成本（权威值，不散落魔法数字）。 */
const DISCRETE_TOLERANCE = minimumStrategicFleetCost();
/** alpha.4 合法敌方预算下限：不得小于最低合法战略舰船成本（1～下限-1 视为非法）。 */
const MIN_ENEMY_BUDGET = minimumStrategicFleetCost();

function b64(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(source: string): string {
  let value = source.replace(/-/g, '+').replace(/_/g, '/');
  value += '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function uniqueValid<T>(items: unknown, allowed: readonly T[]): items is T[] {
  return Array.isArray(items) && new Set(items).size === items.length && items.every((item) => allowed.includes(item as T));
}

const SHIP_CLASSES: ShipClass[] = ['Fighter', 'Frigate', 'Cruiser'];
const ALL_VARIANTS: ShipVariant[] = Object.keys(VARIANTS) as ShipVariant[];
/** 旧抽象舰队迁移用的确定性初始舰船模板（前 3 艘保留新游戏的初始舰种/改型）。 */
const STRATEGIC_STARTER_TEMPLATE: Array<{ shipClass: ShipClass; variant: ShipVariant }> = [
  { shipClass: 'Fighter', variant: 'standard' },
  { shipClass: 'Fighter', variant: 'interceptor' },
  { shipClass: 'Frigate', variant: 'standard' }
];

function validShipClass(value: unknown): value is ShipClass {
  return typeof value === 'string' && (SHIP_CLASSES as string[]).includes(value);
}

function validVariant(value: unknown): value is ShipVariant {
  return typeof value === 'string' && (ALL_VARIANTS as string[]).includes(value);
}

function validateStrategicShips(ships: unknown): ships is PersistentShip[] {
  if (!Array.isArray(ships) || ships.length === 0) return false;
  const ids = new Set<string>();
  for (const ship of ships) {
    if (!ship || typeof ship !== 'object') return false;
    const record = ship as Record<string, unknown>;
    if (typeof record.campaignShipId !== 'string' || !record.campaignShipId) return false;
    if (ids.has(record.campaignShipId)) return false;
    ids.add(record.campaignShipId);
    if (!validShipClass(record.shipClass)) return false;
    if (!validVariant(record.variant)) return false;
    if (!VARIANTS_BY_CLASS[record.shipClass as ShipClass].includes(record.variant as ShipVariant)) return false;
    if (typeof record.disabled !== 'boolean' || typeof record.escaped !== 'boolean' || typeof record.towed !== 'boolean') return false;
    if (record.deployed !== undefined && typeof record.deployed !== 'boolean') return false;
    // alpha.5 语义：escaped 仅表示"脱离本次战斗"，属于战斗运行时状态，不得长期持久化。
    // 任何 escaped===true 的持久舰都拒绝（直接导入的损坏存档拒绝，而非静默修复）。
    if (record.escaped !== false) return false;
    if (record.componentHp !== undefined) {
      if (!Array.isArray(record.componentHp)) return false;
      const def = getShipDef(record.shipClass as ShipClass, record.variant as ShipVariant).def;
      if (record.componentHp.length !== def.components.length) return false;
      for (let i = 0; i < def.components.length; i++) {
        const hp = record.componentHp[i];
        if (typeof hp !== 'number' || !Number.isFinite(hp) || hp < 0 || hp > def.components[i].maxHp) return false;
      }
    }
  }
  return true;
}

function validatePendingBattle(pending: unknown, state: UniverseState): boolean {
  if (!pending || typeof pending !== 'object') return false;
  const record = pending as Record<string, unknown>;
  if (typeof record.battleId !== 'string' || !record.battleId) return false;
  if (typeof record.systemId !== 'string' || !state.systems.some((system) => system.id === record.systemId)) return false;
  if (!nonNegativeInteger(record.battleSeed) || (record.battleSeed as number) > 0xffffffff) return false;
  if (!nonNegativeInteger(record.enemyPowerBefore)) return false;
  if (!Array.isArray(record.enemyFleet)) return false;
  if (!validateFleet(record.enemyFleet).valid) return false;
  const system = state.systems.find((candidate) => candidate.id === record.systemId);
  if (!system) return false;
  // systemId 必须等于舰队当前所在星系；对应星系必须为敌方且 enemyPower 与 pending 一致。
  if (record.systemId !== state.fleet.systemId) return false;
  if (system.control !== 'enemy' || system.enemyPower <= 0) return false;
  if (system.enemyPower !== record.enemyPowerBefore) return false;
  // enemyFleet 实际成本与 enemyPowerBefore 一致（在明确离散容差内）。
  const fleetCost = campaignFleetEntryCost(record.enemyFleet as FleetEntry[]);
  if (Math.abs(fleetCost - (record.enemyPowerBefore as number)) > DISCRETE_TOLERANCE) return false;
  if (record.deployment !== undefined) {
    const dep = record.deployment as Record<string, unknown>;
    if (!dep || typeof dep !== 'object' || !Array.isArray(dep.selectedShipIds)) return false;
    const ids = dep.selectedShipIds as unknown[];
    if (!ids.every((id) => typeof id === 'string')) return false;
    if (new Set(ids).size !== ids.length) return false;
    const owned = new Set(state.fleet.ships.map((ship) => ship.campaignShipId));
    if (!ids.every((id) => owned.has(id as string))) return false;
    if (ids.some((id) => state.fleet.ships.find((ship) => ship.campaignShipId === id)?.disabled)) return false;
  }
  return true;
}

/**
 * 将 alpha.3（旧量纲）各星系敌战力确定性重建为对应敌舰的真实 core-v4 总成本。
 * 旧量纲敌战力较小（多为 1..70），低于最低合法舰船成本（45）的残余会被归一化为 0 并转 neutral
 * （不可代表一艘合法舰船，也不应被恢复成完整舰船）。
 * 若已存在待处理战斗，则保留其 enemyFleet（不重抽），并将 enemyPowerBefore 与对应星系 enemyPower
 * 同步为该舰队真实成本；若 pending enemyFleet 为空或成本为 0，则清除 pending 并将对应星系复位为 neutral。
 * 确定性：同一存档重复迁移得到完全相同的状态。
 */
function rebuildLegacyAlpha3EnemyPowers(state: UniverseState): void {
  for (const system of state.systems) {
    if (system.control !== 'enemy' || system.enemyPower <= 0) continue;
    const isGate = state.entities.some((entity) => entity.systemId === system.id && entity.kind === 'jumpGate');
    const seed = hash32(state.seed, system.id, 'alpha-enemy-rebuild');
    const fleet = strategicEnemyFleetFor(seed, system.enemyPower, {
      sectorIndex: state.sectorIndex,
      gateGuard: isGate,
      cruiserAllowed: state.sectorIndex >= 2 || isGate
    });
    const cost = campaignFleetEntryCost(fleet);
    system.enemyPower = cost;
    if (cost === 0) system.control = 'neutral';
  }
  normalizePendingBattleForAlpha5(state);
}

/**
 * alpha.4 敌战力归一化：alpha.4 已使用 core-v4 量纲，不应再交给敌军生成器重建（否则低残余会被重抽成整舰）。
 * - enemyPower === 0 → 保持 0；
 * - 0 < enemyPower < 最低合法舰船成本 → 归一化为 0 并转 neutral；
 * - enemyPower >= 最低合法舰船成本 → 保留原值（不再重抽）。
 */
function normalizeAlpha4EnemyPowers(state: UniverseState): void {
  for (const system of state.systems) {
    if (system.control !== 'enemy') continue;
    const normalized = normalizeStrategicEnemyPower(system.enemyPower);
    if (normalized === 0) {
      system.enemyPower = 0;
      system.control = 'neutral';
    } else {
      system.enemyPower = normalized;
    }
  }
  normalizePendingBattleForAlpha5(state);
}

/**
 * alpha.5 待处理战斗归一化：保留 pending 的 enemyFleet（不重新抽取），
 * 将 enemyPowerBefore 与该星系 enemyPower 同步为敌舰真实成本；
 * 若 pending enemyFleet 为空或成本为 0（无效空敌军 / 迁移后无法组成合法敌军的低残余），
 * 则清除 pending 并将对应星系复位为 neutral，并写入迁移日志。
 */
function normalizePendingBattleForAlpha5(state: UniverseState): void {
  const pending = state.pendingBattle;
  if (!pending) return;
  const system = state.systems.find((candidate) => candidate.id === pending.systemId);
  if (!system) {
    state.pendingBattle = undefined;
    return;
  }
  const fleetCost = campaignFleetEntryCost(pending.enemyFleet);
  if (fleetCost <= 0) {
    state.pendingBattle = undefined;
    system.enemyPower = 0;
    system.control = 'neutral';
    return;
  }
  pending.enemyPowerBefore = fleetCost;
  system.enemyPower = fleetCost;
}

/**
 * 旧 V1.0-A 抽象战力 → core-v4 预算的确定性换算。
 * 旧模型以每艘舰约 28 点满状态抽象战力为基准；先在 core-v4 量纲构建同 shipCount 的
 * 确定性模板舰队（首 3 艘沿用初始舰种/改型，其余为 Fighter standard），计算其满状态总成本，
 * 再以 旧 combatPower / 理论满状态抽象战力 的比例映射到目标 core-v4 价值。
 * 比例集中、无散落魔法数字，保证单调性（combatPower 越高 → 迁移战力不下降）。
 */
export function legacyAbstractPowerToCoreBudget(shipCount: number, combatPower: number): number {
  const perShipAbstract = 28;
  const template = buildAbstractTemplate(shipCount);
  const templateFull = template.reduce((sum, entry) => sum + campaignShipCost(entry.shipClass, entry.variant), 0);
  const maxAbstract = shipCount * perShipAbstract;
  if (maxAbstract <= 0 || templateFull <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, combatPower / maxAbstract));
  return Math.max(0, Math.round(templateFull * ratio));
}

/** 构建与 shipCount 对应的确定性模板舰种/改型序列。 */
function buildAbstractTemplate(shipCount: number): Array<{ shipClass: ShipClass; variant: ShipVariant }> {
  const template = STRATEGIC_STARTER_TEMPLATE.slice();
  while (template.length < shipCount) template.push({ shipClass: 'Fighter', variant: 'standard' });
  return template.slice(0, shipCount);
}

/**
 * 为 alpha.2 舰队构建真实逐舰 PersistentShip[]：用真实 `campaignFleetPower`（cost × (0.35 + 完整度 × 0.65)）
 * 做二分搜索校准统一完整度，使迁移后真实战力尽可能接近目标 core-v4 预算 `legacyAbstractPowerToCoreBudget`，
 * 而非简单按 cost × 完整度 比例（后者与真实战力公式不一致）。
 * - disabled 舰的关键组件（core/engine/weapon）确定性归零，体现真实关键组件损毁，且其战力恒为 0（不计入目标）；
 * - operational 舰经二分搜索得到最接近目标的统一完整度；离散取整误差有界（单舰完整度取整步长）；
 * - 极低 combatPower 不会得到近满血舰队（r 收敛到接近 0，组件 hp 接近 0）。
 * 全程确定性：相同输入得到完全相同的舰船组件 HP。
 */
function migrateAlpha2Fleet(shipCount: number, disabledShips: number, combatPower: number): PersistentShip[] {
  const template = buildAbstractTemplate(shipCount);
  const targetPower = legacyAbstractPowerToCoreBudget(shipCount, combatPower);
  const disabledSet = new Set(
    Array.from({ length: Math.min(shipCount - 1, Math.max(0, disabledShips)) }, (_, i) => shipCount - 1 - i)
  );
  const ships: PersistentShip[] = template.map((entry, index) => {
    const def = getShipDef(entry.shipClass, entry.variant).def;
    const forceKeyZero = disabledSet.has(index);
    const componentHp = def.components.map((component) => component.maxHp);
    if (forceKeyZero) {
      const keyIndex = def.components.findIndex(
        (component) => component.type === 'core' || component.type === 'engine' || component.type === 'weapon'
      );
      if (keyIndex >= 0) componentHp[keyIndex] = 0;
    }
    return {
      campaignShipId: `cs-${index}`,
      shipClass: entry.shipClass,
      variant: entry.variant,
      disabled: forceKeyZero,
      escaped: false,
      towed: false,
      deployed: true,
      componentHp
    };
  });
  const persistent: PersistentFleet = {
    ships,
    formation: 'line',
    doctrine: 'balanced'
  };
  const applyIntegrity = (r: number): void => {
    for (let i = 0; i < ships.length; i++) {
      if (!ships[i].componentHp) ships[i].componentHp = getShipDef(ships[i].shipClass, ships[i].variant).def.components.map((c) => c.maxHp);
      const def = getShipDef(ships[i].shipClass, ships[i].variant).def;
      for (let c = 0; c < def.components.length; c++) {
        if (disabledSet.has(i) && (def.components[c].type === 'core' || def.components[c].type === 'engine' || def.components[c].type === 'weapon')) {
          ships[i].componentHp![c] = 0;
        } else {
          ships[i].componentHp![c] = Math.max(0, Math.min(def.components[c].maxHp, Math.round(def.components[c].maxHp * r)));
        }
      }
    }
  };
  // 二分搜索统一完整度 r，使真实 campaignFleetPower 最接近目标预算（仅 operational 舰贡献战力）。
  let bestErr = Math.abs(campaignFleetPower(persistent) - targetPower);
  let bestLevel = ships.map((ship) => (ship.componentHp ? ship.componentHp.slice() : []));
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 48; iter++) {
    const mid = (lo + hi) / 2;
    applyIntegrity(mid);
    const power = campaignFleetPower(persistent);
    const err = Math.abs(power - targetPower);
    if (err < bestErr) {
      bestErr = err;
      bestLevel = ships.map((ship) => (ship.componentHp ? ship.componentHp.slice() : []));
    }
    if (power < targetPower) lo = mid;
    else hi = mid;
  }
  for (let i = 0; i < ships.length; i++) ships[i].componentHp = bestLevel[i];
  return ships;
}

/** 旧版存档（alpha.2/3/4）逐舰语义归一化：
 * - escaped 仅表示"脱离本次战斗"，并不离开舰队；持久舰队中的舰船 escaped 必须归零
 *   （新战斗写回会按 combatState 重新归一化，写回后 escaped 恒为 false）。
 * - 缺失 deployed 视为 true（默认参战）。
 * - disabled 保持不变（失能舰仍在舰队，只是不能作战）。
 * 归一化后满足 strategicFleetCounts.operational === activeShips(toPersistentFleet(fleet)).length。 */
function normalizeLegacyFleet(fleet: any): void {
  if (!fleet || !Array.isArray(fleet.ships)) return;
  for (const ship of fleet.ships) {
    if (ship.escaped) ship.escaped = false;
    if (ship.deployed === undefined) ship.deployed = true;
    if (typeof ship.towed !== 'boolean') ship.towed = false;
  }
}

/** 旧抽象舰队（alpha.2）→ 真实逐舰舰队（alpha.5），并真实使用 combatPower 换算与敌战力重建。 */
function migrateAlpha2(raw: any): UniverseState | null {
  if (!raw || raw.version !== '1.0-alpha.2' || !nonNegativeInteger(raw.seed)) return null;
  const fleet = raw.fleet;
  if (!fleet || !positiveInteger(fleet.shipCount) || !nonNegativeInteger(fleet.disabledShips) || !positiveInteger(fleet.combatPower)) {
    return null;
  }
  const shipCount = fleet.shipCount as number;
  const disabledShips = Math.min(shipCount - 1, Math.max(0, fleet.disabledShips as number));
  const ships = migrateAlpha2Fleet(shipCount, disabledShips, fleet.combatPower as number);
  const migrated: any = JSON.parse(JSON.stringify(raw));
  migrated.version = SECTOR_EXPEDITION_VERSION;
  migrated.pendingBattle = undefined;
  migrated.fleet = {
    id: fleet.id,
    name: fleet.name,
    systemId: fleet.systemId,
    fuel: fleet.fuel,
    maxFuel: fleet.maxFuel,
    ships,
    formation: 'line',
    doctrine: 'balanced'
  };
  rebuildLegacyAlpha3EnemyPowers(migrated);
  if (!validateUniverseState(migrated)) return null;
  migrated.log.unshift({
    turn: 0,
    text: `旧版抽象舰队已转换为逐舰状态（${shipCount} 艘，其中 ${disabledShips} 艘失能；旧战力 ${fleet.combatPower} 已换算为 core-v4 价值）。`
  });
  return migrated as UniverseState;
}

/** alpha.3（已用真实逐舰舰队，但敌战力仍为旧量纲）→ alpha.5（敌战力改用 core-v4 价值量纲 + escaped 语义统一）。 */
function migrateAlpha3(raw: any): UniverseState | null {
  if (!raw || raw.version !== '1.0-alpha.3' || !nonNegativeInteger(raw.seed)) return null;
  const migrated: any = JSON.parse(JSON.stringify(raw));
  migrated.version = SECTOR_EXPEDITION_VERSION;
  normalizeLegacyFleet(migrated.fleet);
  migrated.pendingBattle = raw.pendingBattle ? JSON.parse(JSON.stringify(raw.pendingBattle)) : undefined;
  rebuildLegacyAlpha3EnemyPowers(migrated);
  if (!validateUniverseState(migrated)) return null;
  migrated.log.unshift({
    turn: 0,
    text: '旧版 alpha.3 星域远征已迁移至 alpha.5（敌战力改用 core-v4 舰船价值量纲、escaped 战略语义统一）。'
  });
  return migrated as UniverseState;
}

/** alpha.4（结构已与 alpha.5 基本一致，但 escaped 战略语义未统一）→ alpha.5（escaped 仅指脱离本次战斗、敌战力同量纲、存档校验强化）。 */
function migrateAlpha4(raw: any): UniverseState | null {
  if (!raw || raw.version !== '1.0-alpha.4' || !nonNegativeInteger(raw.seed)) return null;
  const migrated: any = JSON.parse(JSON.stringify(raw));
  migrated.version = SECTOR_EXPEDITION_VERSION;
  normalizeLegacyFleet(migrated.fleet);
  migrated.pendingBattle = raw.pendingBattle ? JSON.parse(JSON.stringify(raw.pendingBattle)) : undefined;
  normalizeAlpha4EnemyPowers(migrated);
  if (!validateUniverseState(migrated)) return null;
  migrated.log.unshift({
    turn: 0,
    text: '旧版 alpha.4 星域远征已迁移至 alpha.5（escaped 战略语义统一、敌战力同量纲、存档校验强化）。'
  });
  return migrated as UniverseState;
}

function migrateAlpha1(raw: any): UniverseState | null {
  if (!raw || raw.version !== '1.0-alpha.1' || !nonNegativeInteger(raw.seed)) return null;
  const factionName = typeof raw.faction?.name === 'string' ? raw.faction.name : '深空远征团';
  const migrated = generateUniverse(raw.seed, factionName);
  migrated.log.unshift({
    turn: 0,
    text: '旧版永久战略宇宙实验存档已重置为“单星域高速 SLG + 星门撤离”模式。'
  });
  return migrated;
}
export function validateUniverseState(value: unknown): value is UniverseState {
  const state = value as UniverseState;
  // 安全顺序：任何缺失/畸形结构都必须安全返回 false，绝不抛出（覆盖 undefined / null / {} / {version} / {fleet:null} / {fleet:{}}）。
  // 注意：此处用类型断言而非精确类型，是因为畸形存档的字段可能缺失；运行时通过下述逐项守卫确保不抛异常。
  if (!state || !state.version || state.version !== SECTOR_EXPEDITION_VERSION) return false;
  if (!nonNegativeInteger(state.seed) || !positiveInteger(state.sectorIndex) || !positiveInteger(state.targetSectorCount) ||
    state.sectorIndex > state.targetSectorCount || !nonNegativeInteger(state.turn)) return false;
  if (!['active', 'victory', 'collapsed'].includes(state.status)) return false;
  if (!Array.isArray(state.systems) || state.systems.length < 6) return false;
  if (!state.fleet || typeof state.fleet !== 'object' || !Array.isArray(state.fleet.ships) || state.fleet.ships.length < 1) return false;
  if (!state.crisis || !state.extraction) return false;
  if (!Array.isArray(state.entities) || !state.faction || !Array.isArray(state.log)) return false;
  if (
    !state.crisis || !CRISIS_PHASES.includes(state.crisis.phase) || !nonNegativeInteger(state.crisis.pressure) ||
    state.crisis.pressure > 100 || !positiveInteger(state.crisis.finalTurn)
  ) return false;
  if (
    !state.extraction || !positiveInteger(state.extraction.requiredCalibration) ||
    !nonNegativeInteger(state.extraction.calibration) || state.extraction.calibration > state.extraction.requiredCalibration ||
    !nonNegativeInteger(state.extraction.emergencyThreshold) ||
    state.extraction.emergencyThreshold > state.extraction.requiredCalibration ||
    typeof state.extraction.discovered !== 'boolean'
  ) return false;

  const systemIds = new Set(state.systems.map((system) => system.id));
  if (systemIds.size !== state.systems.length || !systemIds.has(state.selectedSystemId) || !systemIds.has(state.fleet.systemId)) return false;
  for (const system of state.systems) {
    if (!system.id || !system.name || !STAR_TYPES.includes(system.starType) || !CONTROLS.includes(system.control)) return false;
    if (
      !Number.isFinite(system.x) || !Number.isFinite(system.y) || !Array.isArray(system.entityIds) ||
      !Array.isArray(system.neighbors) || !nonNegativeInteger(system.enemyPower) ||
      typeof system.discovered !== 'boolean' || typeof system.surveyed !== 'boolean'
    ) return false;
    // 敌战力与星系控制必须一致：enemyPower===0 时不应为 enemy；control===enemy 时必须为合法正预算；
    // control 为 neutral/player 时 enemyPower 必须为 0；不得出现低于最低合法舰船成本的正 enemyPower。
    if (system.enemyPower === 0 && system.control === 'enemy') return false;
    if (system.control === 'enemy' && system.enemyPower < MIN_ENEMY_BUDGET) return false;
    if ((system.control === 'neutral' || system.control === 'player') && system.enemyPower !== 0) return false;
    if (new Set(system.neighbors).size !== system.neighbors.length || system.neighbors.includes(system.id)) return false;
    for (const neighborId of system.neighbors) {
      const neighbor = state.systems.find((candidate) => candidate.id === neighborId);
      if (!neighbor || !neighbor.neighbors.includes(system.id)) return false;
    }
  }

  const entityIds = new Set(state.entities.map((entity) => entity.id));
  if (
    entityIds.size !== state.entities.length || !entityIds.has(state.extraction.gateEntityId) ||
    state.entities.find((entity) => entity.id === state.extraction.gateEntityId)?.kind !== 'jumpGate'
  ) return false;
  for (const system of state.systems) {
    if (new Set(system.entityIds).size !== system.entityIds.length || system.entityIds.some((id) => !entityIds.has(id))) return false;
  }
  for (const entity of state.entities) {
    if (
      !entity.id || !entity.name || !systemIds.has(entity.systemId) || !ENTITY_KINDS.includes(entity.kind) ||
      !nonNegativeInteger(entity.orbit) || typeof entity.discovered !== 'boolean' || typeof entity.surveyed !== 'boolean'
    ) return false;
    const system = state.systems.find((candidate) => candidate.id === entity.systemId)!;
    if (!system.entityIds.includes(entity.id)) return false;
    if (entity.deposits && (!nonNegativeInteger(entity.deposits.minerals) || !nonNegativeInteger(entity.deposits.energy))) return false;
    if (entity.blueprint && !BLUEPRINTS.includes(entity.blueprint)) return false;
    if (entity.facilitySlots !== undefined && !positiveInteger(entity.facilitySlots)) return false;
    if (
      entity.facilities && entity.facilities.some((facility) =>
        !facility.id || !FACILITIES.includes(facility.type) || !positiveInteger(facility.level)
      )
    ) return false;
    if (
      entity.constructionQueue && (
        entity.constructionQueue.length > 2 ||
        entity.constructionQueue.some((order) =>
          !order.id || !FACILITIES.includes(order.facilityType) || !positiveInteger(order.turnsRemaining) ||
          !positiveInteger(order.totalTurns) || order.turnsRemaining > order.totalTurns
        )
      )
    ) return false;
    if ((entity.facilities || entity.constructionQueue) && entity.kind !== 'station') return false;
    if (
      entity.kind === 'station' && entity.facilitySlots !== undefined &&
      (entity.facilities?.length ?? 0) + (entity.constructionQueue?.length ?? 0) > entity.facilitySlots
    ) return false;
  }

  if (!state.faction.id || !state.faction.name || !state.faction.resources || !Array.isArray(state.faction.researchQueue)) return false;
  if (
    [
      state.faction.resources.minerals,
      state.faction.resources.energy,
      state.faction.resources.science,
      state.faction.resources.supplies
    ].some((amount) => !nonNegativeInteger(amount))
  ) return false;
  if (!uniqueValid(state.faction.localResearch, RESEARCH)) return false;
  if (
    state.faction.researchQueue.length > 2 ||
    state.faction.researchQueue.some((order) =>
      !order.id || !RESEARCH.includes(order.projectId) || !positiveInteger(order.turnsRemaining) ||
      !positiveInteger(order.totalTurns) || order.turnsRemaining > order.totalTurns ||
      state.faction.localResearch.includes(order.projectId)
    ) ||
    new Set(state.faction.researchQueue.map((order) => order.projectId)).size !== state.faction.researchQueue.length
  ) return false;
  if (
    !Array.isArray(state.faction.knownSystemIds) ||
    new Set(state.faction.knownSystemIds).size !== state.faction.knownSystemIds.length ||
    state.faction.knownSystemIds.some((id) => !systemIds.has(id))
  ) return false;
  if (!uniqueValid(state.faction.recoveredBlueprints, BLUEPRINTS)) return false;
  if (
    !state.faction.legacy || !nonNegativeInteger(state.faction.legacy.sectorsCleared) ||
    !nonNegativeInteger(state.faction.legacy.portableMaterials) || !nonNegativeInteger(state.faction.legacy.reserveSupplies) ||
    !nonNegativeInteger(state.faction.legacy.shipsLost) || !uniqueValid(state.faction.legacy.blueprints, BLUEPRINTS)
  ) return false;
  if (state.faction.baseEntityId) {
    const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId);
    if (
      !base || base.kind !== 'station' || base.ownerId !== state.faction.id ||
      !Array.isArray(base.facilities) || !Array.isArray(base.constructionQueue)
    ) return false;
  }

  if (
    !state.fleet.id || !state.fleet.name || !nonNegativeInteger(state.fleet.fuel) ||
    !positiveInteger(state.fleet.maxFuel) || state.fleet.fuel > state.fleet.maxFuel ||
    !['line', 'wedge', 'wall', 'swarm', 'random'].includes(state.fleet.formation) ||
    !['balanced', 'aggressive', 'defensive', 'kite', 'focusFire', 'antiCapital', 'screen'].includes(state.fleet.doctrine) ||
    !validateStrategicShips(state.fleet.ships)
  ) return false;
  if (state.pendingBattle && !validatePendingBattle(state.pendingBattle, state)) return false;
  return true;
}

export function encodeUniverse(state: UniverseState): string {
  if (!validateUniverseState(state)) throw new Error('星域战略远征状态无效。');
  const envelope: UniverseEnvelope = { type: 'spacewar-sector-expedition', v: SECTOR_EXPEDITION_VERSION, state };
  return b64(JSON.stringify(envelope));
}

export function decodeUniverse(code: string): UniverseState {
  let envelope: any;
  try {
    envelope = JSON.parse(unb64(code.trim()));
  } catch {
    throw new Error('星域远征码无法解析。');
  }
  if (envelope?.type === 'spacewar-strategic-universe' && envelope?.v === '1.0-alpha.1') {
    const migrated = migrateAlpha1(envelope.state);
    if (migrated) return migrated;
  }
  if (envelope?.type === 'spacewar-sector-expedition' && envelope?.v === '1.0-alpha.2') {
    const migrated = migrateAlpha2(envelope.state);
    if (migrated) return migrated;
  }
  if (envelope?.type === 'spacewar-sector-expedition' && envelope?.v === '1.0-alpha.3') {
    const migrated = migrateAlpha3(envelope.state);
    if (migrated) return migrated;
  }
  if (envelope?.type === 'spacewar-sector-expedition' && envelope?.v === '1.0-alpha.4') {
    const migrated = migrateAlpha4(envelope.state);
    if (migrated) return migrated;
  }
  if (
    envelope?.type !== 'spacewar-sector-expedition' || envelope?.v !== SECTOR_EXPEDITION_VERSION ||
    !validateUniverseState(envelope.state)
  ) throw new Error('星域远征码版本或结构无效。');
  return envelope.state;
}

export function saveUniverse(state: UniverseState): void {
  if (!validateUniverseState(state)) throw new Error('无法保存无效的星域战略远征。');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadUniverse(): UniverseState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (validateUniverseState(parsed)) return parsed;
    if (parsed && parsed.version === '1.0-alpha.2') {
      const migrated = migrateAlpha2(parsed);
      if (migrated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
    if (parsed && parsed.version === '1.0-alpha.4') {
      const migrated = migrateAlpha4(parsed);
      if (migrated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
    if (parsed && parsed.version === '1.0-alpha.3') {
      const migrated = migrateAlpha3(parsed);
      if (migrated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    }
    const migrated = migrateAlpha1(parsed);
    if (!migrated) throw new Error('结构无效');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    throw new Error('星域战略远征存档损坏或不兼容。');
  }
}

export function clearUniverse(): void {
  localStorage.removeItem(STORAGE_KEY);
}
