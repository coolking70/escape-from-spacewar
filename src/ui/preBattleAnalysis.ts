// 战前分析 UI：双栏对比两队的舰队构成静态评分。
// 重要约束（与 preBattleAnalyzer 一致）：
//   - 只展示舰队构成的派生数据，绝不预测固定 seed 下的确切胜负。
//   - 不读取 PRNG / 真实时间，不修改任何 BattleConfig / ReplayConfig。
//   - 分析结果只是 UI 展示用的纯函数输出。

import { TeamConfig } from '../sim/battleTypes';
import { analyzePreBattle, TeamAnalysis } from '../sim/preBattleAnalyzer';
import { SHIP_CN, VARIANT_CN } from '../sim/shipVariants';

export interface PreBattleCallbacks {
  onClose: () => void;
  getTeamConfigs: () => { teamA: TeamConfig; teamB: TeamConfig };
}

const TENDENCY_LABELS: { key: keyof TeamAnalysis['tendency']; label: string }[] = [
  { key: 'speed', label: '机动' },
  { key: 'range', label: '射程' },
  { key: 'firepower', label: '火力' },
  { key: 'defense', label: '防御' },
  { key: 'support', label: '支援' }
];

const CAPABILITY_LABELS: { key: keyof TeamAnalysis['capability']; label: string }[] = [
  { key: 'antiFighter', label: '反小船' },
  { key: 'antiCapital', label: '反大舰' },
  { key: 'pointDefense', label: '点防御' },
  { key: 'sensor', label: '传感' },
  { key: 'shield', label: '护盾' },
  { key: 'drone', label: '无人机' }
];

export class PreBattleAnalysisPanel {
  private root: HTMLElement;
  private cb: PreBattleCallbacks;
  private overlay!: HTMLElement;

  constructor(root: HTMLElement, cb: PreBattleCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="pre-battle" id="pbRoot" style="display:none">
        <div class="pb-modal">
          <div class="bl-head">
            <h2>战前分析</h2>
            <button class="btn" id="pbClose">关闭</button>
          </div>
          <div class="pb-disclaimer" id="pbDisclaimer"></div>
          <div class="pb-body" id="pbBody"></div>
          <div class="pb-compare" id="pbCompare"></div>
        </div>
      </div>
    `;
    (this.root.querySelector('#pbClose') as HTMLButtonElement).addEventListener('click', () =>
      this.cb.onClose()
    );
    this.overlay = this.root.querySelector('#pbRoot') as HTMLElement;
  }

  show(): void {
    const { teamA, teamB } = this.cb.getTeamConfigs();
    const analysis = analyzePreBattle(teamA, teamB);
    (this.root.querySelector('#pbDisclaimer') as HTMLElement).textContent = analysis.disclaimer;
    (this.root.querySelector('#pbBody') as HTMLElement).innerHTML =
      `<div class="pb-col t-a">${this.renderTeam(analysis.a)}</div>` +
      `<div class="pb-col t-b">${this.renderTeam(analysis.b)}</div>`;
    (this.root.querySelector('#pbCompare') as HTMLElement).innerHTML =
      analysis.comparison.length > 0
        ? `<div class="pb-compare-title">双方对比提示</div><ul class="pb-compare-list">${analysis.comparison
            .map((c) => `<li>${c}</li>`)
            .join('')}</ul>`
        : `<div class="pb-compare-empty">双方配置未发现明显克制关系。</div>`;
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  private renderTeam(t: TeamAnalysis): string {
    const classLine = (['Fighter', 'Frigate', 'Cruiser'] as const)
      .map((c) => `${SHIP_CN[c] ?? c} ${t.byClass[c]}`)
      .join(' · ');

    const tendencyBars = TENDENCY_LABELS.map(({ key, label }) => {
      const v = Math.max(0, Math.min(1, t.tendency[key]));
      const pct = Math.round(v * 100);
      return `
        <div class="pb-bar-row">
          <span class="pb-bar-label">${label}</span>
          <span class="pb-bar"><i style="width:${pct}%"></i></span>
          <span class="pb-bar-val">${t.tendency[key].toFixed(2)}</span>
        </div>`;
    }).join('');

    const caps = CAPABILITY_LABELS.filter((c) => t.capability[c.key] > 0);
    const capHtml = caps.length
      ? caps
          .map((c) => `<span class="pb-cap">${c.label} ${t.capability[c.key]}</span>`)
          .join('')
      : '<span class="pb-cap pb-cap-none">无特殊手段</span>';

    const variantHtml = t.variantCounts
      .map((v) => `${VARIANT_CN[v.variant] ?? v.variant}×${v.count}`)
      .join('，');

    const strengths = t.strengths
      .map((s) => `<li class="pb-good">${s}</li>`)
      .join('');
    const weaknesses = t.weaknesses
      .map((s) => `<li class="pb-bad">${s}</li>`)
      .join('');

    return `
      <div class="pb-team-head ${t.team === 'A' ? 't-a' : 't-b'}">舰队 ${t.team}</div>
      <div class="pb-meta">舰船 ${t.totalShips} · 点数 ${t.totalPoints}</div>
      <div class="pb-class">${classLine}</div>
      <div class="pb-variants">${variantHtml}</div>

      <div class="pb-sub">能力倾向</div>
      <div class="pb-bars">${tendencyBars}</div>

      <div class="pb-sub">具备手段</div>
      <div class="pb-caps">${capHtml}</div>

      <div class="pb-sub">优势</div>
      <ul class="pb-list">${strengths}</ul>
      <div class="pb-sub">短板</div>
      <ul class="pb-list">${weaknesses}</ul>

      <div class="pb-note">${t.formationDoctrineNote}</div>
    `;
  }
}
