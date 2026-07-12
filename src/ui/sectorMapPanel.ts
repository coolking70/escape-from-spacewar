import { CampaignAction, CampaignState } from '../campaign/campaignTypes';
import { visibleSectorGraph } from '../campaign/sector/sectorVisibility';
import { signalOptions, signalTemplate } from '../campaign/sector/sectorActions';
import { campaignHud } from './campaignHud';
import { campaignResultPanel } from './campaignResultPanel';

export class SectorMapPanel {
  constructor(private root: HTMLElement, private cb: { onAction: (a: CampaignAction) => void; onBattle: () => void; onExport: () => void; onExit: () => void }) {}
  render(state: CampaignState): void {
    const current = state.sector.nodes.find((node) => node.id === state.sector.currentNodeId)!;
    const graph = visibleSectorGraph(state.sector); const shown = new Set(graph.nodeIds);
    const edges = graph.edges.map(([a, b]) => { const left = state.sector.nodes.find((node) => node.id === a)!; const right = state.sector.nodes.find((node) => node.id === b)!; return `<line x1="${left.x}" y1="${left.y}" x2="${right.x}" y2="${right.y}"/>`; }).join('');
    const nodes = state.sector.nodes.filter((node) => shown.has(node.id)).map((node) => `<button class="sector-node ${node.visibility} ${node.id === current.id ? 'current' : ''}" style="left:${node.x}%;top:${node.y}%" data-id="${node.id}" ${!current.neighbors.includes(node.id) || !!state.pendingBattle || state.status !== 'active' ? 'disabled' : ''}>${node.visibility === 'detected' ? '?' : node.type === 'gate' && !state.sector.gateKnown ? '?' : node.type[0].toUpperCase()}</button>`).join('');
    const disabled = (ok: boolean) => ok && state.status === 'active' ? '' : 'disabled';
    const signal = current.type === 'signal' && !current.signalResolved ? signalOptions(state, current.id) : null;
    const actions = state.pendingBattle ? `<button class="btn danger" id="sp-battle">解决战斗：${state.pendingBattle.reason}</button>` : `<button class="btn" id="sp-scan" ${disabled(true)}>扫描</button><button class="btn" id="sp-gather" ${disabled(current.type === 'resource' && !current.gathered)}>采集</button>${signal ? `<span>信号：${signalTemplate(state,current.id)}</span><button class="btn" id="sp-signal-a">${signal[0]}</button><button class="btn" id="sp-signal-b">${signal[1]}</button>` : ''}<button class="btn primary" id="sp-gate" ${disabled(current.type === 'gate')}>进入星门</button><button class="btn" id="sp-wait" ${disabled(true)}>等待</button>`;
    this.root.innerHTML = `<div class="campaign-screen">${campaignHud(state)}<div class="sector-map"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${edges}</svg>${nodes}</div><div class="campaign-actions"><b>当前位置：${current.visibility === 'detected' ? '未知' : current.type}</b>${actions}</div><div class="campaign-log">${state.history.slice(-6).reverse().map((h) => `<div>R${h.turn} · ${h.text}</div>`).join('')}</div><div><button class="btn" id="sp-export">导出 Campaign Code</button><button class="btn" id="sp-exit">返回主菜单</button></div>${campaignResultPanel(state)}</div>`;
    this.root.querySelectorAll('.sector-node:not([disabled])').forEach((el) => (el as HTMLButtonElement).onclick = () => this.cb.onAction({ type: 'move', targetNodeId: (el as HTMLElement).dataset.id! }));
    const click = (id: string, action: CampaignAction) => { const button = this.root.querySelector(id) as HTMLButtonElement | null; if (button) button.onclick = () => this.cb.onAction(action); };
    click('#sp-scan', { type: 'scan' }); click('#sp-gather', { type: 'gather' }); click('#sp-signal-a', { type: 'resolveSignal', optionId: 'cautious' }); click('#sp-signal-b', { type: 'resolveSignal', optionId: 'direct' }); click('#sp-gate', { type: 'enterGate' }); click('#sp-wait', { type: 'wait' });
    const battle = this.root.querySelector('#sp-battle') as HTMLButtonElement | null; if (battle) battle.onclick = this.cb.onBattle;
    (this.root.querySelector('#sp-export') as HTMLButtonElement).onclick = this.cb.onExport; (this.root.querySelector('#sp-exit') as HTMLButtonElement).onclick = this.cb.onExit;
  }
}
