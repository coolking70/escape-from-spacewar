import { escapeHtml } from './html';
import {
  BLUEPRINT_LABEL,
  CRISIS_PHASE_LABEL,
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  canCalibrateGate,
  canAppointStrategicCommander,
  canAssignExtractionShip,
  canConfigureExtraction,
  canEngageEnemy,
  canEstablishBase,
  canEstablishOutpost,
  canExtractSector,
  canFitStrategicModule,
  canOpenCommanderRecruitment,
  canQueueFacility,
  canQueueShipProduction,
  canQueueResearch,
  canRepairShip,
  canTreatStrategicCommander,
  ownedStrategicStations,
  currentStrategicExtractionPlan,
  effectiveFacilityCost,
  effectiveShipProductionCost,
  strategicFleetCounts,
  strategicFleetPower,
  strategicIncomeReport,
  strategicHostilePowerAt,
  strategicTransportStatus,
  shipProductionTurns,
  travelFuelCost,
  universeTurnIncome
} from '../strategy/universeRules';
import { STRATEGIC_BLUEPRINT_EFFECTS } from '../strategy/strategicBlueprints';
import {
  STRATEGIC_MODULE_DEFINITIONS,
  STRATEGIC_MODULE_IDS,
  fittingForShip,
  strategicRepairCost
} from '../strategy/strategicFitting';
import { SHIP_CN, VARIANT_CN, VARIANTS_BY_CLASS, getShipDef } from '../sim/shipVariants';
import type { ShipClass, ShipVariant } from '../sim/battleTypes';
import type { PersistentShip } from '../campaign/fleet/persistentFleet';
import {
  COMMANDER_ATTRIBUTE_LABEL,
  COMMANDER_TRAIT_LABEL,
  ensureCommanderProfile
} from '../campaign/commander/commanderSystem';
import {
  COMMANDER_CONDITION_LABEL,
  COMMANDER_INJURY_LABEL,
  isCommanderAvailable
} from '../campaign/commander/commanderHealth';
import type {
  ExtractionAssignmentRole,
  FacilityType,
  ResearchProjectId,
  StrategicModuleId,
  SpaceEntity,
  SpaceEntityKind,
  StarType,
  SystemControl,
  UniverseAction,
  UniverseState
} from '../strategy/universeTypes';
import {
  isStrategicCommanderAvailable,
  isStrategicCommandLocked
} from '../strategy/universeCommander';

const STAR_LABEL: Record<StarType, string> = {
  yellowDwarf: '黄矮星',
  redDwarf: '红矮星',
  blueGiant: '蓝巨星',
  whiteDwarf: '白矮星',
  binary: '双星'
};

const CONTROL_LABEL: Record<SystemControl, string> = {
  unknown: '情报未知',
  neutral: '无主区域',
  player: '我方控制',
  enemy: '敌方控制'
};

const EXTRACTION_ROLE_LABEL: Record<ExtractionAssignmentRole, string> = {
  evacuate: '随队撤离',
  tow: '拖曳撤离',
  rearguard: '留守断后',
  abandon: '主动放弃'
};

const ENTITY_LABEL: Record<SpaceEntityKind, string> = {
  planet: '行星',
  moon: '卫星',
  station: '空间站',
  asteroidField: '小行星带',
  relicSite: '科研遗迹',
  jumpGate: '星门'
};

const ENTITY_ICON: Record<SpaceEntityKind, string> = {
  planet: '●',
  moon: '◌',
  station: '▣',
  asteroidField: '✦',
  relicSite: '◇',
  jumpGate: '◎'
};

function resourceCost(cost: { minerals?: number; energy?: number; science?: number; supplies?: number }): string {
  return [
    cost.minerals ? `矿物 ${cost.minerals}` : '',
    cost.energy ? `能源 ${cost.energy}` : '',
    cost.science ? `科学 ${cost.science}` : '',
    cost.supplies ? `补给 ${cost.supplies}` : ''
  ].filter(Boolean).join(' / ');
}

function entityDetails(entity: SpaceEntity): string {
  if (!entity.surveyed) return '尚未完成详细测绘。';
  const details: string[] = [];
  if (entity.habitability !== undefined) details.push(`宜居度 ${entity.habitability}%`);
  if (entity.deposits) details.push(`矿物 ${entity.deposits.minerals} · 能源 ${entity.deposits.energy}`);
  if (entity.ownerId) details.push('已建立前进基地');
  if (entity.blueprint) details.push(`蓝图：${BLUEPRINT_LABEL[entity.blueprint]}`);
  if (entity.facilitySlots) details.push(`设施槽 ${entity.facilitySlots}`);
  return details.join(' · ') || '未发现可直接利用的资源。';
}

/** 把撤离损失 ID 列表格式化为可读文本（显示具体舰船 ID，而非仅数量）。 */
function fmtLosses(ids: Iterable<string>): string {
  const arr = [...ids];
  return arr.length ? `${arr.length} 艘（${arr.join('、')}）` : '无';
}

function endState(state: UniverseState): string {
  if (state.status === 'active') return '';
  const victory = state.status === 'victory';
  const defeatReason = state.log[state.log.length - 1]?.text || '远征已结束。';
  return `<div class="strategy-end ${victory ? 'victory' : 'defeat'}"><h2>${victory ? '远征完成' : '星域崩溃'}</h2><p>${victory ? `已连续穿越 ${state.targetSectorCount} 个星域。` : escapeHtml(defeatReason)}</p></div>`;
}

function disabledReasonAttr(disabled: boolean, reason: string): string {
  return disabled
    ? ` disabled aria-disabled="true" title="${escapeHtml(reason)}"`
    : '';
}

const FOCUS_ATTRIBUTES = [
  'id',
  'data-strategy-system',
  'data-strategy-travel',
  'data-strategy-build',
  'data-strategy-produce-class',
  'data-strategy-research',
  'data-strategy-fit-module',
  'data-strategy-extraction-role'
] as const;

function focusedControl(root: HTMLElement): { attribute: string; value: string } | null {
  const active = root.ownerDocument.activeElement as HTMLElement | null;
  if (!active || !root.contains(active)) return null;
  for (const attribute of FOCUS_ATTRIBUTES) {
    const value = active.getAttribute(attribute);
    if (value) return { attribute, value };
  }
  return null;
}

function restoreFocusedControl(root: HTMLElement, identity: { attribute: string; value: string } | null): void {
  if (!identity) return;
  const match = Array.from(root.querySelectorAll<HTMLElement>(`[${identity.attribute}]`))
    .find((element) => element.getAttribute(identity.attribute) === identity.value);
  match?.focus();
}

/** 单艘舰的卡片：ID / 舰种 / 改型 / 状态 / 组件完整度 / 关键组件损毁提示 / 维修按钮。 */
function fleetShipRow(ship: PersistentShip, actionState: UniverseState, actionLocked: boolean, actionLockReason: string): string {
  const def = getShipDef(ship.shipClass, ship.variant).def;
  const maxTotal = def.components.reduce((sum, component) => sum + component.maxHp, 0);
  const curTotal = ship.componentHp
    ? ship.componentHp.reduce((sum, hp, i) => sum + Math.max(0, Math.min(hp, def.components[i]?.maxHp ?? 0)), 0)
    : maxTotal;
  const integrity = maxTotal > 0 ? Math.round((curTotal / maxTotal) * 100) : 100;
  const status = ship.disabled ? '失能' : ship.escaped ? '逃脱' : '作战';
  const statusClass = ship.disabled ? 'disabled' : ship.escaped ? 'escaped' : 'operational';
  const keyDestroyed = def.components.some(
    (component, i) => (component.type === 'core' || component.type === 'engine' || component.type === 'weapon') &&
      (ship.componentHp?.[i] ?? component.maxHp) <= 0
  );
  const warn = keyDestroyed ? ' <span class="ship-warn">⚠关键组件损毁</span>' : '';
  const repairCost = strategicRepairCost(actionState, ship.campaignShipId);
  const repairBtn = ship.disabled && canRepairShip(actionState, ship.campaignShipId)
    ? `<button class="btn small primary" data-strategy-repair="${escapeHtml(ship.campaignShipId)}"${disabledReasonAttr(actionLocked, actionLockReason)}>维修（${resourceCost(repairCost)}）</button>`
    : '';
  const fitting = fittingForShip(actionState, ship.campaignShipId);
  const base = actionState.entities.find((entity) => entity.id === actionState.faction.baseEntityId);
  const hasShipyard = !!base?.facilities?.some((facility) => facility.type === 'shipyard');
  const fittingControls = hasShipyard || fitting
    ? `<div class="strategic-fitting"><small>战略模块：${fitting ? STRATEGIC_MODULE_DEFINITIONS[fitting.moduleId].label : '空槽'}</small><div>${STRATEGIC_MODULE_IDS.map((moduleId) => {
        const definition = STRATEGIC_MODULE_DEFINITIONS[moduleId];
        const blocked = actionLocked || !canFitStrategicModule(actionState, ship.campaignShipId, moduleId);
        const reason = actionLocked ? actionLockReason : fitting?.moduleId === moduleId
          ? '该舰已经装配此模块。'
          : '需要舰队位于未被围攻的主基地、建有船坞且资源充足。';
        return `<button class="btn small ${fitting?.moduleId === moduleId ? 'complete' : ''}" data-strategy-fit-ship="${escapeHtml(ship.campaignShipId)}" data-strategy-fit-module="${moduleId}"${blocked ? disabledReasonAttr(true, reason) : ` title="${escapeHtml(definition.description)}"`}>${definition.label}<small>${resourceCost(definition.cost)}</small></button>`;
      }).join('')}${fitting ? `<button class="btn small" data-strategy-remove-module="${escapeHtml(ship.campaignShipId)}"${disabledReasonAttr(actionLocked || !canFitStrategicModule(actionState, ship.campaignShipId), actionLocked ? actionLockReason : '需要舰队位于未被围攻的主基地船坞。')}>卸下</button>` : ''}</div></div>`
    : '';
  return `<div class="fleet-ship ${statusClass}"><b>${escapeHtml(ship.campaignShipId)}</b><small>${SHIP_CN[ship.shipClass]} ${VARIANT_CN[ship.variant]}</small><span class="ship-status">${status}</span><span class="ship-integrity">完整度 ${integrity}%</span>${warn}${repairBtn}${fittingControls}</div>`;
}

export class StrategicUniversePanel {
  constructor(
    private root: HTMLElement,
    private cb: {
      onAction: (action: UniverseAction) => void;
      onExport: () => void;
      onExportLog: () => void;
      onExit: () => void;
      onConfirm?: (message: string) => boolean;
    }
  ) {}

  render(state: UniverseState): void {
    const previousFocus = focusedControl(this.root);
    const selected = state.systems.find((system) => system.id === state.selectedSystemId) ?? state.systems[0];
    const current = state.systems.find((system) => system.id === state.fleet.systemId)!;
    const base = state.faction.baseEntityId
      ? state.entities.find((entity) => entity.id === state.faction.baseEntityId)
      : undefined;
    const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId)!;
    const gateSystem = state.systems.find((system) => system.id === gate.systemId)!;
    const income = universeTurnIncome(state);
    const incomeReport = strategicIncomeReport(state);
    const fleetCounts = strategicFleetCounts(state.fleet);
    const fleetPower = strategicFleetPower(state);
    const hasPending = !!state.pendingBattle;
    const hasRecruitment = !!state.pendingRecruitment;
    const commandLocked = isStrategicCommandLocked(state);
    // pending 只锁定行动，不应令原本可执行的管理操作从界面消失；保留按钮并禁用，
    // 让玩家清楚哪些操作会在结算战斗后恢复。
    const actionState = hasPending || hasRecruitment
      ? { ...state, pendingBattle: undefined, pendingRecruitment: undefined }
      : state;
    const pendingBanner = hasPending
      ? '<div class="strategy-banner pending" role="alert" aria-live="assertive">当前存在尚未结算的战略战斗。完成战斗前，战略时间与其他行动已锁定。</div>'
      : hasRecruitment
        ? '<div class="strategy-banner pending" role="alert" aria-live="assertive">招募候选人正在等待决定。接受或放弃前，战略时间与其他行动已锁定。</div>'
        : commandLocked
          ? '<div class="strategy-banner pending" role="alert" aria-live="assertive">现任指挥官无法履职。完成治疗或继任前，战略时间与其他行动已锁定。</div>'
          : '';
    const actionLocked = hasPending || hasRecruitment || commandLocked;
    const actionLockReason = hasPending
      ? '请先继续并完成当前战略战斗。'
      : hasRecruitment
        ? '请先接受或放弃当前招募候选人。'
        : commandLocked
          ? '请先完成指挥官治疗或继任。'
          : state.status !== 'active'
            ? '远征已经结束，不能继续推进。'
            : '';
    const blockedAttr = (blocked: boolean, fallback: string) =>
      disabledReasonAttr(blocked, actionLocked || state.status !== 'active' ? actionLockReason : fallback);
    const blueprintText = state.faction.legacy.blueprints.length
      ? state.faction.legacy.blueprints.map((id) => `<span data-strategy-blueprint="${id}"><b>${BLUEPRINT_LABEL[id]}</b>：${STRATEGIC_BLUEPRINT_EFFECTS[id].description}</span>`).join('<br>')
      : '无';
    const recoveredText = state.faction.recoveredBlueprints.length
      ? state.faction.recoveredBlueprints.map((id) => `${BLUEPRINT_LABEL[id]}（待撤离后激活）`).join(' / ')
      : '无';
    const fleetCard = `
<section class="strategic-card">
  <h2>舰队与跨域资产</h2>
  <p>总舰船 ${fleetCounts.total} · 可作战 ${fleetCounts.operational} · 失能 ${fleetCounts.disabled}${fleetCounts.escaped ? ` · 逃脱 ${fleetCounts.escaped}` : ''} · 战力 ${fleetPower}</p>
  <div class="fleet-ship-list">
    ${state.fleet.ships.map((ship) => fleetShipRow(ship, actionState, actionLocked, actionLockReason)).join('')}
  </div>
  <p>永久蓝图：${blueprintText}</p>
  <p>本星域新获蓝图：${recoveredText}</p>
  <p>累计穿越 ${state.faction.legacy.sectorsCleared} 星域 · 累计损失 ${state.faction.legacy.shipsLost} 艘舰</p>
</section>`;
    const known = new Set(state.faction.knownSystemIds);
    const turnsLeft = Math.max(0, state.crisis.finalTurn - state.turn);

    const transportEdges = new Map<string, 'active' | 'blocked'>();
    for (const link of state.transportLinks) {
      const status = strategicTransportStatus(state, link);
      for (let index = 1; index < link.pathSystemIds.length; index++) {
        const edge = [link.pathSystemIds[index - 1], link.pathSystemIds[index]].sort().join('|');
        transportEdges.set(edge, status === 'blocked' ? 'blocked' : transportEdges.get(edge) ?? 'active');
      }
    }
    const routes = state.systems.flatMap((system) => system.neighbors
      .filter((neighborId) => system.id < neighborId)
      .map((neighborId) => {
        const neighbor = state.systems.find((candidate) => candidate.id === neighborId)!;
        if (!known.has(system.id) && !known.has(neighbor.id)) return '';
        const active = [system.id, neighbor.id].includes(current.id);
        const hostile = system.control === 'enemy' || neighbor.control === 'enemy';
        const transport = transportEdges.get([system.id, neighbor.id].sort().join('|'));
        return `<line class="${active ? 'active ' : ''}${hostile ? 'hostile ' : ''}${transport ? `transport ${transport}` : ''}" x1="${system.x}" y1="${system.y}" x2="${neighbor.x}" y2="${neighbor.y}"/>`;
      })).join('');

    const systems = state.systems.filter((system) => known.has(system.id)).map((system) => {
      const classes = ['strategic-system', `control-${system.control}`];
      if (system.id === selected.id) classes.push('selected');
      if (system.id === current.id) classes.push('fleet-here');
      if (system.id === gateSystem.id && state.extraction.discovered) classes.push('gate-system');
      const hasOutpost = ownedStrategicStations(state).some((station) => station.systemId === system.id);
      const mobileForces = state.enemyTaskForces.filter((force) => force.systemId === system.id);
      const siege = state.sieges.find((candidate) => {
        const station = state.entities.find((entity) => entity.id === candidate.stationEntityId);
        return station?.systemId === system.id;
      });
      if (hasOutpost) classes.push('has-outpost');
      if (mobileForces.length) classes.push('enemy-task-force');
      if (siege) classes.push('under-siege');
      const marker = system.id === current.id ? '◆' : siege ? '⚠' : mobileForces.length ? '▲' : system.id === gateSystem.id && state.extraction.discovered ? '◎' : hasOutpost ? '▣' : '●';
      const hostilePower = strategicHostilePowerAt(state, system.id);
      const threat = hostilePower > 0 ? ` · 敌军 ${hostilePower}${siege ? ` · 围攻 ${siege.turnsRemaining}` : ''}` : '';
      return `<button class="${classes.join(' ')}" style="left:${system.x}%;top:${system.y}%" data-strategy-system="${escapeHtml(system.id)}" title="${escapeHtml(system.name)}" aria-label="选择星系：${escapeHtml(system.name)}${threat ? `，${escapeHtml(threat.slice(3))}` : ''}"><span>${marker}</span><small>${escapeHtml(system.name)}${threat}</small></button>`;
    }).join('');

    const canTravel = current.neighbors.includes(selected.id) && state.fleet.fuel >= travelFuelCost(state) && selected.id !== current.id && state.status === 'active' && !hasPending;
    const travel = selected.id === current.id
      ? '<span class="strategy-location">舰队当前位于本星系</span>'
      : `<button class="btn primary" data-strategy-travel="${escapeHtml(selected.id)}"${blockedAttr(!canTravel || actionLocked, current.neighbors.includes(selected.id) ? `需要燃料 ${travelFuelCost(state)}，当前燃料 ${state.fleet.fuel}。` : '只能航行到当前星系的相邻已知星系。')}>航行至此（燃料 ${travelFuelCost(state)}）</button>`;
    let battle = '';
    if (state.pendingBattle) {
      const pb = state.pendingBattle;
      const battleSystem = state.systems.find((system) => system.id === pb.systemId);
      const enemyCount = pb.enemyFleet.reduce((sum, entry) => sum + Math.max(0, Math.floor(entry.count)), 0);
      const source = pb.source === 'gateDefense' ? '星门防御战' : pb.source === 'taskForce' ? '特遣舰队战' : '驻军战';
      battle = `<button class="btn danger" id="strategy-engage">继续${source} · ${escapeHtml(battleSystem?.name ?? pb.systemId)} · ${enemyCount} 敌舰 · seed ${pb.battleSeed} · 战前预算 ${pb.enemyPowerBefore}</button>`;
    } else if (selected.id === current.id && canEngageEnemy(state)) {
      battle = `<button class="btn danger" id="strategy-engage"${disabledReasonAttr(actionLocked, actionLockReason)}>攻击当地敌军（总战力 ${strategicHostilePowerAt(state, current.id)}）</button>`;
    }

    const selectedEntities = state.entities.filter((entity) => entity.systemId === selected.id);
    const entityCards = selectedEntities.some((entity) => entity.discovered)
      ? selectedEntities.filter((entity) => entity.discovered).map((entity) => {
          const fleetHere = entity.systemId === current.id;
          const safe = strategicHostilePowerAt(state, selected.id) === 0;
          const survey = fleetHere && safe && !entity.surveyed && state.status === 'active'
            ? `<button class="btn small" data-strategy-survey="${escapeHtml(entity.id)}"${disabledReasonAttr(actionLocked, actionLockReason)}>测绘</button>`
            : '';
          const extract = fleetHere && safe && entity.kind === 'asteroidField' && entity.surveyed &&
            (entity.deposits?.minerals ?? 0) > 0 && state.faction.resources.supplies > 0 && state.status === 'active'
            ? `<button class="btn small primary" data-strategy-extract="${escapeHtml(entity.id)}"${disabledReasonAttr(actionLocked, actionLockReason)}>快速采集</button>`
            : '';
          const establish = canEstablishBase(actionState, entity.id)
            ? `<button class="btn small primary" data-strategy-base="${escapeHtml(entity.id)}"${disabledReasonAttr(actionLocked, actionLockReason)}>建立前进基地</button>`
            : '';
          const establishOutpost = canEstablishOutpost(actionState, entity.id)
            ? `<button class="btn small primary" data-strategy-outpost="${escapeHtml(entity.id)}"${disabledReasonAttr(actionLocked, actionLockReason)}>建立补给前哨</button>`
            : '';
          return `<div class="strategic-entity ${entity.ownerId ? 'owned' : ''}"><div class="entity-icon">${ENTITY_ICON[entity.kind]}</div><div><b>${escapeHtml(entity.name)}</b><small>${ENTITY_LABEL[entity.kind]} · 轨道 ${entity.orbit}</small><small>${escapeHtml(entityDetails(entity))}</small></div><div class="entity-actions">${survey}${extract}${establish}${establishOutpost}</div></div>`;
        }).join('')
      : '<p class="muted">当前仅掌握远程坐标；舰队抵达后才能识别实体。</p>';

    const networkStations = ownedStrategicStations(state);
    const networkCards = networkStations.map((station) => {
      const stationSystem = state.systems.find((system) => system.id === station.systemId)!;
      const source = incomeReport.sources.find((candidate) => candidate.entityId === station.id)!;
      const link = state.transportLinks.find((candidate) => candidate.outpostEntityId === station.id);
      const blockingSystem = link?.pathSystemIds
        .map((id) => state.systems.find((system) => system.id === id))
        .find((system) => !!system && strategicHostilePowerAt(state, system.id) > 0);
      const linkText = station.id === state.faction.baseEntityId
        ? '主基地 · 本地产出直接入库'
        : link
          ? `${source.status === 'blocked' ? `运输中断（${blockingSystem?.name ?? '未知敌情'}）` : '运输畅通'} · ${link.pathSystemIds.map((id) => state.systems.find((system) => system.id === id)?.name ?? id).join(' → ')}`
          : '运输链缺失';
      const facilities = (station.facilities ?? []).map((facility) =>
        `<span>${FACILITY_DEFINITIONS[facility.type].label} Lv.${facility.level}</span>`
      ).join('') || '<span>尚无已建设施</span>';
      const queue = (station.constructionQueue ?? []).map((order) =>
        `<div>${FACILITY_DEFINITIONS[order.facilityType].label} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合</div>`
      ).join('') || '<div>建造队列为空</div>';
      const buttons = (Object.keys(FACILITY_DEFINITIONS) as FacilityType[]).map((type) => {
        if (type === 'shipyard' && station.id !== state.faction.baseEntityId) return '';
        const definition = FACILITY_DEFINITIONS[type];
        return `<button class="btn small" data-strategy-build="${type}" data-strategy-build-entity="${escapeHtml(station.id)}"${blockedAttr(!canQueueFacility(actionState, type, station.id) || actionLocked, '需要舰队位于该安全据点、队列有空位且资源充足。')}>${definition.label}<small>${resourceCost(effectiveFacilityCost(state, type))} · ${definition.turns}回合 · ${definition.description}</small></button>`;
      }).join('');
      const productionQueue = (station.shipProductionQueue ?? []).map((order) =>
        `<div data-strategy-production-order="${escapeHtml(order.id)}">${SHIP_CN[order.shipClass]}·${VARIANT_CN[order.variant]} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合 · ${escapeHtml(order.campaignShipId)}</div>`
      ).join('') || '<div>舰船生产队列为空</div>';
      const productionButtons = (['Fighter', 'Frigate', 'Cruiser'] as ShipClass[]).flatMap((shipClass) =>
        VARIANTS_BY_CLASS[shipClass].map((variant) => {
          const cost = effectiveShipProductionCost(state, shipClass, variant);
          return `<button class="btn small" data-strategy-produce-class="${shipClass}" data-strategy-produce-variant="${variant}"${blockedAttr(!canQueueShipProduction(actionState, shipClass, variant) || actionLocked, '需要舰队位于未被围攻的主基地、船坞队列有空位且资源充足。')}>${SHIP_CN[shipClass]}·${VARIANT_CN[variant]}<small>${resourceCost(cost)} · ${shipProductionTurns(shipClass, variant)}回合</small></button>`;
        })
      ).join('');
      const production = station.id === state.faction.baseEntityId
        ? `<div class="ship-production"><h4>轻型船坞生产</h4>${(station.facilities ?? []).some((facility) => facility.type === 'shipyard') ? `<div class="queue-list">${productionQueue}</div><div class="strategy-button-grid ship-production-grid">${productionButtons}</div><small>队列上限 2；舰队离开主基地或基地被围攻时生产暂停。</small>` : '<p class="muted">建设轻型轨道船坞后，可生产现有舰体与改型。</p>'}</div>`
        : '';
      const siege = state.sieges.find((candidate) => candidate.stationEntityId === station.id);
      const siegeText = siege ? `<div class="siege-warning">围攻中 · ${siege.turnsRemaining}/${siege.totalTurns} 回合后失守</div>` : '';
      return `<article class="outpost-card ${source.status === 'blocked' ? 'blocked' : ''} ${siege ? 'besieged' : ''}" data-strategy-outpost-card="${escapeHtml(station.id)}"><h3>${station.id === state.faction.baseEntityId ? '主基地' : '补给前哨'} · ${escapeHtml(station.name)}</h3>${siegeText}<p>${escapeHtml(stationSystem.name)} · ${escapeHtml(linkText)}</p><small>本地产出 矿物 +${source.produced.minerals} / 能源 +${source.produced.energy} / 科学 +${source.produced.science} / 补给 +${source.produced.supplies}${source.status === 'blocked' ? '（当前未送达）' : ''}</small><div class="facility-list">${facilities}</div><h4>建造队列</h4><div class="queue-list">${queue}</div><div class="strategy-button-grid">${buttons}</div>${production}</article>`;
    }).join('') || '<p class="muted">先在无敌军的已测绘空间站建立主基地，之后可继续建立补给前哨。</p>';
    const networkCard = `<section class="strategic-card strategic-network"><h2>据点与运输网络</h2><p>据点 ${networkStations.length} · 运输链 ${state.transportLinks.length} · 本回合送达：矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science} / 补给 +${income.supplies}</p><div class="outpost-list">${networkCards}</div></section>`;

    const researchQueue = state.faction.researchQueue.map((order) =>
      `<div>${RESEARCH_DEFINITIONS[order.projectId].label} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合</div>`
    ).join('') || '<div>研究队列为空</div>';
    const researchButtons = (Object.keys(RESEARCH_DEFINITIONS) as ResearchProjectId[]).map((projectId) => {
      const definition = RESEARCH_DEFINITIONS[projectId];
      const researched = state.faction.localResearch.includes(projectId);
      return `<button class="btn small ${researched ? 'complete' : ''}" data-strategy-research="${projectId}"${blockedAttr(!canQueueResearch(actionState, projectId) || actionLocked, researched ? '该项目已经完成。' : '需要已建立主基地、研究队列有空位且科学资源充足。')}>${researched ? '已完成：' : ''}${definition.label}<small>科学 ${definition.scienceCost} · ${definition.turns}回合 · ${definition.description}</small></button>`;
    }).join('');

    const gateDefenseText = state.extraction.gateDefense === 'resolved' ? '防御战已完成' : state.extraction.gateDefense === 'pending' ? '敌方拦截舰队待击退' : '防御战尚未触发';
    const gateKnown = state.extraction.discovered
      ? `<p>${escapeHtml(gateSystem.name)} · 校准 ${state.extraction.calibration}/${state.extraction.requiredCalibration}% · ${gateDefenseText} · 敌军 ${strategicHostilePowerAt(state, gateSystem.id)}</p>`
      : '<p>星门位置尚未确认。需要抵达远端星系并测绘跃迁设施。</p>';
    const calibrate = canCalibrateGate(actionState)
      ? `<button class="btn primary" id="strategy-calibrate"${disabledReasonAttr(actionLocked, actionLockReason)}>校准星门（能源 6 / 科学 2 / 补给 1）</button>`
      : '';
    const extractionMode = state.extraction.manifest?.mode ?? 'emergency';
    const extractionPlan = currentStrategicExtractionPlan(state, extractionMode);
    const canConfigure = canConfigureExtraction(actionState) && !actionLocked;
    const extractionModeButtons = state.extraction.discovered && state.status === 'active'
      ? `<div class="extraction-mode-tabs"><button class="btn small ${extractionMode === 'stable' ? 'complete' : ''}" data-strategy-extraction-mode="stable"${blockedAttr(!canConfigure, '需要发现星门并解除当前行动锁。')}>规划稳定撤离</button><button class="btn small ${extractionMode === 'emergency' ? 'complete' : ''}" data-strategy-extraction-mode="emergency"${blockedAttr(!canConfigure, '需要发现星门并解除当前行动锁。')}>规划紧急撤离</button></div>`
      : '';
    const extractionRows = state.extraction.discovered && state.status === 'active'
      ? extractionPlan.manifest.assignments.map((assignment) => {
          const ship = state.fleet.ships.find((candidate) => candidate.campaignShipId === assignment.campaignShipId)!;
          const roles: ExtractionAssignmentRole[] = ship.disabled
            ? ['tow', 'abandon']
            : extractionMode === 'emergency'
              ? ['evacuate', 'rearguard', 'abandon']
              : ['evacuate', 'abandon'];
          const buttons = roles.map((role) =>
            `<button class="btn small ${assignment.role === role ? 'complete' : ''}" data-strategy-extraction-ship="${escapeHtml(ship.campaignShipId)}" data-strategy-extraction-role="${role}"${blockedAttr(actionLocked || assignment.role === role || !canAssignExtractionShip(actionState, ship.campaignShipId, role), assignment.role === role ? '该舰当前已经执行此任务。' : '该任务会导致撤离清单无合法可作战舰，或不符合舰船当前状态。')}>${EXTRACTION_ROLE_LABEL[role]}</button>`
          ).join('');
          return `<div class="extraction-ship-row" data-strategy-extraction-assignment="${escapeHtml(ship.campaignShipId)}"><span><b>${escapeHtml(ship.campaignShipId)}</b><small>${SHIP_CN[ship.shipClass]}·${VARIANT_CN[ship.variant]} · ${ship.disabled ? '失能' : '可作战'}</small></span><div>${buttons}</div></div>`;
        }).join('')
      : '';
    const executeExtraction = state.extraction.discovered && state.status === 'active'
      ? extractionMode === 'stable'
        ? `<button class="btn primary" id="strategy-extract-stable"${blockedAttr(actionLocked || !canExtractSector(actionState, 'stable'), extractionPlan.error || '稳定撤离需要完整校准、完成星门防御战并备齐资源。')}>执行当前稳定撤离清单</button>`
        : `<button class="btn danger" id="strategy-extract-emergency"${blockedAttr(actionLocked || !canExtractSector(actionState, 'emergency'), extractionPlan.error || '紧急撤离需要最低校准、完成星门防御战并备齐资源。')}>执行当前紧急撤离清单</button>`
      : '';
    const riskLabel = { stable: '稳定', controlled: '受控紧急', emergency: '紧急', critical: '高危' }[extractionPlan.risk];
    const extractPreview = state.status === 'active' && state.extraction.discovered
      ? `<div class="extraction-plan-summary"><b>${riskLabel}计划</b><span>燃料 ${extractionPlan.fuelCost} · 补给 ${extractionPlan.suppliesCost}</span><span>撤离 ${fmtLosses(extractionPlan.survivingShipIds)} · 损失 ${fmtLosses(extractionPlan.lostShipIds)}</span><span>携带矿物 ${extractionPlan.carriedMaterials} · 补给 ${extractionPlan.carriedSupplies}</span>${extractionPlan.pressureLossShipIds.length ? `<span class="ship-warn">高压额外损失：${fmtLosses(extractionPlan.pressureLossShipIds)}</span>` : ''}${extractionPlan.error ? `<span class="ship-warn">${escapeHtml(extractionPlan.error)}</span>` : ''}</div>`
      : '';

    const log = state.log.slice(-12).reverse().map((entry) => `<div>R${entry.turn} · ${escapeHtml(entry.text)}</div>`).join('');
    const commander = ensureCommanderProfile(state.commander, state.seed);
    const commanderAttributes = Object.entries(commander.attributes)
      .map(([key, value]) => `<span>${COMMANDER_ATTRIBUTE_LABEL[key as keyof typeof commander.attributes]} ${value}</span>`)
      .join('');
    const commanderDuty = !commander.alive
      ? '阵亡'
      : isStrategicCommanderAvailable(state) ? '可履职' : '无法履职';
    const commanderConditions = commander.conditions.length
      ? `状况：${commander.conditions.map((condition) => `${COMMANDER_CONDITION_LABEL[condition.id]} ${condition.severity}`).join(' / ')}`
      : '';
    const commanderInjuries = commander.injuries.length
      ? `伤势：${commander.injuries.map((injury) => `${COMMANDER_INJURY_LABEL[injury.id]} ${injury.severity}`).join(' / ')}`
      : '';
    const commanderStatus = [
      `状态：${commanderDuty}`,
      commanderConditions,
      commanderInjuries,
      `候补 ${state.reserveCommanders.length}/3`
    ].filter(Boolean).join(' · ');
    const treatmentButton = canTreatStrategicCommander(state)
      ? '<button class="btn small primary" id="strategy-treat-commander">治疗现任（补给 2 / 1 回合）</button>'
      : '';
    const recruitmentButton = canOpenCommanderRecruitment(state)
      ? '<button class="btn small" id="strategy-open-recruitment">联络招募候选人</button>'
      : '';
    const recruitmentStatus = state.recruitmentUsedThisSector && !state.pendingRecruitment
      ? '<small class="muted">本星域招募机会已处理。</small>'
      : !base || state.fleet.systemId !== base.systemId
        ? '<small class="muted">舰队返回前进基地后可进行本星域招募与治疗。</small>'
        : '';
    const reserveRows = state.reserveCommanders.length
      ? state.reserveCommanders.map((candidate) => {
          const profile = ensureCommanderProfile(candidate, state.seed);
          const available = isCommanderAvailable(profile, state.seed);
          const appoint = canAppointStrategicCommander(state, profile.id)
            ? `<button class="btn small primary" data-strategy-appoint="${escapeHtml(profile.id)}">任命继任</button>`
            : '';
          return `<div class="commander-roster-row"><div><b>${escapeHtml(profile.name)}</b><small>Lv.${profile.level} · ${available ? '可履职' : '无法履职'} · ${profile.traits.map((trait) => COMMANDER_TRAIT_LABEL[trait]).join(' / ')}</small></div>${appoint}</div>`;
        }).join('')
      : '<small class="muted">暂无候补指挥官。</small>';
    const recruitmentOffer = state.pendingRecruitment
      ? `<div class="commander-recruitment"><h3>招募候选人 · 补给 ${state.pendingRecruitment.supplyCost}</h3>${state.pendingRecruitment.candidates.map((candidate) => {
          const profile = ensureCommanderProfile(candidate, state.seed);
          const affordable = state.faction.resources.supplies >= state.pendingRecruitment!.supplyCost && state.reserveCommanders.length < 3;
          const unavailableReason = state.reserveCommanders.length >= 3
            ? '候补名单已满，无法继续招募。'
            : `招募需要补给 ${state.pendingRecruitment!.supplyCost}，当前补给 ${state.faction.resources.supplies}。`;
          return `<div class="commander-roster-row"><div><b>${escapeHtml(profile.name)}</b><small>${profile.traits.map((trait) => COMMANDER_TRAIT_LABEL[trait]).join(' / ')} · 指挥 ${profile.attributes.command} / 战术 ${profile.attributes.tactics} / 后勤 ${profile.attributes.logistics} / 意志 ${profile.attributes.resolve}</small></div><button class="btn small primary" data-strategy-recruit-candidate="${escapeHtml(profile.id)}"${disabledReasonAttr(!affordable, unavailableReason)}>招募</button></div>`;
        }).join('')}<button class="btn small" id="strategy-recruit-decline">放弃本次招募</button></div>`
      : '';
    const commanderCard = `<section class="strategic-card strategic-commander"><h2>远征指挥官</h2><h3>${escapeHtml(commander.name)} · Lv.${commander.level}</h3><div class="commander-stats">${commanderAttributes}</div><p>特质：${commander.traits.map((trait) => COMMANDER_TRAIT_LABEL[trait]).join(' / ')}</p><p class="muted">${commanderStatus}</p><div class="commander-actions">${treatmentButton}${recruitmentButton}${recruitmentStatus}</div><h3>候补名单</h3><div class="commander-roster">${reserveRows}</div>${recruitmentOffer}</section>`;

    this.root.innerHTML = `<div class="strategic-screen">${endState(state)}${pendingBanner}<header class="strategic-header"><div><h1>星域战略远征 · 第 ${state.sectorIndex}/${state.targetSectorCount} 星域</h1><p>${escapeHtml(state.faction.name)} · 回合 ${state.turn}/${state.crisis.finalTurn} · ${CRISIS_PHASE_LABEL[state.crisis.phase]}</p></div><div class="strategic-resources"><span>矿物 ${state.faction.resources.minerals}</span><span>能源 ${state.faction.resources.energy}</span><span>科学 ${state.faction.resources.science}</span><span>补给 ${state.faction.resources.supplies}</span><span>燃料 ${state.fleet.fuel}/${state.fleet.maxFuel}</span></div></header><div class="crisis-strip phase-${state.crisis.phase}"><b>${CRISIS_PHASE_LABEL[state.crisis.phase]}</b><span>危机压力 ${state.crisis.pressure}/100</span><span>最终撤离窗口剩余 ${turnsLeft} 回合</span><span>移动敌军 ${state.enemyTaskForces.length}</span><span>围攻 ${state.sieges.length}</span><span>星门校准 ${state.extraction.calibration}%</span></div><div class="strategic-toolbar"><button class="btn primary" id="strategy-next-turn"${blockedAttr(state.status !== 'active' || actionLocked, '当前不能推进战略回合。')}>推进一回合</button><span>据点送达：矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science} / 补给 +${income.supplies}</span><button class="btn" id="strategy-export">导出远征码</button><button class="btn" id="strategy-export-log">导出远征日志</button><button class="btn" id="strategy-exit">返回主菜单</button></div><div class="strategic-layout"><section class="strategic-map-card" aria-label="战略星图"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><g class="strategic-routes">${routes}</g></svg>${systems}</section><aside class="strategic-system-panel"><h2>${escapeHtml(selected.name)}</h2><p>${STAR_LABEL[selected.starType]} · ${CONTROL_LABEL[selected.control]} · ${selected.neighbors.length} 条航线${strategicHostilePowerAt(state, selected.id) ? ` · 敌军总战力 ${strategicHostilePowerAt(state, selected.id)}` : ''}</p>${travel}${battle}<div class="strategic-entities">${entityCards}</div></aside></div><div class="strategic-management">${commanderCard}<section class="strategic-card"><h2>本星域科研</h2><p>撤离后全部失效。已完成：${state.faction.localResearch.length ? state.faction.localResearch.map((id) => RESEARCH_DEFINITIONS[id].label).join(' / ') : '无'}</p><div class="queue-list">${researchQueue}</div><div class="strategy-button-grid">${researchButtons}</div></section>${networkCard}${fleetCard}<section class="strategic-card gate-card"><h2>星门撤离</h2>${gateKnown}${calibrate}${extractionModeButtons}<div class="extraction-manifest">${extractionRows}</div>${extractPreview}<div class="extraction-actions">${executeExtraction}</div><small>稳定撤离需要 100% 校准；紧急撤离需要 40% 校准。紧急拖曳每艘失能舰额外消耗燃料 1、补给 2；断后舰可避免高压额外损失。两种方式都必须先完成真实星门防御战。</small></section><section class="strategic-card strategic-log"><h2>星域日志</h2>${log}</section></div></div>`;

    this.root.querySelectorAll<HTMLElement>('[data-strategy-system]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'selectSystem', systemId: button.dataset.strategySystem! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-travel]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'travel', systemId: button.dataset.strategyTravel! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-survey]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'surveyEntity', entityId: button.dataset.strategySurvey! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-extract]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'extractAsteroid', entityId: button.dataset.strategyExtract! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-base]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'establishBase', entityId: button.dataset.strategyBase! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-outpost]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'establishOutpost', entityId: button.dataset.strategyOutpost! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-build]').forEach((button) => {
      button.onclick = () => this.cb.onAction({
        type: 'queueConstruction',
        facilityType: button.dataset.strategyBuild as FacilityType,
        entityId: button.dataset.strategyBuildEntity
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-produce-class]').forEach((button) => {
      button.onclick = () => this.cb.onAction({
        type: 'queueShipProduction',
        shipClass: button.dataset.strategyProduceClass as ShipClass,
        variant: button.dataset.strategyProduceVariant as ShipVariant
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-research]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'queueResearch', projectId: button.dataset.strategyResearch as ResearchProjectId });
    });
    const engage = this.root.querySelector('#strategy-engage') as HTMLButtonElement | null;
    if (engage) engage.onclick = () => this.cb.onAction({ type: 'engageEnemy' });
    const openRecruitment = this.root.querySelector('#strategy-open-recruitment') as HTMLButtonElement | null;
    if (openRecruitment) openRecruitment.onclick = () => this.cb.onAction({ type: 'openRecruitment' });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-recruit-candidate]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'resolveRecruitment', candidateId: button.dataset.strategyRecruitCandidate! });
    });
    const declineRecruitment = this.root.querySelector('#strategy-recruit-decline') as HTMLButtonElement | null;
    if (declineRecruitment) declineRecruitment.onclick = () => this.cb.onAction({ type: 'resolveRecruitment' });
    const treatCommanderButton = this.root.querySelector('#strategy-treat-commander') as HTMLButtonElement | null;
    if (treatCommanderButton) treatCommanderButton.onclick = () => this.cb.onAction({ type: 'treatCommander' });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-appoint]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'appointCommander', commanderId: button.dataset.strategyAppoint! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-repair]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'repairShip', campaignShipId: button.dataset.strategyRepair! });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-fit-ship]').forEach((button) => {
      button.onclick = () => {
        const campaignShipId = button.dataset.strategyFitShip!;
        const moduleId = button.dataset.strategyFitModule as StrategicModuleId;
        const currentFitting = fittingForShip(state, campaignShipId);
        if (
          currentFitting && currentFitting.moduleId !== moduleId &&
          !(this.cb.onConfirm?.(`替换 ${campaignShipId} 当前的“${STRATEGIC_MODULE_DEFINITIONS[currentFitting.moduleId].label}”，改装为“${STRATEGIC_MODULE_DEFINITIONS[moduleId].label}”？原模块不会返还资源。`) ?? true)
        ) return;
        this.cb.onAction({ type: 'fitStrategicModule', campaignShipId, moduleId });
      };
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-remove-module]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'removeStrategicModule', campaignShipId: button.dataset.strategyRemoveModule! });
    });
    const calibrateButton = this.root.querySelector('#strategy-calibrate') as HTMLButtonElement | null;
    if (calibrateButton) calibrateButton.onclick = () => this.cb.onAction({ type: 'calibrateGate' });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-extraction-mode]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'configureExtraction', mode: button.dataset.strategyExtractionMode as 'stable' | 'emergency' });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-extraction-ship]').forEach((button) => {
      button.onclick = () => {
        const campaignShipId = button.dataset.strategyExtractionShip!;
        const role = button.dataset.strategyExtractionRole as ExtractionAssignmentRole;
        if (
          (role === 'abandon' || role === 'rearguard') &&
          !(this.cb.onConfirm?.(`${role === 'abandon' ? '主动放弃' : '留守断后'} ${campaignShipId}？该舰将不会随主力撤离。`) ?? true)
        ) return;
        this.cb.onAction({ type: 'assignExtractionShip', campaignShipId, role });
      };
    });
    const stableButton = this.root.querySelector('#strategy-extract-stable') as HTMLButtonElement | null;
    if (stableButton) stableButton.onclick = () => {
      const plan = currentStrategicExtractionPlan(state, 'stable');
      if (
        (plan.lostShipIds.length > 0 || plan.risk === 'critical') &&
        !(this.cb.onConfirm?.(`执行稳定撤离？预计损失：${fmtLosses(plan.lostShipIds)}，风险等级：${riskLabel}。`) ?? true)
      ) return;
      this.cb.onAction({ type: 'extractSector', mode: 'stable' });
    };
    const emergencyButton = this.root.querySelector('#strategy-extract-emergency') as HTMLButtonElement | null;
    if (emergencyButton) emergencyButton.onclick = () => {
      const plan = currentStrategicExtractionPlan(state, 'emergency');
      if (
        (plan.lostShipIds.length > 0 || plan.risk === 'critical') &&
        !(this.cb.onConfirm?.(`执行紧急撤离？预计损失：${fmtLosses(plan.lostShipIds)}，风险等级：${riskLabel}。`) ?? true)
      ) return;
      this.cb.onAction({ type: 'extractSector', mode: 'emergency' });
    };
    (this.root.querySelector('#strategy-next-turn') as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'advanceTurn' });
    (this.root.querySelector('#strategy-export') as HTMLButtonElement).onclick = this.cb.onExport;
    (this.root.querySelector('#strategy-export-log') as HTMLButtonElement).onclick = this.cb.onExportLog;
    (this.root.querySelector('#strategy-exit') as HTMLButtonElement).onclick = this.cb.onExit;
    restoreFocusedControl(this.root, previousFocus);
  }
}
