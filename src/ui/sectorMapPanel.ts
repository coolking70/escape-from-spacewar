import { CARGO_ITEM_LABEL, cargoQuantity } from '../campaign/cargo/cargoSystem';
import { CampaignAction, CampaignState, RetreatPolicy } from '../campaign/campaignTypes';
import { getAvailableCampaignActions } from '../campaign/campaignReducer';
import { buildExtractionPlan } from '../campaign/extraction/extractionSystem';
import { buildEncounterPreview } from '../campaign/fleet/encounterControl';
import { canFieldRepair } from '../campaign/repair/repairSystem';
import { signalOptions, signalTemplate } from '../campaign/sector/sectorActions';
import { SectorNodeType, SectorRegion } from '../campaign/sector/sectorTypes';
import { visibleSectorGraph } from '../campaign/sector/sectorVisibility';
import { campaignHud } from './campaignHud';
import { campaignResultPanel } from './campaignResultPanel';

const NODE_ICON: Record<SectorNodeType, string> = {
  start: '⌂', empty: '·', resource: '◆', battle: '⚔', hazard: '!', signal: '◉', gate: '◎'
};
const REGION_LABEL: Record<SectorRegion, string> = {
  safeRoute: '安全航道', salvageBelt: '残骸带', militaryZone: '军事封锁区', nebula: '星云区', gateApproach: '星门近域'
};
const RETREAT_LABEL: Record<RetreatPolicy, string> = {
  never: '不主动撤退', loss25: '损失 25% 时撤退', loss50: '损失 50% 时撤退', lastShip: '仅剩一艘时撤退', critical: '主力舰严重受损时撤退'
};

export class SectorMapPanel {
  private showFullResultLog = false;

  constructor(
    private root: HTMLElement,
    private cb: {
      onAction: (action: CampaignAction) => void;
      onBattle: () => void;
      onExport: () => void;
      onExportLog: () => void;
      onExit: () => void;
    }
  ) {}

  render(state: CampaignState): void {
    if (state.status === 'active') this.showFullResultLog = false;
    const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
    const available = getAvailableCampaignActions(state);
    const graph = visibleSectorGraph(state.sector);
    const shown = new Set(graph.nodeIds);
    const edges = graph.edges.map(([a, b]) => {
      const left = state.sector.nodes.find((node) => node.id === a)!;
      const right = state.sector.nodes.find((node) => node.id === b)!;
      const traveled = left.visibility === 'visited' && right.visibility === 'visited';
      const sameRegion = left.region === right.region;
      return `<line class="${traveled ? 'traveled' : ''} ${sameRegion ? `region-${left.region}` : 'connector'}" x1="${left.x}" y1="${left.y}" x2="${right.x}" y2="${right.y}"/>`;
    }).join('');

    const nodes = state.sector.nodes.filter((node) => shown.has(node.id)).map((node) => {
      const hiddenGate = node.type === 'gate' && !state.sector.gateKnown;
      const label = node.visibility === 'detected' || hiddenGate ? '?' : NODE_ICON[node.type];
      const title = node.visibility === 'detected' ? '未知节点' : `${REGION_LABEL[node.region]} · ${node.type}${node.feature === 'rescue' ? ' · 救援信号' : ''}`;
      return `<button title="${title}" class="sector-node region-${node.region} ${node.visibility} ${node.id === current.id ? 'current' : ''}" style="left:${node.x}%;top:${node.y}%" data-id="${node.id}" ${!available.move || !current.neighbors.includes(node.id) ? 'disabled' : ''}><span>${label}</span></button>`;
    }).join('');

    const disabled = (enabled: boolean) => enabled ? '' : 'disabled';
    const signal = available.resolveSignal ? signalOptions(state, current.id) : null;
    const salvage = state.pendingSalvage
      ? `<div class="campaign-card"><h3>战后打捞</h3><p>敌舰摧毁 ${state.pendingSalvage.summary.enemyDestroyed} · 敌舰失能 ${state.pendingSalvage.summary.enemyDisabled} · 我方损失 ${state.pendingSalvage.summary.ownDestroyed}</p>${state.pendingSalvage.options.map((option) => `<div class="salvage-option"><button class="btn ${option.id === 'thorough' || option.id === 'recover' ? 'primary' : ''}" data-salvage="${option.id}">${option.label}（${option.turns} 回合 / 威胁 +${option.threat}）</button><small>${option.description}</small></div>`).join('')}</div>`
      : '';

    const deployment = state.pendingBattle ? (() => {
      const selected = new Set(state.pendingBattle?.deployment?.selectedShipIds ?? state.fleet.ships.filter((ship) => !ship.disabled).map((ship) => ship.campaignShipId));
      const choices = state.fleet.ships.filter((ship) => !ship.disabled).map((ship) => `<label><input type="checkbox" data-deploy="${ship.campaignShipId}" ${selected.has(ship.campaignShipId) ? 'checked' : ''}> ${ship.campaignShipId} · ${ship.shipClass}/${ship.variant}</label>`).join('');
      const preview = buildEncounterPreview(state);
      const policy = state.pendingBattle?.retreatPolicy ?? 'loss50';
      const risk = preview ? `<div class="encounter-risk ${preview.assessment.danger}"><b>${preview.assessment.label}</b><span>我方 ${preview.assessment.playerPower} / 敌方估计 ${preview.assessment.enemyPower}（${preview.assessment.ratio.toFixed(2)}×）</span><span>规避成功率 ${preview.evadeChance}%</span></div>` : '';
      const policies = (Object.keys(RETREAT_LABEL) as RetreatPolicy[]).map((value) => `<option value="${value}" ${value === policy ? 'selected' : ''}>${RETREAT_LABEL[value]}</option>`).join('');
      return `<div class="campaign-card"><h3>战前部署</h3><p>至少保留一艘参战舰。未参战舰留守，不会进入本场战斗。</p>${risk}<div class="deployment-list">${choices}</div><label>自动撤退策略 <select id="sp-retreat-policy">${policies}</select></label><div class="encounter-actions"><button class="btn" id="sp-evade">尝试规避</button><button class="btn" id="sp-withdraw" ${disabled(!!preview?.canWithdraw)}>消耗 1 燃料退回</button><button class="btn danger" id="sp-battle">开始战斗：${state.pendingBattle.reason}</button></div></div>`;
    })() : '';

    const extraction = current.type === 'gate' && !state.pendingBattle && !state.pendingSalvage ? (() => {
      const plan = buildExtractionPlan(state);
      return `<div class="campaign-card"><h3>撤离规划</h3><p>风险：<b>${plan.risk}</b>（${plan.riskScore}） · 跃迁燃料 ${plan.fuelCost} · 安全载荷 ${plan.safeCargoCapacity}/${state.cargo.capacity} · 当前载荷 ${plan.cargoUsed}</p><p>${plan.factors.join('；')}</p><button class="btn" id="sp-prepare" ${state.extractionPrepared ? 'disabled' : ''}>${state.extractionPrepared ? '已完成跃迁准备' : '准备跃迁（1 回合）'}</button><button class="btn primary" id="sp-gate-normal" ${disabled(plan.canNormalExtract)}>普通跃迁</button><button class="btn danger" id="sp-gate-emergency" ${disabled(plan.untowedDisabled === 0 && state.resources.fuel >= plan.fuelCost)}>紧急跃迁（自动抛货 / 可能受损）</button></div>`;
    })() : '';

    const actions = state.pendingBattle ? deployment : state.pendingSalvage ? salvage : `<button class="btn" id="sp-scan" ${disabled(available.scan)}>扫描</button><button class="btn" id="sp-gather" ${disabled(available.gather)}>采集</button>${signal ? `<span>信号：${current.feature === 'rescue' ? '受损友军求救' : signalTemplate(state, current.id)}</span><button class="btn" id="sp-signal-a">${signal[0]}</button><button class="btn" id="sp-signal-b">${signal[1]}</button>` : ''}${current.type === 'gate' ? extraction : ''}<button class="btn" id="sp-wait" ${disabled(available.wait)}>等待</button>`;

    const cargo = state.cargo.items.length ? state.cargo.items.map((stack) => `<span>${CARGO_ITEM_LABEL[stack.type]}×${stack.quantity}${stack.type === 'supplyCrate' || stack.type === 'fuelCell' ? ` <button class="btn small" data-use-cargo="${stack.type}">使用</button>` : ''} <button class="btn small danger" data-jettison="${stack.type}">抛弃 1</button></span>`).join(' ') : '<span>货舱为空</span>';
    const ships = state.fleet.ships.map((ship) => {
      const repair = canFieldRepair(ship) && cargoQuantity(state.cargo, 'repairParts') > 0 ? `<button class="btn small" data-repair="${ship.campaignShipId}">${ship.disabled ? '修复并重新启用' : '战地维修'}</button>` : '';
      const controls = ship.disabled ? `<button class="btn small" data-tow="${ship.campaignShipId}">${ship.towed ? '停止拖曳' : '拖曳'}</button><button class="btn small" data-dismantle="${ship.campaignShipId}">拆解</button><button class="btn small danger" data-abandon="${ship.campaignShipId}">放弃</button>` : '';
      return `<div><b>${ship.campaignShipId}</b> ${ship.shipClass}/${ship.variant} · ${ship.disabled ? '失能' : '可战'}${ship.towed ? ' · 拖曳中' : ''} ${repair}${controls}</div>`;
    }).join('');
    const summary = state.lastSectorSummary ? `<div class="campaign-card"><h3>上一星域结算</h3><p>星域 ${state.lastSectorSummary.sectorIndex} · 探索 ${state.lastSectorSummary.visitedNodes}/${state.lastSectorSummary.totalNodes} · 回合 ${state.lastSectorSummary.turns} · 舰船 ${state.lastSectorSummary.shipsRemaining} · 失能 ${state.lastSectorSummary.disabledShips} · 载荷 ${state.lastSectorSummary.cargoUsed}/${state.lastSectorSummary.cargoCapacity} · 撤离 ${state.lastSectorSummary.extractionMode}/${state.lastSectorSummary.extractionRisk}</p></div>` : '';

    this.root.innerHTML = `<div class="campaign-screen">${campaignHud(state)}${summary}<div class="sector-region-legend">${Object.entries(REGION_LABEL).map(([key, label]) => `<span class="region-${key}">${label}</span>`).join('')}</div><div class="sector-map"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>${nodes}</div><div class="campaign-actions"><b>当前位置：${current.visibility === 'detected' ? '未知' : `${REGION_LABEL[current.region]} · ${current.type}`}</b>${actions}</div><div class="campaign-card"><h3>货舱</h3>${cargo}</div><div class="campaign-card"><h3>持久舰队</h3>${ships}</div><div class="campaign-log">${state.history.slice(-8).reverse().map((entry) => `<div>R${entry.turn} · ${entry.text}</div>`).join('')}</div><div><button class="btn" id="sp-export">导出 Campaign Code</button><button class="btn" id="sp-exit">返回主菜单</button></div>${campaignResultPanel(state, this.showFullResultLog)}</div>`;

    this.root.querySelectorAll('.sector-node:not([disabled])').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'move', targetNodeId: (element as HTMLElement).dataset.id! });
    });
    const click = (id: string, action: CampaignAction) => {
      const button = this.root.querySelector(id) as HTMLButtonElement | null;
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

    const policy = this.root.querySelector('#sp-retreat-policy') as HTMLSelectElement | null;
    if (policy) policy.onchange = () => this.cb.onAction({ type: 'setRetreatPolicy', policy: policy.value as RetreatPolicy });
    this.root.querySelectorAll('[data-deploy]').forEach((element) => {
      (element as HTMLInputElement).onchange = () => this.cb.onAction({ type: 'toggleDeployment', campaignShipId: (element as HTMLElement).dataset.deploy! });
    });
    this.root.querySelectorAll('[data-salvage]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'resolveSalvage', optionId: (element as HTMLElement).dataset.salvage as any });
    });
    this.root.querySelectorAll('[data-use-cargo]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'useCargo', itemType: (element as HTMLElement).dataset.useCargo as 'supplyCrate' | 'fuelCell' });
    });
    this.root.querySelectorAll('[data-jettison]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'jettisonCargo', itemType: (element as HTMLElement).dataset.jettison as any, quantity: 1 });
    });
    const bindShipAction = (selector: string, type: 'fieldRepair' | 'towShip' | 'dismantleShip' | 'abandonShip', key: string) => {
      this.root.querySelectorAll(selector).forEach((element) => {
        (element as HTMLButtonElement).onclick = () => this.cb.onAction({ type, campaignShipId: (element as HTMLElement).dataset[key]! } as CampaignAction);
      });
    };
    bindShipAction('[data-repair]', 'fieldRepair', 'repair');
    bindShipAction('[data-tow]', 'towShip', 'tow');
    bindShipAction('[data-dismantle]', 'dismantleShip', 'dismantle');
    bindShipAction('[data-abandon]', 'abandonShip', 'abandon');
    const battle = this.root.querySelector('#sp-battle') as HTMLButtonElement | null;
    if (battle) battle.onclick = this.cb.onBattle;
    (this.root.querySelector('#sp-export') as HTMLButtonElement).onclick = this.cb.onExport;
    (this.root.querySelector('#sp-exit') as HTMLButtonElement).onclick = this.cb.onExit;
    this.root.querySelectorAll('[data-campaign-result]').forEach((element) => {
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
