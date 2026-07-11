// 平衡实验室 UI：覆盖层，读取当前设置中的双方舰队，配置批量参数，
// 通过 App 在 Web Worker 中运行（纯 sim），并以表格呈现统计结果。
// 该面板只发请求、收结果，不接触任何渲染或战斗状态。

import { TeamConfig, FormationType, DoctrineType, FleetEntry } from '../sim/battleTypes';
import { BalanceRunConfig, BalanceResult, RunRecord } from '../sim/balanceRunner';
import { VARIANT_CN, SHIP_CN } from '../sim/shipVariants';
import { RULESET_OPTIONS } from '../sim/rulesets';

export interface BalanceLabCallbacks {
  onRun: (cfg: BalanceRunConfig) => void;
  onCancel: () => void;
  onExport: (result: BalanceResult, format: 'json' | 'csv') => void;
  getTeamConfigs: () => { teamA: TeamConfig; teamB: TeamConfig };
}

const FORMATIONS: FormationType[] = ['line', 'wedge', 'wall', 'swarm', 'random'];
const DOCTRINES: DoctrineType[] = [
  'balanced',
  'aggressive',
  'defensive',
  'kite',
  'focusFire',
  'antiCapital',
  'screen'
];
const RUNS_OPTIONS = [10, 20, 50, 100];

export class BalanceLab {
  private root: HTMLElement;
  private cb: BalanceLabCallbacks;
  private overlay!: HTMLElement;
  private lastResult: BalanceResult | null = null;
  private running = false;

  constructor(root: HTMLElement, cb: BalanceLabCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  private render(): void {
    const optHtml = (arr: string[], sel?: string) =>
      arr.map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${v}</option>`).join('');
    const runsHtml = RUNS_OPTIONS.map((n) => `<option value="${n}">${n}</option>`).join('');

    this.root.innerHTML = `
      <div class="balance-lab" id="blRoot" style="display:none">
        <div class="bl-modal">
          <div class="bl-head">
            <h2>平衡实验室</h2>
            <button class="btn" id="blClose">关闭</button>
          </div>
          <div class="bl-body">
            <div class="bl-cols">
              <div class="bl-col">
                <div class="bl-col-title t-a">舰队 A（青）</div>
                <div id="blFleetA" class="bl-fleet"></div>
                <label>阵型 <select id="blFormA">${optHtml(FORMATIONS, 'line')}</select></label>
                <label>战术 <select id="blDocA">${optHtml(DOCTRINES, 'balanced')}</select></label>
              </div>
              <div class="bl-col">
                <div class="bl-col-title t-b">舰队 B（品红）</div>
                <div id="blFleetB" class="bl-fleet"></div>
                <label>阵型 <select id="blFormB">${optHtml(FORMATIONS, 'line')}</select></label>
                <label>战术 <select id="blDocB">${optHtml(DOCTRINES, 'balanced')}</select></label>
              </div>
            </div>

            <div class="bl-config">
              <label>规则集 <select id="blRuleset">${RULESET_OPTIONS.map(
                (o) => `<option value="${o.id}">${o.label}</option>`
              ).join('')}</select></label>
              <label>局数 <select id="blRuns">${runsHtml}</select></label>
              <label>起始种子 <input id="blSeed" type="number" value="1000" /></label>
              <label>种子步长 <input id="blSeedStep" type="number" value="1" /></label>
              <label>最大 tick <input id="blMaxTicks" type="number" value="4000" /></label>
              <label class="bl-check"><input id="blSwap" type="checkbox" /> 交换双方（位置偏差检测）</label>
            </div>

            <div class="bl-actions">
              <button class="btn primary" id="blRun">运行</button>
              <button class="btn" id="blCancel" style="display:none">取消</button>
              <button class="btn" id="blExportJson" style="display:none">导出 JSON</button>
              <button class="btn" id="blExportCsv" style="display:none">导出 CSV</button>
            </div>

            <div class="bl-progress" id="blProgress" style="display:none">
              <div class="bl-progress-bar" id="blProgressBar"></div>
              <span id="blProgressLabel"></span>
            </div>

            <div class="bl-result" id="blResult"></div>
          </div>
        </div>
      </div>
    `;

    (this.root.querySelector('#blClose') as HTMLButtonElement).addEventListener('click', () => this.hide());
    (this.root.querySelector('#blRun') as HTMLButtonElement).addEventListener('click', () => this.run());
    (this.root.querySelector('#blCancel') as HTMLButtonElement).addEventListener('click', () => {
      this.cb.onCancel();
      this.setRunning(false);
    });
    (this.root.querySelector('#blExportJson') as HTMLButtonElement).addEventListener('click', () => {
      if (this.lastResult) this.cb.onExport(this.lastResult, 'json');
    });
    (this.root.querySelector('#blExportCsv') as HTMLButtonElement).addEventListener('click', () => {
      if (this.lastResult) this.cb.onExport(this.lastResult, 'csv');
    });

    this.overlay = this.root.querySelector('#blRoot') as HTMLElement;
  }

  show(): void {
    const { teamA, teamB } = this.cb.getTeamConfigs();
    this.fillFleet('blFleetA', teamA.fleet);
    this.fillFleet('blFleetB', teamB.fleet);
    (this.root.querySelector('#blFormA') as HTMLSelectElement).value = teamA.formation;
    (this.root.querySelector('#blDocA') as HTMLSelectElement).value = teamA.doctrine;
    (this.root.querySelector('#blFormB') as HTMLSelectElement).value = teamB.formation;
    (this.root.querySelector('#blDocB') as HTMLSelectElement).value = teamB.doctrine;
    this.setRunning(false);
    (this.root.querySelector('#blResult') as HTMLElement).innerHTML = '';
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  private fillFleet(elId: string, fleet: FleetEntry[]): void {
    const el = this.root.querySelector('#' + elId) as HTMLElement;
    if (fleet.length === 0) {
      el.innerHTML = '<div class="bl-empty">（空）</div>';
      return;
    }
    el.innerHTML = fleet
      .map(
        (e) =>
          `<div class="bl-fleet-row">${SHIP_CN[e.shipClass] ?? e.shipClass}${
            VARIANT_CN[e.variant] ?? e.variant
          } ×${e.count}</div>`
      )
      .join('');
  }

  private setRunning(running: boolean): void {
    this.running = running;
    (this.root.querySelector('#blRun') as HTMLButtonElement).style.display = running ? 'none' : '';
    (this.root.querySelector('#blCancel') as HTMLButtonElement).style.display = running ? '' : 'none';
    (this.root.querySelector('#blProgress') as HTMLElement).style.display = running ? 'flex' : 'none';
    (this.root.querySelector('#blExportJson') as HTMLButtonElement).style.display = 'none';
    (this.root.querySelector('#blExportCsv') as HTMLButtonElement).style.display = 'none';
  }

  private assembleConfig(): BalanceRunConfig {
    const { teamA, teamB } = this.cb.getTeamConfigs();
    const num = (id: string, dflt: number) => {
      const v = Number((this.root.querySelector('#' + id) as HTMLInputElement).value);
      return Number.isFinite(v) ? v >>> 0 : dflt;
    };
    const sel = (id: string, dflt: string) =>
      (this.root.querySelector('#' + id) as HTMLSelectElement).value || dflt;
    const runs = Number((this.root.querySelector('#blRuns') as HTMLSelectElement).value) || 20;
    const swap = (this.root.querySelector('#blSwap') as HTMLInputElement).checked;
    return {
      teamA: { ...teamA, formation: sel('blFormA', teamA.formation) as FormationType, doctrine: sel('blDocA', teamA.doctrine) as DoctrineType },
      teamB: { ...teamB, formation: sel('blFormB', teamB.formation) as FormationType, doctrine: sel('blDocB', teamB.doctrine) as DoctrineType },
      seed: num('blSeed', 1000),
      seedStep: num('blSeedStep', 1),
      runs,
      maxTicks: num('blMaxTicks', 4000),
      swapSides: swap,
      ruleset: sel('blRuleset', 'spacewar-core-v4')
    };
  }

  private run(): void {
    if (this.running) return;
    const cfg = this.assembleConfig();
    this.setRunning(true);
    this.setProgress(0, cfg.runs);
    (this.root.querySelector('#blResult') as HTMLElement).innerHTML = '';
    this.cb.onRun(cfg);
  }

  setProgress(done: number, total: number): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const bar = this.root.querySelector('#blProgressBar') as HTMLElement;
    const label = this.root.querySelector('#blProgressLabel') as HTMLElement;
    bar.style.width = pct + '%';
    label.textContent = ` ${done} / ${total}`;
  }

  showResult(result: BalanceResult): void {
    this.lastResult = result;
    this.setRunning(false);
    (this.root.querySelector('#blResult') as HTMLElement).innerHTML = this.renderResult(result);
    (this.root.querySelector('#blExportJson') as HTMLButtonElement).style.display = '';
    (this.root.querySelector('#blExportCsv') as HTMLButtonElement).style.display = '';
  }

  private renderResult(r: BalanceResult): string {
    const pct = (x: number) => x.toFixed(1) + '%';
    const VICTORY_CN: Record<string, string> = {
      annihilation: '全歼',
      combatDisabled: '战术失能',
      retreat: '敌方撤退',
      timeout: '超时点数判定',
      pointsDecision: '点数判定',
      draw: '平局',
      unknown: '未知'
    };
    let html = '<div class="bl-section"><div class="bl-section-title">总览</div>';
    html += `
      <div class="stat-grid">
        <div><span>规则集</span><b>${r.ruleset}</b></div>
        <div><span>模拟版本</span><b>${r.simVersion}</b></div>
        <div><span>局数</span><b>${r.runs}</b></div>
        <div><span>A 胜率</span><b class="t-a">${pct(r.winRateA)}</b></div>
        <div><span>B 胜率</span><b class="t-b">${pct(r.winRateB)}</b></div>
        <div><span>平局率</span><b>${pct(r.drawRate)}</b></div>
        <div><span>平均 tick</span><b>${r.avgTicks}</b></div>
        <div><span>tick 范围</span><b>${r.minTicks} ~ ${r.maxTicks}</b></div>
        <div><span>平均剩余 A/B</span><b class="t-a">${r.avgRemainA}</b> / <b class="t-b">${r.avgRemainB}</b></div>
        <div><span>最大剩余 A/B</span><b>${r.maxRemainA} / ${r.maxRemainB}</b></div>
        <div><span>平均剩余点数 A/B</span><b class="t-a">${r.avgPointsA}</b> / <b class="t-b">${r.avgPointsB}</b></div>
        <div><span>平均伤害 A/B</span><b class="t-a">${r.avgDamageA}</b> / <b class="t-b">${r.avgDamageB}</b></div>
      </div>`;

    const reasons = Object.entries(r.victoryReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${VICTORY_CN[k] ?? k}: ${v}`)
      .join('　');
    if (reasons) html += `<div class="bl-bias bl-ok">结束原因分布：${reasons}</div>`;

    const o = r.outcome;
    const hasOutcome = o.destroyed.A + o.destroyed.B + o.escaped.A + o.escaped.B + o.disabled.A + o.disabled.B > 0;
    if (hasOutcome) {
      html += `<div class="bl-bias bl-ok">损毁 A${o.destroyed.A}/B${o.destroyed.B} · 失能 A${o.disabled.A}/B${o.disabled.B} · 脱战 A${o.escaped.A}/B${o.escaped.B}</div>`;
    }

    // 舰队价值（core-v4 价值口径：operational=仍在场且具战斗力；decision=点数判定价值）
    const fv = r.fleetValue;
    const avg = (x: number) => Math.round(x / Math.max(1, r.runs));
    if (fv) {
      html += `<div class="bl-bias bl-ok">平均舰队价值 → 作战价值 A${avg(fv.A.remainingOperationalValue)}/B${avg(
        fv.B.remainingOperationalValue
      )} · 判定价值 A${avg(fv.A.remainingDecisionValue)}/B${avg(
        fv.B.remainingDecisionValue
      )}（初始成本 A${avg(fv.A.initialFleetCost)}/B${avg(fv.B.initialFleetCost)}）</div>`;
    }

    if (r.positionBias) {
      const b = r.positionBias;
      const warnCls = b.warning ? 'bl-warn' : 'bl-ok';
      const warnTxt = b.warning ? '⚠ 位置偏差 > 5%，疑似存在位置相关不对称' : '✓ 位置偏差 < 5%，对称性良好';
      html += `<div class="bl-bias ${warnCls}">位置偏差：side A 胜 ${b.sideAWins} / side B 胜 ${b.sideBWins}（差 ${b.diffPct.toFixed(1)}%） ${warnTxt}</div>`;
    }

    if (r.zeroDamageAnomalies.length) {
      html += `<div class="bl-warn">零伤害异常 ${r.zeroDamageAnomalies.length} 例：${r.zeroDamageAnomalies
        .map((a) => `#${a.seed}(${a.team})`)
        .join(' ')}</div>`;
    }
    html += '</div>';

    // 每改型统计
    html += '<div class="bl-section"><div class="bl-section-title">每改型统计</div>';
    html += `
      <table class="variant-table bl-variant">
        <thead><tr>
          <th>队伍</th><th>舰种</th><th>改型</th><th>投入</th><th>损失</th>
          <th>损失率</th><th>存活率</th><th>伤害</th><th>击毁</th><th>伤害/点</th><th>击毁/点</th>
        </tr></thead>
        <tbody>${r.variantStats
          .map(
            (v) => `<tr>
              <td class="${v.team === 'A' ? 't-a' : 't-b'}">${v.team}</td>
              <td>${SHIP_CN[v.shipClass] ?? v.shipClass}</td>
              <td>${VARIANT_CN[v.variant] ?? v.variant}</td>
              <td>${v.deployed}</td>
              <td>${v.lost}</td>
              <td>${(v.lossRate * 100).toFixed(0)}%</td>
              <td>${(v.survival * 100).toFixed(0)}%</td>
              <td>${Math.round(v.damage)}</td>
              <td>${v.kills}</td>
              <td>${v.damagePerCost.toFixed(2)}</td>
              <td>${v.killsPerCost.toFixed(3)}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>`;
    html += '</div>';

    // 长战斗
    if (r.longBattles.length) {
      html += '<div class="bl-section"><div class="bl-section-title">长战斗（≥90% maxTicks）</div>';
      html += `<div class="bl-list">${r.longBattles
        .map((b) => `#${b.seed} → ${b.ticks}t, 剩余 A${b.teamARemaining}/B${b.teamBRemaining}`)
        .join('　')}</div></div>`;
    }

    // 逐局列表（可滚动）
    html += '<div class="bl-section"><div class="bl-section-title">逐局结果</div>';
    html += `
      <div class="bl-runs">
        <table class="variant-table">
          <thead><tr><th>#</th><th>seed</th><th>胜者</th><th>tick</th><th>剩余A</th><th>剩余B</th><th>伤害A</th><th>伤害B</th></tr></thead>
          <tbody>${r.runsList
            .map(
              (rec: RunRecord) => `<tr>
                <td>${rec.index}</td>
                <td>${rec.seed}</td>
                <td class="${rec.winner === 'A' ? 't-a' : rec.winner === 'B' ? 't-b' : ''}">${
                rec.winner ?? '平'
              }</td>
                <td>${rec.ticks}</td>
                <td>${rec.teamARemaining}</td>
                <td>${rec.teamBRemaining}</td>
                <td>${rec.teamADamage}</td>
                <td>${rec.teamBDamage}</td>
              </tr>`
            )
            .join('')}</tbody>
        </table>
      </div></div>`;

    return html;
  }
}
