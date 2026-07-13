import { escapeHtml } from './html';
import {
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  applyUniverseAction,
  canQueueFacility,
  canQueueResearch,
  travelFuelCost,
  universeTurnIncome
} from '../strategy/universeRules';
import type {
  FacilityType,
  ResearchProjectId,
  SpaceEntity,
  SpaceEntityKind,
  StarType,
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

const ENTITY_LABEL: Record<SpaceEntityKind, string> = {
  planet: '行星',
  moon: '卫星',
  station: '空间站',
  asteroidField: '小行星带',
  jumpGate: '跃迁设施'
};

const ENTITY_ICON: Record<SpaceEntityKind, string> = {
  planet: '●',
  moon: '◌',
  station: '▣',
  asteroidField: '✦',
  jumpGate: '◎'
};

function resourceCost(cost: { minerals?: number; energy?: number; science?: number }): string {
  return [
    cost.minerals ? `矿物 ${cost.minerals}` : '',
    cost.energy ? `能源 ${cost.energy}` : '',
    cost.science ? `科学 ${cost.science}` : ''
  ].filter(Boolean).join(' / ');
}

function entityDetails(entity: SpaceEntity): string {
  if (!entity.surveyed) return '尚未完成详细测绘。';
  const details: string[] = [];
  if (entity.habitability !== undefined) details.push(`宜居度 ${entity.habitability}%`);
  if (entity.deposits) details.push(`矿物储量 ${entity.deposits.minerals} · 能源储量 ${entity.deposits.energy}`);
  if (entity.ownerId) details.push('受玩家组织控制');
  return details.join(' · ') || '未发现可利用资源。';
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
    const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
    const income = universeTurnIncome(state);
    const known = new Set(state.faction.knownSystemIds);

    const routes = state.systems.flatMap((system) => system.neighbors
      .filter((neighborId) => system.id < neighborId)
      .map((neighborId) => {
        const neighbor = state.systems.find((candidate) => candidate.id === neighborId)!;
        if (!known.has(system.id) && !known.has(neighbor.id)) return '';
        const active = [system.id, neighbor.id].includes(current.id);
        return `<line class="${active ? 'active' : ''}" x1="${system.x}" y1="${system.y}" x2="${neighbor.x}" y2="${neighbor.y}"/>`;
      })).join('');

    const systems = state.systems.filter((system) => known.has(system.id)).map((system) => {
      const classes = ['strategic-system'];
      if (system.id === selected.id) classes.push('selected');
      if (system.id === current.id) classes.push('fleet-here');
      return `<button class="${classes.join(' ')}" style="left:${system.x}%;top:${system.y}%" data-strategy-system="${escapeHtml(system.id)}" title="${escapeHtml(system.name)}"><span>${system.id === current.id ? '◆' : '●'}</span><small>${escapeHtml(system.name)}</small></button>`;
    }).join('');

    const canTravel = current.neighbors.includes(selected.id) && state.fleet.fuel >= travelFuelCost(state) && selected.id !== current.id;
    const travel = selected.id === current.id
      ? '<span class="strategy-location">舰队当前位于本星系</span>'
      : `<button class="btn primary" data-strategy-travel="${escapeHtml(selected.id)}" ${canTravel ? '' : 'disabled'}>航行至此（燃料 ${travelFuelCost(state)}）</button>`;

    const selectedEntities = state.entities.filter((entity) => entity.systemId === selected.id);
    const entityCards = selectedEntities.length && selectedEntities.some((entity) => entity.discovered)
      ? selectedEntities.filter((entity) => entity.discovered).map((entity) => {
          const fleetHere = entity.systemId === current.id;
          const survey = fleetHere && !entity.surveyed
            ? `<button class="btn small" data-strategy-survey="${escapeHtml(entity.id)}">测绘实体</button>`
            : '';
          const extract = fleetHere && entity.kind === 'asteroidField' && entity.surveyed && (entity.deposits?.minerals ?? 0) > 0
            ? `<button class="btn small primary" data-strategy-extract="${escapeHtml(entity.id)}">开采 8 矿物</button>`
            : '';
          return `<div class="strategic-entity ${entity.ownerId ? 'owned' : ''}"><div class="entity-icon">${ENTITY_ICON[entity.kind]}</div><div><b>${escapeHtml(entity.name)}</b><small>${ENTITY_LABEL[entity.kind]} · 轨道 ${entity.orbit}</small><small>${escapeHtml(entityDetails(entity))}</small></div><div class="entity-actions">${survey}${extract}</div></div>`;
        }).join('')
      : '<p class="muted">该星系仅有远程坐标，舰队抵达后才能识别其中的行星、空间站和资源带。</p>';

    const facilities = (base.facilities ?? []).map((facility) =>
      `<span>${FACILITY_DEFINITIONS[facility.type].label} Lv.${facility.level}</span>`
    ).join('') || '<span>无设施</span>';
    const constructionQueue = (base.constructionQueue ?? []).map((order) =>
      `<div>${FACILITY_DEFINITIONS[order.facilityType].label} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合</div>`
    ).join('') || '<div>建造队列为空</div>';
    const constructionButtons = (Object.keys(FACILITY_DEFINITIONS) as FacilityType[]).map((type) => {
      const definition = FACILITY_DEFINITIONS[type];
      const requirement = definition.requires && !state.faction.researched.includes(definition.requires)
        ? ` · 需要${RESEARCH_DEFINITIONS[definition.requires].label}`
        : '';
      return `<button class="btn small" data-strategy-build="${type}" ${canQueueFacility(state, type) ? '' : 'disabled'}>${definition.label}<small>${resourceCost(definition.cost)} · ${definition.turns}回合${requirement}</small></button>`;
    }).join('');

    const researchQueue = state.faction.researchQueue.map((order) =>
      `<div>${RESEARCH_DEFINITIONS[order.projectId].label} · 剩余 ${order.turnsRemaining}/${order.totalTurns} 回合</div>`
    ).join('') || '<div>研究队列为空</div>';
    const researchButtons = (Object.keys(RESEARCH_DEFINITIONS) as ResearchProjectId[]).map((projectId) => {
      const definition = RESEARCH_DEFINITIONS[projectId];
      const researched = state.faction.researched.includes(projectId);
      return `<button class="btn small ${researched ? 'complete' : ''}" data-strategy-research="${projectId}" ${canQueueResearch(state, projectId) ? '' : 'disabled'}>${researched ? '已完成：' : ''}${definition.label}<small>科学 ${definition.scienceCost} · ${definition.turns}回合 · ${definition.description}</small></button>`;
    }).join('');

    const log = state.log.slice(-10).reverse().map((entry) => `<div>R${entry.turn} · ${escapeHtml(entry.text)}</div>`).join('');

    this.root.innerHTML = `<div class="strategic-screen"><header class="strategic-header"><div><h1>战略宇宙 · V1.0 垂直切片</h1><p>${escapeHtml(state.faction.name)} · 回合 ${state.turn}</p></div><div class="strategic-resources"><span>矿物 ${state.faction.resources.minerals}</span><span>能源 ${state.faction.resources.energy}</span><span>科学 ${state.faction.resources.science}</span><span>舰队燃料 ${state.fleet.fuel}/${state.fleet.maxFuel}</span></div></header><div class="strategic-toolbar"><button class="btn primary" id="strategy-next-turn">推进一回合</button><span>预计产出：矿物 +${income.minerals} / 能源 +${income.energy} / 科学 +${income.science}</span><button class="btn" id="strategy-export">导出宇宙码</button><button class="btn" id="strategy-exit">返回主菜单</button></div><div class="strategic-layout"><section class="strategic-map-card"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><g class="strategic-routes">${routes}</g></svg>${systems}</section><aside class="strategic-system-panel"><h2>${escapeHtml(selected.name)}</h2><p>${STAR_LABEL[selected.starType]} · ${selected.neighbors.length} 条航线</p>${travel}<div class="strategic-entities">${entityCards}</div></aside></div><div class="strategic-management"><section class="strategic-card"><h2>轨道基地</h2><p>${escapeHtml(base.name)} · ${escapeHtml(state.systems.find((system) => system.id === base.systemId)!.name)}</p><div class="facility-list">${facilities}</div><h3>建造队列</h3><div class="queue-list">${constructionQueue}</div><div class="strategy-button-grid">${constructionButtons}</div></section><section class="strategic-card"><h2>科研计划</h2><p>已完成：${state.faction.researched.length ? state.faction.researched.map((id) => RESEARCH_DEFINITIONS[id].label).join(' / ') : '无'}</p><h3>研究队列</h3><div class="queue-list">${researchQueue}</div><div class="strategy-button-grid">${researchButtons}</div></section><section class="strategic-card strategic-log"><h2>宇宙日志</h2>${log}</section></div></div>`;

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
    this.root.querySelectorAll<HTMLElement>('[data-strategy-build]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'queueConstruction', facilityType: button.dataset.strategyBuild as FacilityType });
    });
    this.root.querySelectorAll<HTMLElement>('[data-strategy-research]').forEach((button) => {
      button.onclick = () => this.cb.onAction({ type: 'queueResearch', projectId: button.dataset.strategyResearch as ResearchProjectId });
    });
    (this.root.querySelector('#strategy-next-turn') as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'advanceTurn' });
    (this.root.querySelector('#strategy-export') as HTMLButtonElement).onclick = this.cb.onExport;
    (this.root.querySelector('#strategy-exit') as HTMLButtonElement).onclick = this.cb.onExit;
  }
}
