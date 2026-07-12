import { CampaignState } from '../campaign/campaignTypes';

function defeatMessage(state: CampaignState): string {
  if (state.fleet.ships.length === 0) return '你的舰队已被全歼，远征到此结束。';
  if (!state.commander.alive) return '指挥官已阵亡，远征到此结束。';
  return '舰队已无法继续远征。';
}

export function campaignResultPanel(state: CampaignState, showFullLog: boolean): string {
  if (state.status === 'active') return '';
  const victory = state.status === 'victory';
  const logs = showFullLog
    ? `<div class="campaign-result-log">${state.history
        .slice()
        .reverse()
        .map((entry) => `<div>R${entry.turn} · ${entry.text}</div>`)
        .join('')}</div>`
    : '';
  return `<div class="campaign-result-overlay" role="dialog" aria-modal="true" aria-labelledby="campaign-result-title">
    <section class="campaign-result ${state.status}">
      <p class="campaign-result-kicker">远征结算</p>
      <h2 id="campaign-result-title">${victory ? '战役胜利' : '战役失败'}</h2>
      <p>${victory ? '你成功穿越了第三个星域。' : defeatMessage(state)}</p>
      <p class="campaign-result-summary">完成 ${state.turn} 回合 · 剩余舰船 ${state.fleet.ships.length} · 威胁等级 ${state.sector.threat.level}</p>
      ${logs}
      <div class="campaign-result-actions">
        <button class="btn" data-campaign-result="log">${showFullLog ? '收起完整日志' : '显示完整日志'}</button>
        <button class="btn" data-campaign-result="export-log">导出完整日志（JSON）</button>
        <button class="btn" data-campaign-result="export">导出 Campaign Code</button>
        <button class="btn primary" data-campaign-result="menu">返回主菜单</button>
      </div>
    </section>
  </div>`;
}
