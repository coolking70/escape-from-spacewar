import { CARGO_ITEM_LABEL, cargoQuantity } from '../campaign/cargo/cargoSystem';
import { CampaignAction, CampaignState } from '../campaign/campaignTypes';
import { getAvailableCampaignActions } from '../campaign/campaignReducer';
import { canFieldRepair } from '../campaign/repair/repairSystem';
import { signalOptions, signalTemplate } from '../campaign/sector/sectorActions';
import { visibleSectorGraph } from '../campaign/sector/sectorVisibility';
import { campaignHud } from './campaignHud';
import { campaignResultPanel } from './campaignResultPanel';

export class SectorMapPanel {
  constructor(
    private root: HTMLElement,
    private cb: {
      onAction: (action: CampaignAction) => void;
      onBattle: () => void;
      onExport: () => void;
      onExit: () => void;
    }
  ) {}

  render(state: CampaignState): void {
    const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
    const available = getAvailableCampaignActions(state);
    const graph = visibleSectorGraph(state.sector);
    const shown = new Set(graph.nodeIds);
    const edges = graph.edges
      .map(([a, b]) => {
        const left = state.sector.nodes.find((node) => node.id === a)!;
        const right = state.sector.nodes.find((node) => node.id === b)!;
        return `<line x1="${left.x}" y1="${left.y}" x2="${right.x}" y2="${right.y}"/>`;
      })
      .join('');

    const nodes = state.sector.nodes
      .filter((node) => shown.has(node.id))
      .map(
        (node) =>
          `<button class="sector-node ${node.visibility} ${node.id === current.id ? 'current' : ''}" style="left:${node.x}%;top:${node.y}%" data-id="${node.id}" ${!available.move || !current.neighbors.includes(node.id) ? 'disabled' : ''}>${node.visibility === 'detected' ? '?' : node.type === 'gate' && !state.sector.gateKnown ? '?' : node.type[0].toUpperCase()}</button>`
      )
      .join('');

    const disabled = (enabled: boolean) => (enabled ? '' : 'disabled');
    const signal = available.resolveSignal ? signalOptions(state, current.id) : null;
    const salvage = state.pendingSalvage
      ? `<div class="campaign-card"><h3>战后打捞</h3><p>敌舰摧毁 ${state.pendingSalvage.summary.enemyDestroyed} · 敌舰失能 ${state.pendingSalvage.summary.enemyDisabled} · 我方损失 ${state.pendingSalvage.summary.ownDestroyed}</p>${state.pendingSalvage.options
          .map(
            (option) =>
              `<button class="btn ${option.id === 'thorough' ? 'primary' : ''}" data-salvage="${option.id}">${option.label}（${option.turns} 回合 / 威胁 +${option.threat}）</button><small>${option.description}</small>`
          )
          .join('')}</div>`
      : '';

    const actions = state.pendingBattle
      ? `<button class="btn danger" id="sp-battle">解决战斗：${state.pendingBattle.reason}</button>`
      : state.pendingSalvage
        ? salvage
        : `<button class="btn" id="sp-scan" ${disabled(available.scan)}>扫描</button>
           <button class="btn" id="sp-gather" ${disabled(available.gather)}>采集</button>
           ${signal ? `<span>信号：${signalTemplate(state, current.id)}</span><button class="btn" id="sp-signal-a">${signal[0]}</button><button class="btn" id="sp-signal-b">${signal[1]}</button>` : ''}
           <button class="btn primary" id="sp-gate" ${disabled(available.enterGate)}>进入星门</button>
           <button class="btn" id="sp-wait" ${disabled(available.wait)}>等待</button>`;

    const cargo = state.cargo.items.length
      ? state.cargo.items
          .map(
            (stack) =>
              `<span>${CARGO_ITEM_LABEL[stack.type]}×${stack.quantity}${stack.type === 'supplyCrate' || stack.type === 'fuelCell' ? ` <button class="btn small" data-use-cargo="${stack.type}">使用</button>` : ''}</span>`
          )
          .join(' ')
      : '<span>货舱为空</span>';

    const ships = state.fleet.ships
      .map((ship) => {
        const repair = canFieldRepair(ship) && cargoQuantity(state.cargo, 'repairParts') > 0
          ? `<button class="btn small" data-repair="${ship.campaignShipId}">战地维修</button>`
          : '';
        const disabledControls = ship.disabled
          ? `<button class="btn small" data-tow="${ship.campaignShipId}">${ship.towed ? '停止拖曳' : '拖曳'}</button><button class="btn small" data-dismantle="${ship.campaignShipId}">拆解</button><button class="btn small danger" data-abandon="${ship.campaignShipId}">放弃</button>`
          : '';
        return `<div><b>${ship.campaignShipId}</b> ${ship.shipClass}/${ship.variant} · ${ship.disabled ? '失能' : '可战'}${ship.towed ? ' · 拖曳中' : ''} ${repair}${disabledControls}</div>`;
      })
      .join('');

    this.root.innerHTML = `<div class="campaign-screen">${campaignHud(state)}<div class="sector-map"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>${nodes}</div><div class="campaign-actions"><b>当前位置：${current.visibility === 'detected' ? '未知' : current.type}</b>${actions}</div><div class="campaign-card"><h3>货舱</h3>${cargo}</div><div class="campaign-card"><h3>持久舰队</h3>${ships}</div><div class="campaign-log">${state.history
      .slice(-8)
      .reverse()
      .map((entry) => `<div>R${entry.turn} · ${entry.text}</div>`)
      .join('')}</div><div><button class="btn" id="sp-export">导出 Campaign Code</button><button class="btn" id="sp-exit">返回主菜单</button></div>${campaignResultPanel(state)}</div>`;

    this.root.querySelectorAll('.sector-node:not([disabled])').forEach((element) => {
      (element as HTMLButtonElement).onclick = () =>
        this.cb.onAction({ type: 'move', targetNodeId: (element as HTMLElement).dataset.id! });
    });

    const click = (id: string, action: CampaignAction) => {
      const button = this.root.querySelector(id) as HTMLButtonElement | null;
      if (button) button.onclick = () => this.cb.onAction(action);
    };
    click('#sp-scan', { type: 'scan' });
    click('#sp-gather', { type: 'gather' });
    click('#sp-signal-a', { type: 'resolveSignal', optionId: 'cautious' });
    click('#sp-signal-b', { type: 'resolveSignal', optionId: 'direct' });
    click('#sp-gate', { type: 'enterGate' });
    click('#sp-wait', { type: 'wait' });

    this.root.querySelectorAll('[data-salvage]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({
        type: 'resolveSalvage',
        optionId: (element as HTMLElement).dataset.salvage as 'quick' | 'thorough' | 'leave'
      });
    });
    this.root.querySelectorAll('[data-use-cargo]').forEach((element) => {
      (element as HTMLButtonElement).onclick = () => this.cb.onAction({
        type: 'useCargo',
        itemType: (element as HTMLElement).dataset.useCargo as 'supplyCrate' | 'fuelCell'
      });
    });
    const bindShipAction = (selector: string, type: 'fieldRepair' | 'towShip' | 'dismantleShip' | 'abandonShip', key: string) => {
      this.root.querySelectorAll(selector).forEach((element) => {
        (element as HTMLButtonElement).onclick = () => this.cb.onAction({
          type,
          campaignShipId: (element as HTMLElement).dataset[key]!
        } as CampaignAction);
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
  }
}
