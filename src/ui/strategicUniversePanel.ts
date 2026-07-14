import { escapeHtml } from './html';
import {
  BLUEPRINT_LABEL,
  CRISIS_PHASE_LABEL,
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  canCalibrateGate,
  canEngageEnemy,
  canEstablishBase,
  canExtractSector,
  canQueueFacility,
  canQueueResearch,
  canRepairFleet,
  travelFuelCost,
  universeTurnIncome
} from '../strategy/universeRules';
import type {
  FacilityType,
  ResearchProjectId,
  SpaceEntity,
  SpaceEntityKind,
  StarType,
  SystemControl,
  UniverseAction,
  UniverseState
} from '../strategy/universeTypes';

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

function endState(state: UniverseState): string {
  if (state.status === 'active') return '';
  const victory = state.status === 'victory';
  return `<div class="strategy-end ${victory ? 'victory' : 'defeat'}"><h2>${victory ? '远征完成' : '星域崩溃'}</h2><p>${victory ? `已连续穿越 ${state.targetSectorCount} 个星域。` : '舰队未能在最终撤离窗口关闭前离开。'}</p></div>`;
}

export class StrategicUniversePanel {
  constructor(
    private root: HTMLElement,
    private cb: {
      onAction: (action: UniverseAction) => void;
      onExport: () => void;
      onExit: () => void;
    }
  ) {}

  render(state: UniverseState): void {
    const selected = state.systems.find((system) => system.id === state.selectedSystemId) ?? state.systems[0];
    const current = state.systems.find((system) => system.id === state.fleet.systemId)!;
    const base = state.faction.baseEntityId
      ? state.entities.find((entity) => entity.id === state.faction.baseEntityId)
      : undefined;
    const gate = state.entities.find((entity) => entity.id === state.extraction.gateEntityId)!;
    const gateSystem = state.systems.find((system) => system.id === gate.systemId)!;
    const income = universeTurnIncome(state);
    const known = new Set(state.faction.knownSystemIds);
    const turnsLeft = Math.max(0, state.crisis.finalTurn - state.turn);

    const routes = state.systems.flatMap((system) => system.neighbors
      .filter((neighborId) => system.id < neighborId)
      .map((neighborId) => {
        const neighbor = state.systems.find((candidate) => candidate.id === neighborId)!;
        if (!known.has(system.id) && !known.has(neighbor.id)) return '';
        const active = [system.id, neighbor.id].includes(current.id);
        const hostile = system.control === 'enemy' || neighbor.control === 'enemy';
        return `<line class="${active ? 'active ' : ''}${hostile ? 'hostile' : ''}" x1="${system.x}" y1="${system.y}" x2="${neighbor.x}" y2="${neighbor.y}"/>`;
      })).join('');

    const systems = state.systems.filter((system) => known.has(system.id)).map((system) => {
      const classes = ['strategic-system', `control-${system.control}`];
      if (system.id === selected.id) classes.push('selected');
      if (system.id === current.id) classes.push('fleet-here');
      if (system.id === gateSystem.id && state.extraction.discovered) classes.push('gate-system');
      const marker = system.id === current.id ? '◆' : system.id === gateSystem.id && state.extraction.discovered ? '◎' : '●';
      const threat = system.enemyPower > 0 ? ` · 敌军 ${system.enemyPower}` : '';
      return `<button class="${classes.join(' ')}" style="left:${system.x}%;top:${system.y}%" data-strategy-system="${escapeHtml(system.id)}" title="${escapeHtml(system.name)}"><span>${marker}</span><small>${escapeHtml(system.name)}${threat}</small></button>`;
    }).join('');

    const canTravel = current.neighbors.includes(selected.id) && state.fleet.fuel >= travelFuelCost(state) && selected.id !== current.id && state.status === 'active';
    const travel = selected.id === current.id
      ? '<span class="strategy-location">舰队当前位于本星系</span>'
      : `<button class="btn primary" data-strategy-travel="${escapeHtml(selected.id)}" ${canTravel ? '' : 'disabled'}>航行至此（燃料 ${travelFuelCost(state)}）</button>`;
    const battle = selected.id === current.id && canEngageEnemy(state)
      ? `<button class="btn danger" id="strategy-engage">攻击当地敌军（战力 ${current.enemyPower}）</button>`
      : '';

    const selectedEntities = state.entities.filter((entity) => entity.systemId === selected.id);
    const entityCards = selectedEntities.some((entity) => entity.discovered)
      ? selectedEntities.filter((entity) => entity.discovered).map((entity) => {
          const fleetHere = entity.systemId === current.id;
          const safe = selected.enemyPower === 0;
          const survey = fleetHere && safe && !entity.surveyed && state.status === 'active'
            ? `<button class="btn small" data-strategy-survey="${escapeHtml(entity.id)}">测绘</button>`
            : '';
          const extract = fleetHere && safe && entity.kind === 'asteroidField' && entity.surveyed &&
            (entity.deposits?.minerals ?? 0) > 0 && state.faction.resources.supplies > 0 && state.status === 'active'
            ? `<button class="btn small primary" data-strategy-extract="${escapeHtml(entity.id)}">快速采集</button>`
            : '';
          const establish = canEstablishBase(state, entity.id)
            ? `<button class="btn small primary" data-strategy-base="${escapeHtml(entity.id)}">建立前进基地</button>`
            : '';
          return `<div class="strategic-entity ${entity.ownerId ? 'owned' : ''}"><div class="entity-icon">${ENTITY_ICON[entity.kind]}</div><div><b>${escapeHtml(entity.name)}</b><small>${ENTITY_LABEL[entity.kind]} · 轨道 ${entity.orbit}</small><small>${escapeHtml(entityDetails(entity))}</small></div><div class="entity-actions">${survey}${extract}${establish}</div></div>`;
        }).join('')
      : '<p class="muted">当前仅掌握远程坐标；舰队抵达后才能识别实体。</p>';

    const facilities = (base?.facilities ?? []).map((facility) =>
      `<span>${FACILITY_DEFINITIONS[facility.type].label} Lv.${facility.level}</span>`
    ).join('') || '<span>尚无已建设施</span>';
    const constructionQueue = (base?.constructionQueue ?? []).map((order) =>
      `<div>${FACILITY_DEFINITIONS[order.facilityType].label} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合</div>`
    ).join('') || '<div>建造队列为空</div>';
    const constructionButtons = base
      ? (Object.keys(FACILITY_DEFINITIONS) as FacilityType[]).map((type) => {
          const definition = FACILITY_DEFINITIONS[type];
          return `<button class="btn small" data-strategy-build="${type}" ${canQueueFacility(state, type) ? '' : 'disabled'}>${definition.label}<small>${resourceCost(definition.cost)} · ${definition.turns}回合 · ${definition.description}</small></button>`;
        }).join('')
      : '<p class="muted">先在无敌军的已测绘空间站建立前进基地。</p>';

    const researchQueue = state.faction.researchQueue.map((order) =>
      `<div>${RESEARCH_DEFINITIONS[order.projectId].label} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合</div>`
    ).join('') || '<div>研究队列为空</div>';
    const researchButtons = (Object.keys(RESEARCH_DEFINITIONS) as ResearchProjectId[]).map((projectId) => {
      const definition = RESEARCH_DEFINITIONS[projectId];
      const researched = state.faction.localResearch.includes(projectId);
      return `<button class="btn small ${researched ? 'complete' : ''}" data-strategy-research="${projectId}" ${canQueueResearch(state, projectId) ? '' : 'disabled'}>${researched ? '已完成：' : ''}${definition.label}<small>科学 ${definition.scienceCost} · ${definition.turns}回合 · ${definition.description}</small></button>`;
    }).join('');

    const blueprintText = state.faction.legacy.blueprints.length
      ? state.faction.legacy.blueprints.map((id) => BLUEPRINT_LABEL[id]).join(' / ')
      : '无';
    const recoveredText = state.faction.recoveredBlueprints.length
      ? state.faction.recoveredBlueprints.map((id) => BLUEPRINT_LABEL[id]).join(' / ')
      : '无';
    const baseText = base
      ? `${escapeHtml(base.name)} · ${escapeHtml(state.systems.find((system) => system.id === base.systemId)!.name)}`
      : '尚未建立；舰队保持机动但无法持续生产';
    const repair = canRepairFleet(state)
      ? '<button class="btn primary" id="strategy-repair">维修一艘失能舰（矿物 4 / 补给 5）</button>'
      : '';

    const gateKnown = state.extraction.discovered
      ? `<p>${escapeHtml(gateSystem.name)} · 校准 ${state.extraction.calibration}/${state.extraction.requiredCalibration}% · 敌军 ${gateSystem.enemyPower}</p>`
      : '<p>星门位置尚未确认。需要抵达远端星系并测绘跃迁设施。</p>';
    const calibrate = canCalibrateGate(state)
      ? '<button class="btn primary" id="strategy-calibrate">校准星门（能源 6 / 科学 2 / 补给 1）</button>'
      : '';
    const stable = canExtractSector(state, 'stable')
      ? '<button class="btn primary" id="strategy-extract-stable">稳定撤离并携带较多资产</button>'
      : '';
    const emergency = canExtractSector(state, 'emergency')
      ? '<button class="btn danger" id="strategy-extract-emergency">紧急撤离（可能损失舰船与物资）</button>'
      : '';
    const rearguard = state.fleet.shipCount > 1 && canExtractSector(state, 'emergency', 1)
      ? '<button class="btn danger" id="strategy-extract-rearguard">留下 1 艘舰断后并紧急撤离</button>'
      : '';

    const log = state.log.slice(-12).reverse().map((entry) => `<div>R${entry.turn} · ${escapeHtml(entry.text)}</div>`).join('');
    const locked = state.status !== 'active' ? 'disabled' : '';

    this.root.innerHTML = `<div class="strategic-screen">${endState(state)}<header class="strategic-header"><div><h1>星域战略远征 · 第 ${state.sectorIndex}/${state.targetSectorCount} 星域</h1><p>${escapeHtml(state.faction.name)} · 回合 ${state.turn}/${state.crisis.finalTurn} · ${CRISIS_PHASE_LABEL[state.crisis.phase]}</p></div><div class="strategic-resources"><span>矿物 ${state.faction.resources.minerals}</span><span>能源 ${state.faction.resources.energy}</span><span>科学 ${state.faction.resources.science}</span><span>补给 ${state.faction.resources.supplies}</span><span>燃料 ${state.fleet.fuel}/${state.fleet.maxFuel}</span></div></header><div class="crisis-strip phase-${state.crisis.phase}"><b>${CRISIS_PHASE_LABEL[state.crisis.phase]}</b><span>危机压力 ${state.crisis.pressure}/100</span><span>最终撤离窗口剩余 ${turnsLeft} 回合</span><span>星门校准 ${state.extraction.calibration}%</span></div><div class="strategic-toolbar"><button class="btn primary" id="strategy-next-turn" ${locked}>推进一回合</button><span>据点产出：矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science} / 补给 +${income.supplies}</span><button class="btn" id="strategy-export">导出远征码</button><button class="btn" id="strategy-exit">返回主菜单</button></div><div class="strategic-layout"><section class="strategic-map-card"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g class="strategic-routes">${routes}</g></svg>${systems}</section><aside class="strategic-system-panel"><h2>${escapeHtml(selected.name)}</h2><p>${STAR_LABEL[selected.starType]} · ${CONTROL_LABEL[selected.control]} · ${selected.neighbors.length} 条航线${selected.enemyPower ? ` · 敌军战力 ${selected.enemyPower}` : ''}</p>${travel}${battle}<div class="strategic-entities">${entityCards}</div></aside></div><div class="strategic-management"><section class="strategic-card"><h2>前进基地</h2><p>${baseText}</p><div class="facility-list">${facilities}</div><h3>建造队列</h3><div class="queue-list">${constructionQueue}</div><div class="strategy-button-grid">${constructionButtons}</div></section><section class="strategic-card"><h2>本星域科研</h2><p>撤离后全部失效。已完成：${state.faction.localResearch.length ? state.faction.localResearch.map((id) => RESEARCH_DEFINITIONS[id].label).join(' / ') : '无'}</p><div class="queue-list">${researchQueue}</div><div class="strategy-button-grid">${researchButtons}</div></section><section class="strategic-card"><h2>舰队与跨域资产</h2><p>舰船 ${state.fleet.shipCount} · 失能 ${state.fleet.disabledShips} · 战力 ${state.fleet.combatPower}</p>${repair}<p>永久蓝图：${blueprintText}</p><p>本星域新获蓝图：${recoveredText}</p><p>累计穿越 ${state.faction.legacy.sectorsCleared} 星域 · 累计损失 ${state.faction.legacy.shipsLost} 艘舰</p></section><section class="strategic-card gate-card"><h2>星门撤离</h2>${gateKnown}${calibrate}<div class="extraction-actions">${stable}${emergency}${rearguard}</div><small>稳定撤离需要 100% 校准、补给 8、燃料 2；紧急撤离只需 40% 校准，但会丢失失能舰和大部分资源。</small></section><section class="strategic-card strategic-log"><h2>星域日志</h2>${log}</section></div></div>`;

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
    this.root.querySelectorAll<HTMLElement>('[data-strategy-build]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'queueConstruction', facilityType: button.dataset.strategyBuild as FacilityType });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-research]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'queueResearch', projectId: button.dataset.strategyResearch as ResearchProjectId });
    });
    const engage = this.root.querySelector('#strategy-engage') as HTMLButtonElement | null;
    if (engage) engage.onclick = () => this.cb.onAction({ type: 'engageEnemy' });
    const repairButton = this.root.querySelector('#strategy-repair') as HTMLButtonElement | null;
    if (repairButton) repairButton.onclick = () => this.cb.onAction({ type: 'repairFleet' });
    const calibrateButton = this.root.querySelector('#strategy-calibrate') as HTMLButtonElement | null;
    if (calibrateButton) calibrateButton.onclick = () => this.cb.onAction({ type: 'calibrateGate' });
    const stableButton = this.root.querySelector('#strategy-extract-stable') as HTMLButtonElement | null;
    if (stableButton) stableButton.onclick = () => this.cb.onAction({ type: 'extractSector', mode: 'stable' });
    const emergencyButton = this.root.querySelector('#strategy-extract-emergency') as HTMLButtonElement | null;
    if (emergencyButton) emergencyButton.onclick = () => this.cb.onAction({ type: 'extractSector', mode: 'emergency' });
    const rearguardButton = this.root.querySelector('#strategy-extract-rearguard') as HTMLButtonElement | null;
    if (rearguardButton) rearguardButton.onclick = () => this.cb.onAction({ type: 'extractSector', mode: 'emergency', rearguardShips: 1 });
    (this.root.querySelector('#strategy-next-turn') as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'advanceTurn' });
    (this.root.querySelector('#strategy-export') as HTMLButtonElement).onclick = this.cb.onExport;
    (this.root.querySelector('#strategy-exit') as HTMLButtonElement).onclick = this.cb.onExit;
  }
}
