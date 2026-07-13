import { CARGO_ITEM_LABEL, cargoQuantity } from '../campaign/cargo/cargoSystem';
import {
  COMMANDER_CONDITION_LABEL,
  COMMANDER_INJURY_LABEL,
  isCommanderAvailable,
  treatCommander
} from '../campaign/commander/commanderHealth';
import {
  COMMANDER_DOMAIN_LABEL,
  COMMANDER_TRAIT_LABEL,
  ensureCommanderProfile
} from '../campaign/commander/commanderSystem';
import { CampaignAction, CampaignCommander, CampaignState, RetreatPolicy } from '../campaign/campaignTypes';
import { getAvailableCampaignActions } from '../campaign/campaignReducerV09';
import { buildExtractionPlan } from '../campaign/extraction/extractionSystem';
import { buildEncounterPreview } from '../campaign/fleet/encounterControl';
import { movementFuelCost } from '../campaign/fleet/persistentFleet';
import { canResolveOrganizationEvent } from '../campaign/organization/organizationEvents';
import {
  GOVERNMENT_LABEL,
  ORGANIZATION_ARCHETYPE_LABEL,
  ORGANIZATION_VALUE_LABEL,
  organizationEmergencyRefuelCost,
  organizationTreatmentCost
} from '../campaign/organization/organizationSystem';
import {
  canUnlockTechnology,
  TECHNOLOGY_DEFINITIONS,
  TECHNOLOGY_IDS,
  technologyCostText
} from '../campaign/organization/technologySystem';
import { canFieldRepair } from '../campaign/repair/repairSystem';
import { signalOptions, signalTemplate } from '../campaign/sector/sectorActions';
import { NodeVisibility, SectorNode, SectorNodeType, SectorRegion } from '../campaign/sector/sectorTypes';
import { visibleSectorGraph } from '../campaign/sector/sectorVisibility';
import { campaignHud } from './campaignHud';
import { campaignResultPanel } from './campaignResultPanel';
import { escapeHtml } from './html';

const NODE_ICON: Record<SectorNodeType, string> = {
  start: '⌂', empty: '·', resource: '◆', battle: '⚔', hazard: '!', signal: '◉', gate: '◎'
};
const REGION_LABEL: Record<SectorRegion, string> = {
  safeRoute: '安全航道', salvageBelt: '残骸带', militaryZone: '军事封锁区', nebula: '星云区', gateApproach: '星门近域'
};
const NODE_NAME: Record<SectorNodeType, string> = {
  start: '起点空间站', empty: '未知空域', resource: '资源富集区', battle: '交战空域', hazard: '危险空域', signal: '信号源', gate: '跃迁星门'
};
const NODE_TYPE_LABEL: Record<SectorNodeType, string> = {
  start: '起点', empty: '空域', resource: '资源点', battle: '交战区', hazard: '危险区', signal: '信号源', gate: '星门'
};
const VISIBILITY_LABEL: Record<NodeVisibility, string> = {
  hidden: '未探测', detected: '已侦测（未知）', scanned: '已扫描', visited: '已探索'
};
const RETREAT_LABEL: Record<RetreatPolicy, string> = {
  never: '不主动撤退', loss25: '损失 25% 时撤退', loss50: '损失 50% 时撤退', lastShip: '仅剩一艘时撤退', critical: '主力舰严重受损时撤退'
};

interface SectorNodeView {
  id: string;
  node: SectorNode;
  name: string;
  regionLabel: string;
  typeLabel: string;
  icon: string;
  visibilityLabel: string;
  featureRescue: boolean;
  adjacent: boolean;
  isCurrent: boolean;
  canMove: boolean;
  moveCost: number;
  blockedReason: string;
  title: string;
}

function commanderSummary(commander: CampaignCommander, state: CampaignState): string {
  const profile = ensureCommanderProfile(commander, state.campaignSeed);
  const traits = profile.traits.map((trait) => COMMANDER_TRAIT_LABEL[trait]).join(' / ');
  const domains = Object.entries(profile.domainExperience)
    .map(([key, value]) => `${COMMANDER_DOMAIN_LABEL[key as keyof typeof COMMANDER_DOMAIN_LABEL]} ${value}`)
    .join(' · ');
  const conditions = profile.conditions.length
    ? profile.conditions.map((condition) => `${COMMANDER_CONDITION_LABEL[condition.id]}${condition.severity}（${condition.remainingTurns}回合）`).join('、')
    : '无负面状态';
  const injuries = profile.injuries.length
    ? profile.injuries.map((injury) => `${COMMANDER_INJURY_LABEL[injury.id]}${injury.severity}`).join('、')
    : '无伤病';
  return `<div class="commander-row"><b>${escapeHtml(profile.name)}</b> Lv.${profile.level} · 指挥 ${profile.attributes.command} / 战术 ${profile.attributes.tactics} / 后勤 ${profile.attributes.logistics} / 意志 ${profile.attributes.resolve}<small>${traits}</small><small>${domains}</small><small>${conditions} · ${injuries}</small></div>`;
}

function organizationPanel(state: CampaignState, locked: boolean): string {
  const organization = state.organization;
  const values = organization.values.map((value) => ORGANIZATION_VALUE_LABEL[value]).join(' / ');
  const research = organization.research.resources;
  const technologies = TECHNOLOGY_IDS.map((id) => {
    const definition = TECHNOLOGY_DEFINITIONS[id];
    const unlocked = organization.research.unlocked.includes(id);
    const installed = organization.research.installed.includes(id);
    const action = installed
      ? `<button class="btn small" data-tech-uninstall="${id}" ${locked ? 'disabled' : ''}>卸下</button>`
      : unlocked
        ? `<button class="btn small primary" data-tech-install="${id}" ${locked || organization.research.installed.length >= organization.research.slots ? 'disabled' : ''}>装配</button>`
        : `<button class="btn small" data-tech-unlock="${id}" ${!locked && canUnlockTechnology(organization, id) ? '' : 'disabled'}>研究：${technologyCostText(id)}</button>`;
    return `<div class="technology-row ${installed ? 'installed' : unlocked ? 'unlocked' : 'locked'}"><div><b>${definition.label}</b><small>${definition.field} · ${definition.description}</small></div><span>${installed ? '已装配' : unlocked ? '已解锁' : '未解锁'}</span>${action}</div>`;
  }).join('');
  return `<div class="campaign-card organization-card"><h3>组织与科技</h3><div class="organization-identity"><b>${escapeHtml(organization.name)}</b><span>${ORGANIZATION_ARCHETYPE_LABEL[organization.archetype]} · ${GOVERNMENT_LABEL[organization.government]}</span><span>价值观：${values}</span><span>稳定度 ${organization.stability} · 声望 民间 ${organization.reputation.civilian} / 军事 ${organization.reputation.military} / 边疆 ${organization.reputation.frontier}</span></div><div class="research-points">航行 ${research.navigation} · 工程 ${research.engineering} · 战术 ${research.tactical} · 社会 ${research.social} · 科技槽 ${organization.research.installed.length}/${organization.research.slots}</div><div class="technology-list">${technologies}</div></div>`;
}

function organizationEventPanel(state: CampaignState): string {
  const event = state.pendingOrganizationEvent;
  if (!event) return '';
  const options = event.options.map((option) => {
    const enabled = canResolveOrganizationEvent(state, option);
    const requirement = option.requiredValue ? ` · 需要价值观：${ORGANIZATION_VALUE_LABEL[option.requiredValue]}` : '';
    return `<div class="organization-event-option"><button class="btn ${enabled ? 'primary' : ''}" data-organization-event="${escapeHtml(option.id)}" ${enabled ? '' : 'disabled'}>${escapeHtml(option.label)}</button><small>${escapeHtml(option.description)}${requirement}</small></div>`;
  }).join('');
  return `<div class="campaign-card organization-event"><h3>${escapeHtml(event.title)}</h3><p>${escapeHtml(event.description)}</p>${options}</div>`;
}

export class SectorMapPanel {
  private showFullResultLog = false;
  private nodeViews = new Map<string, SectorNodeView>();
  private infobox: HTMLDivElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private currentState: CampaignState | null = null;
  private currentNodeActionsHTML = '';

  constructor(
    private root: HTMLElement,
    private cb: {
      onAction: (action: CampaignAction) => void;
      onBattle: () => void;
      onExport: () => void;
      onExportLog: () => void;
      onExit: () => void;
    }
  ) {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hideInfoBox();
    });
    window.addEventListener('scroll', () => this.hideInfoBox(), true);
    window.addEventListener('resize', () => this.hideInfoBox());
  }

  render(state: CampaignState): void {
    if (state.status === 'active') this.showFullResultLog = false;
    this.hideInfoBox();
    this.nodeViews.clear();
    this.currentState = state;
    const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
    const managementLocked = state.status !== 'active' || Boolean(
      state.pendingOrganizationEvent || state.pendingSuccession || state.pendingRecruitment || state.pendingBattle || state.pendingSalvage
    );
    const available = getAvailableCampaignActions(state);
    const moveCost = movementFuelCost(state.fleet);
    const fuelShortage = current.neighbors.length > 0 && state.resources.fuel < moveCost;
    const graph = visibleSectorGraph(state.sector);
    const shown = new Set(graph.nodeIds);
    const edges = graph.edges.map(([a, b]) => {
      const left = state.sector.nodes.find((node) => node.id === a)!;
      const right = state.sector.nodes.find((node) => node.id === b)!;
      const traveled = left.visibility === 'visited' && right.visibility === 'visited';
      const sameRegion = left.region === right.region;
      const touchesCurrent = a === current.id || b === current.id;
      return `<line class="${traveled ? 'traveled' : ''} ${sameRegion ? `region-${left.region}` : 'connector'} ${touchesCurrent ? 'edge-current' : ''}" x1="${left.x}" y1="${left.y}" x2="${right.x}" y2="${right.y}"/>`;
    }).join('');

    const nodes = state.sector.nodes.filter((node) => shown.has(node.id)).map((node) => {
      const hiddenGate = node.type === 'gate' && !state.sector.gateKnown;
      const label = node.visibility === 'detected' || hiddenGate ? '?' : NODE_ICON[node.type];
      const adjacent = current.neighbors.includes(node.id);
      const isCurrent = node.id === current.id;
      const canMove = available.move && adjacent && !isCurrent;
      const name = node.visibility === 'detected' ? '未知节点' : `${NODE_NAME[node.type]}${node.feature === 'rescue' ? '（救援）' : ''}`;
      const baseTitle = node.visibility === 'detected' ? '未知节点' : `${REGION_LABEL[node.region]} · ${NODE_NAME[node.type]}${node.feature === 'rescue' ? ' · 救援信号' : ''}`;
      const blockedReason = adjacent && !available.move
        ? fuelShortage
          ? `燃料不足：当前 ${state.resources.fuel} / 需要 ${moveCost}`
          : '有待处理事件或指挥官无法行动'
        : !adjacent ? '未直接相连，无法一步抵达' : '';
      const view: SectorNodeView = {
        id: node.id,
        node,
        name,
        regionLabel: REGION_LABEL[node.region],
        typeLabel: NODE_TYPE_LABEL[node.type],
        icon: label,
        visibilityLabel: VISIBILITY_LABEL[node.visibility],
        featureRescue: node.feature === 'rescue',
        adjacent,
        isCurrent,
        canMove,
        moveCost,
        blockedReason,
        title: baseTitle
      };
      this.nodeViews.set(node.id, view);
      const classes = ['sector-node', `region-${node.region}`, node.visibility];
      if (isCurrent) classes.push('current');
      else if (canMove) classes.push('reachable');
      else classes.push('unavailable');
      return `<button aria-label="${escapeHtml(baseTitle)}" title="${escapeHtml(baseTitle)}" class="${classes.join(' ')}" style="left:${node.x}%;top:${node.y}%" data-id="${escapeHtml(node.id)}"><span>${label}</span></button>`;
    }).join('');

    const disabled = (enabled: boolean) => enabled ? '' : 'disabled';
    const signal = available.resolveSignal ? signalOptions(state, current.id) : null;
    const salvage = state.pendingSalvage
      ? `<div class="campaign-card"><h3>战后打捞</h3><p>敌舰摧毁 ${state.pendingSalvage.summary.enemyDestroyed} · 敌舰失能 ${state.pendingSalvage.summary.enemyDisabled} · 我方损失 ${state.pendingSalvage.summary.ownDestroyed}</p>${state.pendingSalvage.options.map((option) => `<div class="salvage-option"><button class="btn ${option.id === 'thorough' || option.id === 'recover' ? 'primary' : ''}" data-salvage="${escapeHtml(option.id)}">${escapeHtml(option.label)}（${option.turns} 回合 / 威胁 +${option.threat}）</button><small>${escapeHtml(option.description)}</small></div>`).join('')}</div>`
      : '';

    const deployment = state.pendingBattle ? (() => {
      const selected = new Set(state.pendingBattle?.deployment?.selectedShipIds ?? state.fleet.ships.filter((ship) => !ship.disabled).map((ship) => ship.campaignShipId));
      const choices = state.fleet.ships.filter((ship) => !ship.disabled).map((ship) => `<label><input type="checkbox" data-deploy="${escapeHtml(ship.campaignShipId)}" ${selected.has(ship.campaignShipId) ? 'checked' : ''}> ${escapeHtml(ship.campaignShipId)} · ${ship.shipClass}/${ship.variant}</label>`).join('');
      const preview = buildEncounterPreview(state);
      const policy = state.pendingBattle?.retreatPolicy ?? 'loss50';
      const risk = preview ? `<div class="encounter-risk ${preview.assessment.danger}"><b>${preview.assessment.label}</b><span>我方 ${preview.assessment.playerPower} / 敌方估计 ${preview.assessment.enemyPower}（${preview.assessment.ratio.toFixed(2)}×）</span><span>规避成功率 ${preview.evadeChance}%</span></div>` : '';
      const policies = (Object.keys(RETREAT_LABEL) as RetreatPolicy[]).map((value) => `<option value="${value}" ${value === policy ? 'selected' : ''}>${RETREAT_LABEL[value]}</option>`).join('');
      return `<div class="campaign-card"><h3>战前部署</h3><p>至少保留一艘参战舰。未参战舰留守，不会进入本场战斗。</p>${risk}<div class="deployment-list">${choices}</div><label>自动撤退策略 <select id="sp-retreat-policy">${policies}</select></label><div class="encounter-actions"><button class="btn" id="sp-evade">尝试规避</button><button class="btn" id="sp-withdraw" ${disabled(!!preview?.canWithdraw)}>消耗 1 燃料退回</button><button class="btn danger" id="sp-battle">开始战斗：${state.pendingBattle.reason}</button></div></div>`;
    })() : '';

    const recruitment = state.pendingRecruitment ? `<div class="campaign-card commander-event"><h3>招募指挥官</h3><p>招募一名候选人消耗补给 ${state.pendingRecruitment.supplyCost}；候补上限 3 人。</p>${state.pendingRecruitment.candidates.map((candidate) => `${commanderSummary(candidate, state)}<button class="btn primary" data-recruit="${candidate.id}" ${disabled(state.resources.supplies >= state.pendingRecruitment!.supplyCost)}>招募</button>`).join('')}<button class="btn" id="sp-recruit-decline">放弃招募</button></div>` : '';
    const succession = state.pendingSuccession ? `<div class="campaign-card commander-event"><h3>任命继任指挥官</h3><p>现任指挥官已死亡或无法履职，必须从可用候补中选择继任者。</p>${(state.reserveCommanders ?? []).map((candidate) => `${commanderSummary(candidate, state)}<button class="btn primary" data-appoint="${candidate.id}" ${disabled(isCommanderAvailable(candidate, state.campaignSeed))}>任命</button>`).join('')}</div>` : '';
    const organizationEvent = organizationEventPanel(state);

    const extraction = current.type === 'gate' && !state.pendingBattle && !state.pendingSalvage ? (() => {
      const plan = buildExtractionPlan(state);
      return `<div class="campaign-card"><h3>撤离规划</h3><p>风险：<b>${plan.risk}</b>（${plan.riskScore}） · 跃迁燃料 ${plan.fuelCost} · 安全载荷 ${plan.safeCargoCapacity}/${state.cargo.capacity} · 当前载荷 ${plan.cargoUsed}</p><p>${plan.factors.join('；')}</p><button class="btn" id="sp-prepare" ${state.extractionPrepared ? 'disabled' : ''}>${state.extractionPrepared ? '已完成跃迁准备' : '准备跃迁（1 回合）'}</button><button class="btn primary" id="sp-gate-normal" ${disabled(plan.canNormalExtract)}>普通跃迁</button><button class="btn danger" id="sp-gate-emergency" ${disabled(plan.untowedDisabled === 0 && state.resources.fuel >= plan.fuelCost)}>紧急跃迁（自动抛货 / 可能受损）</button></div>`;
    })() : '';

    const fuelCellCount = cargoQuantity(state.cargo, 'fuelCell');
    const towedCount = state.fleet.ships.filter((ship) => ship.disabled && ship.towed).length;
    const refuelCost = organizationEmergencyRefuelCost(state.organization);
    const mobilityNotice = fuelShortage
      ? `<div class="encounter-risk dangerous"><b>移动受阻：燃料不足</b><span>当前燃料 ${state.resources.fuel}，舰队移动需要 ${moveCost}。</span>${fuelCellCount > 0 ? '<span>货舱中有燃料电池，可立即使用。</span><button class="btn small" data-use-cargo="fuelCell">使用燃料电池</button>' : ''}${towedCount > 0 ? `<span>正在拖曳 ${towedCount} 艘失能舰；停止拖曳可降低移动消耗。</span>` : ''}${available.emergencyRefuel ? `<button class="btn small danger" id="sp-emergency-refuel">应急燃料调配（1 回合 / ${refuelCost} 补给）</button>` : '<span>补给不足，无法执行应急燃料调配。</span>'}<small>等待不会恢复燃料。</small></div>`
      : '';
    const actions = state.pendingOrganizationEvent ? organizationEvent : state.pendingSuccession ? succession : state.pendingRecruitment ? recruitment : state.pendingBattle ? deployment : state.pendingSalvage ? salvage : `${mobilityNotice}<button class="btn" id="sp-scan" ${disabled(available.scan)}>扫描</button><button class="btn" id="sp-gather" ${disabled(available.gather)}>采集</button>${signal ? `<span>信号：${current.feature === 'rescue' ? '受损友军求救' : signalTemplate(state, current.id)}</span><button class="btn" id="sp-signal-a">${signal[0]}</button><button class="btn" id="sp-signal-b">${signal[1]}</button>` : ''}${current.type === 'gate' ? extraction : ''}<button class="btn" id="sp-wait" ${disabled(available.wait)}>${fuelShortage ? '等待（不会恢复燃料）' : '等待'}</button>`;

    this.currentNodeActionsHTML = actions;
    const cargo = state.cargo.items.length ? state.cargo.items.map((stack) => `<span>${CARGO_ITEM_LABEL[stack.type]}×${stack.quantity}${stack.type === 'supplyCrate' || stack.type === 'fuelCell' ? ` <button class="btn small" data-use-cargo="${stack.type}" ${managementLocked ? 'disabled' : ''}>使用</button>` : ''} <button class="btn small danger" data-jettison="${stack.type}" ${managementLocked ? 'disabled' : ''}>抛弃 1</button></span>`).join(' ') : '<span>货舱为空</span>';
    const ships = state.fleet.ships.map((ship) => {
      const shipId = escapeHtml(ship.campaignShipId);
      const repair = canFieldRepair(ship) && cargoQuantity(state.cargo, 'repairParts') > 0 ? `<button class="btn small" data-repair="${shipId}" ${managementLocked ? 'disabled' : ''}>${ship.disabled ? '修复并重新启用' : '战地维修'}</button>` : '';
      const controls = ship.disabled ? `<button class="btn small" data-tow="${shipId}" ${managementLocked ? 'disabled' : ''}>${ship.towed ? '停止拖曳' : '拖曳'}</button><button class="btn small" data-dismantle="${shipId}" ${managementLocked ? 'disabled' : ''}>拆解</button><button class="btn small danger" data-abandon="${shipId}" ${managementLocked ? 'disabled' : ''}>放弃</button>` : '';
      return `<div><b>${shipId}</b> ${ship.shipClass}/${ship.variant} · ${ship.disabled ? '失能' : '可战'}${ship.towed ? ' · 拖曳中' : ''} ${repair}${controls}</div>`;
    }).join('');
    const active = ensureCommanderProfile(state.commander, state.campaignSeed);
    const treatmentCost = organizationTreatmentCost(state.organization);
    const canTreat = !!treatCommander(active, state.campaignSeed) && state.resources.supplies >= treatmentCost;
    const reserve = (state.reserveCommanders ?? []).length ? (state.reserveCommanders ?? []).map((commander) => commanderSummary(commander, state)).join('') : '<small>暂无候补指挥官</small>';
    const commanderCard = `<div class="campaign-card commander-card"><h3>指挥官</h3>${commanderSummary(active, state)}<button class="btn small" id="sp-treat-commander" ${disabled(canTreat && !managementLocked)}>治疗指挥官（${treatmentCost} 医疗补给 / 1 回合）</button><h4>候补名单</h4>${reserve}</div>`;
    const summary = state.lastSectorSummary ? `<div class="campaign-card"><h3>上一星域结算</h3><p>星域 ${state.lastSectorSummary.sectorIndex} · 探索 ${state.lastSectorSummary.visitedNodes}/${state.lastSectorSummary.totalNodes} · 回合 ${state.lastSectorSummary.turns} · 舰船 ${state.lastSectorSummary.shipsRemaining} · 失能 ${state.lastSectorSummary.disabledShips} · 载荷 ${state.lastSectorSummary.cargoUsed}/${state.lastSectorSummary.cargoCapacity} · 撤离 ${state.lastSectorSummary.extractionMode}/${state.lastSectorSummary.extractionRisk}</p></div>` : '';

    this.root.innerHTML = `<div class="campaign-screen">${campaignHud(state)}${summary}<div class="sector-region-legend">${Object.entries(REGION_LABEL).map(([key, label]) => `<span class="region-${key}">${label}</span>`).join('')}</div><div class="sector-map"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>${nodes}</div><div class="sector-hint">当前位置：${current.visibility === 'detected' ? '未知' : `${REGION_LABEL[current.region]} · ${current.type}`} · 点击星图节点查看可执行操作</div>${organizationPanel(state, managementLocked)}${commanderCard}<div class="campaign-card"><h3>货舱</h3>${cargo}</div><div class="campaign-card"><h3>持久舰队</h3>${ships}</div><div class="campaign-log">${state.history.slice(-8).reverse().map((entry) => `<div>R${entry.turn} · ${escapeHtml(entry.text)}</div>`).join('')}</div><div><button class="btn" id="sp-export">导出 Campaign Code</button><button class="btn" id="sp-exit">返回主菜单</button></div>${campaignResultPanel(state, this.showFullResultLog)}</div>`;

    this.bindNodeEvents();
    this.bindPanelActions(this.root, state);
  }

  private ensureOverlay(): void {
    if (!this.infobox) {
      this.backdrop = document.createElement('div');
      this.backdrop.className = 'sector-node-backdrop';
      this.backdrop.addEventListener('click', () => this.hideInfoBox());
      this.infobox = document.createElement('div');
      this.infobox.className = 'sector-node-infobox';
      document.body.appendChild(this.backdrop);
      document.body.appendChild(this.infobox);
    }
  }

  private showInfoBox(node: HTMLElement, view: SectorNodeView): void {
    this.ensureOverlay();
    const rows: string[] = [];
    rows.push(`<div class="sni-row"><span>可见度</span><b>${view.visibilityLabel}</b></div>`);
    rows.push(`<div class="sni-row"><span>与当前位置</span><b>${view.isCurrent ? '当前所在' : view.adjacent ? '相邻（可一步抵达）' : '不相邻'}</b></div>`);
    if (view.featureRescue) rows.push(`<div class="sni-row"><span>特殊信号</span><b class="sni-rescue">救援信号</b></div>`);
    let hint: string;
    let actionsHTML = '';
    if (view.isCurrent) {
      hint = `<div class="sni-hint">这是你当前所在的节点，可执行以下操作。</div>`;
      const loc = `${view.regionLabel} · ${view.typeLabel}`;
      actionsHTML = `<div class="sni-actions"><div class="sni-loc">当前所在：${loc}</div>${this.currentNodeActionsHTML}</div>`;
    } else if (view.canMove) {
      hint = `<div class="sni-hint ok">与目标相邻，可选择前往。</div>`;
      actionsHTML = `<div class="sni-actions"><button class="btn primary sni-move" type="button" data-move="${escapeHtml(view.id)}">前往此处（消耗 ${view.moveCost} 燃料）</button></div>`;
    } else if (view.blockedReason) {
      hint = `<div class="sni-hint warn">无法前往：${view.blockedReason}</div>`;
    } else {
      hint = `<div class="sni-hint">未与当前位置直接相连，无法一步抵达。</div>`;
    }
    this.infobox!.innerHTML = `
      <div class="sni-head">
        <span class="sni-icon region-${view.node.region}">${view.icon}</span>
        <div class="sni-titles">
          <div class="sni-title">${view.name}${view.isCurrent ? ' · 当前' : ''}</div>
          <div class="sni-sub">${view.regionLabel} · ${view.typeLabel}</div>
        </div>
        <button class="sni-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="sni-body">${rows.join('')}</div>
      ${hint}
      ${actionsHTML}`;
    (this.infobox!.querySelector('.sni-close') as HTMLButtonElement).onclick = () => this.hideInfoBox();
    const moveBtn = this.infobox!.querySelector('[data-move]') as HTMLButtonElement | null;
    if (moveBtn) moveBtn.onclick = () => {
      this.hideInfoBox();
      this.cb.onAction({ type: 'move', targetNodeId: view.id });
    };
    if (this.currentState) this.bindPanelActions(this.infobox!, this.currentState);
    this.backdrop!.style.display = 'block';
    this.infobox!.style.display = 'block';
    const rect = node.getBoundingClientRect();
    const width = this.infobox!.offsetWidth;
    const height = this.infobox!.offsetHeight;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 10;
    if (top < 8) top = 8;
    this.infobox!.style.left = `${left}px`;
    this.infobox!.style.top = `${top}px`;
  }

  private hideInfoBox(): void {
    if (this.backdrop) this.backdrop.style.display = 'none';
    if (this.infobox) this.infobox.style.display = 'none';
  }

  private bindNodeEvents(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.sector-node').forEach((node) => {
      const view = this.nodeViews.get(node.dataset.id!);
      if (!view) return;
      node.addEventListener('contextmenu', (event) => event.preventDefault());
      node.addEventListener('click', (event) => {
        event.preventDefault();
        this.showInfoBox(node, view);
      });
    });
  }

  private bindPanelActions(container: HTMLElement, state: CampaignState): void {
    const click = (id: string, action: CampaignAction) => {
      const button = container.querySelector(id) as HTMLButtonElement | null;
      if (button) button.onclick = () => this.cb.onAction(action);
    };
    click('#sp-scan', { type: 'scan' });
    click('#sp-gather', { type: 'gather' });
    click('#sp-signal-a', { type: 'resolveSignal', optionId: 'cautious' });
    click('#sp-signal-b', { type: 'resolveSignal', optionId: 'direct' });
    click('#sp-evade', { type: 'evadeBattle' });
    click('#sp-withdraw', { type: 'withdrawBeforeBattle' });
    click('#sp-prepare', { type: 'prepareExtraction' });
    click('#sp-gate-normal', { type: 'enterGate', mode: 'normal' });
    click('#sp-gate-emergency', { type: 'enterGate', mode: 'emergency' });
    click('#sp-wait', { type: 'wait' });
    click('#sp-emergency-refuel', { type: 'emergencyRefuel' });
    click('#sp-recruit-decline', { type: 'resolveRecruitment' });
    click('#sp-treat-commander', { type: 'treatCommander' });

    const policy = container.querySelector('#sp-retreat-policy') as HTMLSelectElement | null;
    if (policy) policy.onchange = () => this.cb.onAction({ type: 'setRetreatPolicy', policy: policy.value as RetreatPolicy });
    container.querySelectorAll('[data-deploy]').forEach((element) => {
      (element as HTMLInputElement).onchange = () => this.cb.onAction({ type: 'toggleDeployment', campaignShipId: (element as HTMLElement).dataset.deploy! });
    });
    container.querySelectorAll('[data-salvage]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'resolveSalvage', optionId: (element as HTMLElement).dataset.salvage as any });
    });
    container.querySelectorAll('[data-recruit]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'resolveRecruitment', candidateId: (element as HTMLElement).dataset.recruit! });
    });
    container.querySelectorAll('[data-appoint]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'appointCommander', commanderId: (element as HTMLElement).dataset.appoint! });
    });
    container.querySelectorAll('[data-organization-event]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'resolveOrganizationEvent', optionId: (element as HTMLElement).dataset.organizationEvent! });
    });
    container.querySelectorAll('[data-tech-unlock]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'unlockTechnology', technologyId: (element as HTMLElement).dataset.techUnlock as any });
    });
    container.querySelectorAll('[data-tech-install]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'installTechnology', technologyId: (element as HTMLElement).dataset.techInstall as any });
    });
    container.querySelectorAll('[data-tech-uninstall]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'uninstallTechnology', technologyId: (element as HTMLElement).dataset.techUninstall as any });
    });
    container.querySelectorAll('[data-use-cargo]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'useCargo', itemType: (element as HTMLElement).dataset.useCargo as 'supplyCrate' | 'fuelCell' });
    });
    container.querySelectorAll('[data-jettison]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'jettisonCargo', itemType: (element as HTMLElement).dataset.jettison as any, quantity: 1 });
    });
    const bindShipAction = (selector: string, type: 'fieldRepair' | 'towShip' | 'dismantleShip' | 'abandonShip', key: string) => {
      container.querySelectorAll(selector).forEach((element) => {
        (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type, campaignShipId: (element as HTMLElement).dataset[key]! } as CampaignAction);
      });
    };
    bindShipAction('[data-repair]', 'fieldRepair', 'repair');
    bindShipAction('[data-tow]', 'towShip', 'tow');
    bindShipAction('[data-dismantle]', 'dismantleShip', 'dismantle');
    bindShipAction('[data-abandon]', 'abandonShip', 'abandon');
    const battle = container.querySelector('#sp-battle') as HTMLButtonElement | null;
    if (battle) battle.onclick = this.cb.onBattle;
    const exportBtn = container.querySelector('#sp-export') as HTMLButtonElement | null;
    if (exportBtn) exportBtn.onclick = this.cb.onExport;
    const exitBtn = container.querySelector('#sp-exit') as HTMLButtonElement | null;
    if (exitBtn) exitBtn.onclick = this.cb.onExit;
    container.querySelectorAll('[data-campaign-result]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => {
        switch ((element as HTMLElement).dataset.campaignResult) {
          case 'log': this.showFullResultLog = !this.showFullResultLog; this.render(state); break;
          case 'export': this.cb.onExport(); break;
          case 'export-log': this.cb.onExportLog(); break;
          case 'menu': this.cb.onExit(); break;
        }
      };
    });
  }
}
