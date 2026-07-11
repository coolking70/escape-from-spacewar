// 战斗 HUD：显示双方剩余、tick、seed、版本；结束显示胜者与战后统计；
// 提供暂停/继续、1x/2x/4x 倍速、自动镜头开关、可折叠战斗日志、进度条跳转。
// V0.3 新增：进度条 + 跳转播放、战斗日志面板、战后统计面板。

import { BattleState, BattleEvent, Team, ReplayConfig } from '../sim/battleTypes';
import { SIM_VERSION } from '../sim/battleConfig';
import { summarizeStats, formatMvp, StatsSummary } from '../sim/battleStats';
import { VARIANT_CN } from '../sim/shipVariants';
import { TimelineMarker } from '../sim/timeline';
import { ViewFilters } from '../ui/viewPrefs';

export interface HudCallbacks {
  onShare: () => string;
  onExit: () => void;
  onTogglePause: () => boolean; // 返回切换后的暂停状态
  onSpeed: (mult: number) => void;
  onToggleAuto: () => boolean; // 返回切换后的自动镜头状态
  onSeek: (tick: number) => void; // 跳转到指定 tick（确定性重模拟）
  onViewFilter: (key: keyof ViewFilters, value: boolean) => void; // 切换战斗视图筛选
}

const SHIP_CN: Record<string, string> = {
  Fighter: '战斗机',
  Frigate: '护卫舰',
  Cruiser: '巡洋舰'
};

const VICTORY_CN: Record<string, string> = {
  annihilation: '全歼',
  combatDisabled: '战术失能',
  retreat: '敌方撤退',
  timeout: '超时点数判定',
  pointsDecision: '点数判定',
  draw: '平局'
};

const RULESET_SHORT: Record<string, string> = {
  'spacewar-core-v1': 'core-v1',
  'spacewar-core-v2': 'core-v2',
  'spacewar-core-v3': 'core-v3',
  'spacewar-core-v4': 'core-v4'
};

export class BattleHud {
  private root: HTMLElement;
  private cb: HudCallbacks;

  private elTick!: HTMLElement;
  private elA!: HTMLElement;
  private elB!: HTMLElement;
  private elSeed!: HTMLElement;
  private elVer!: HTMLElement;
  private banner!: HTMLElement;
  private shareBox!: HTMLElement;
  private shareText!: HTMLTextAreaElement;
  private pauseBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private autoBtn!: HTMLButtonElement;
  private seekInput!: HTMLInputElement;
  private seekLabel!: HTMLElement;
  private logPanel!: HTMLElement;
  private logList!: HTMLElement;
  private logToggle!: HTMLButtonElement;

  private timelineEl!: HTMLElement;
  private timelineCursor!: HTMLElement;
  private timelineMarkers: TimelineMarker[] = [];
  private timelineMax = 1;

  private viewToggle!: HTMLButtonElement;
  private viewPanel!: HTMLElement;

  private finished = false;
  private seeking = false;
  private logItems: HTMLElement[] = [];
  private maxTicks = 1;

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="hud-bar">
        <div class="stat team-a">舰队A 剩余：<b id="hudA">0</b></div>
        <div class="stat team-b">舰队B 剩余：<b id="hudB">0</b></div>
        <div class="stat">Tick：<b id="hudTick">0</b></div>
        <div class="stat">种子：<b id="hudSeed">-</b></div>
        <div class="stat">版本：<b id="hudVer">-</b></div>
      </div>

      <div class="hud-log" id="hudLog" style="display:none">
        <div class="hud-log-head">战斗日志（最近 30 条）</div>
        <div class="hud-log-list" id="hudLogList"></div>
      </div>

      <div class="hud-progress">
        <span class="hud-progress-label" id="hudSeekLabel">0 / 0</span>
        <div class="seek-wrap">
          <input type="range" min="0" max="100" value="0" class="seek" id="hudSeek" />
          <div class="hud-timeline" id="hudTimeline">
            <div class="hud-timeline-track"></div>
            <div class="hud-timeline-cursor" id="hudTimelineCursor"></div>
          </div>
        </div>
      </div>

      <div class="hud-controls">
        <button class="btn ctrl" id="hudPause">暂停</button>
        <div class="speed-group">
          <span class="speed-label">倍速</span>
          <button class="btn ctrl speed" data-speed="1">1x</button>
          <button class="btn ctrl speed" data-speed="2">2x</button>
          <button class="btn ctrl speed" data-speed="4">4x</button>
        </div>
        <button class="btn ctrl" id="hudAuto">自动镜头：开</button>
        <button class="btn ctrl" id="hudLogToggle">战斗日志</button>
      </div>

      <div class="banner" id="hudBanner">
        <h2 id="hudBannerText"></h2>
        <div id="hudStats" class="banner-stats"></div>
        <button class="btn" id="hudBack">返回设置</button>
      </div>

      <div class="share-box" id="hudShareBox">
        <div class="hint">复制下面的 replay code 分享给任何人，他们导入即可复现同一场战斗：</div>
        <textarea id="hudShareText" readonly></textarea>
        <div class="actions" style="margin-top:8px">
          <button class="btn primary" id="hudCopy">复制</button>
        </div>
      </div>

      <div class="hud-actions">
        <button class="btn accent-a" id="hudShare">分享录像</button>
        <button class="btn" id="hudExit">返回设置</button>
      </div>

      <div class="hud-view" id="hudView">
        <button class="btn ctrl" id="hudViewToggle">视图</button>
        <div class="hud-view-panel" id="hudViewPanel" style="display:none">
          <div class="hud-view-head">战斗视图（不影响战斗结果）</div>
        </div>
      </div>
    `;

    this.elTick = this.root.querySelector('#hudTick') as HTMLElement;
    this.elA = this.root.querySelector('#hudA') as HTMLElement;
    this.elB = this.root.querySelector('#hudB') as HTMLElement;
    this.elSeed = this.root.querySelector('#hudSeed') as HTMLElement;
    this.elVer = this.root.querySelector('#hudVer') as HTMLElement;
    this.banner = this.root.querySelector('#hudBanner') as HTMLElement;
    this.shareBox = this.root.querySelector('#hudShareBox') as HTMLElement;
    this.shareText = this.root.querySelector('#hudShareText') as HTMLTextAreaElement;
    this.pauseBtn = this.root.querySelector('#hudPause') as HTMLButtonElement;
    this.autoBtn = this.root.querySelector('#hudAuto') as HTMLButtonElement;
    this.seekInput = this.root.querySelector('#hudSeek') as HTMLInputElement;
    this.seekLabel = this.root.querySelector('#hudSeekLabel') as HTMLElement;
    this.timelineEl = this.root.querySelector('#hudTimeline') as HTMLElement;
    this.timelineCursor = this.root.querySelector('#hudTimelineCursor') as HTMLElement;
    this.logPanel = this.root.querySelector('#hudLog') as HTMLElement;
    this.logList = this.root.querySelector('#hudLogList') as HTMLElement;
    this.logToggle = this.root.querySelector('#hudLogToggle') as HTMLButtonElement;

    this.speedBtns = Array.from(
      this.root.querySelectorAll('button.speed')
    ) as HTMLButtonElement[];

    (this.root.querySelector('#hudShare') as HTMLButtonElement).addEventListener('click', () => {
      const code = this.cb.onShare();
      this.shareText.value = code;
      this.shareBox.classList.add('open');
    });
    (this.root.querySelector('#hudCopy') as HTMLButtonElement).addEventListener('click', () => {
      this.shareText.select();
      navigator.clipboard?.writeText(this.shareText.value).then(
        () => {},
        () => {}
      );
    });
    const back = () => this.cb.onExit();
    (this.root.querySelector('#hudExit') as HTMLButtonElement).addEventListener('click', back);
    (this.root.querySelector('#hudBack') as HTMLButtonElement).addEventListener('click', back);

    this.pauseBtn.addEventListener('click', () => {
      const paused = this.cb.onTogglePause();
      this.pauseBtn.textContent = paused ? '继续' : '暂停';
    });
    this.autoBtn.addEventListener('click', () => {
      const on = this.cb.onToggleAuto();
      this.autoBtn.textContent = on ? '自动镜头：开' : '自动镜头：关';
    });
    this.speedBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mult = Number((btn as HTMLElement).dataset.speed);
        this.cb.onSpeed(mult);
        this.setSpeed(mult);
      });
    });
    this.logToggle.addEventListener('click', () => {
      const open = this.logPanel.style.display !== 'none';
      this.logPanel.style.display = open ? 'none' : 'block';
      this.logToggle.classList.toggle('active', !open);
    });

    // 进度条跳转：拖动时仅更新标签，松手时触发确定性重模拟
    this.seekInput.addEventListener('input', () => {
      this.seeking = true;
      this.seekLabel.textContent = `${this.seekInput.value} / ${this.maxTicks}`;
    });
    this.seekInput.addEventListener('change', () => {
      this.seeking = false;
      this.cb.onSeek(Number(this.seekInput.value));
    });

    this.setSpeed(1);

    // 视图筛选面板
    this.viewToggle = this.root.querySelector('#hudViewToggle') as HTMLButtonElement;
    this.viewPanel = this.root.querySelector('#hudViewPanel') as HTMLElement;
    this.viewToggle.addEventListener('click', () => {
      const open = this.viewPanel.style.display !== 'none';
      this.viewPanel.style.display = open ? 'none' : 'block';
    });
    const FILTER_DEFS: { key: keyof ViewFilters; label: string }[] = [
      { key: 'labels', label: '舰船标签' },
      { key: 'componentDamage', label: '组件受损标记' },
      { key: 'auraRanges', label: '支援光环范围' },
      { key: 'weaponRanges', label: '武器射程(选中)' },
      { key: 'targetLines', label: '目标连线' },
      { key: 'selectedOnly', label: '仅显示选中' }
    ];
    for (const { key, label } of FILTER_DEFS) {
      const wrap = document.createElement('label');
      wrap.className = 'vf-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'vf-' + key;
      const span = document.createElement('span');
      span.textContent = label;
      wrap.appendChild(input);
      wrap.appendChild(span);
      this.viewPanel.appendChild(wrap);
      input.addEventListener('change', () => this.cb.onViewFilter(key, input.checked));
    }
  }

  /** 用持久化的偏好初始化视图筛选开关状态 */
  initViewFilters(f: ViewFilters): void {
    for (const key of Object.keys(f) as (keyof ViewFilters)[]) {
      const cb = this.root.querySelector('#vf-' + key) as HTMLInputElement | null;
      if (cb) cb.checked = f[key];
    }
  }

  private setSpeed(mult: number): void {
    this.speedBtns.forEach((b) => {
      const m = Number((b as HTMLElement).dataset.speed);
      b.classList.toggle('active', m === mult);
    });
  }

  update(state: BattleState): void {
    this.elA.textContent = String(state.teamACount);
    this.elB.textContent = String(state.teamBCount);
    this.elTick.textContent = String(state.tick);
    this.elSeed.textContent = String(state.seed);
    this.elVer.textContent = `${state.version || SIM_VERSION}${state.ruleset ? ' · ' + (RULESET_SHORT[state.ruleset] ?? state.ruleset) : ''}`;

    this.maxTicks = state.maxTicks;
    this.seekInput.max = String(state.maxTicks);
    if (!this.seeking) {
      this.seekInput.value = String(state.tick);
      this.seekLabel.textContent = `${state.tick} / ${state.maxTicks}`;
    }
    // 播放头随当前 tick 移动（不影响模拟结果）
    if (this.timelineMax > 1) {
      const pct = (state.tick / this.maxTicks) * 100;
      this.timelineCursor.style.left = pct + '%';
    }
  }

  /** 接收完整战斗时间线（由 sim 确定性重模拟生成），在进度条上渲染关键事件标记。 */
  setTimeline(markers: TimelineMarker[], maxTicks: number): void {
    this.timelineMarkers = markers;
    this.timelineMax = Math.max(1, maxTicks);
    this.renderTimeline();
  }

  private renderTimeline(): void {
    if (!this.timelineEl) return;
    const track = this.timelineEl.querySelector('.hud-timeline-track');
    const cursor = this.timelineEl.querySelector('#hudTimelineCursor');
    // 清除旧标记（保留轨道与播放头）
    this.timelineEl
      .querySelectorAll('.tl-marker')
      .forEach((n) => n.remove());
    const max = this.timelineMax;
    for (const m of this.timelineMarkers) {
      const pct = (m.tick / max) * 100;
      const dot = document.createElement('div');
      dot.className =
        'tl-marker imp-' + m.importance + (m.team ? ' t-' + m.team.toLowerCase() : '');
      dot.style.left = pct + '%';
      dot.title = `[${m.tick}] ${m.label}`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onSeek(m.tick);
      });
      this.timelineEl.insertBefore(dot, cursor);
    }
  }

  /** 接收本帧由 sim 派发的高价值事件，追加到战斗日志（最多保留 30 条）。
   *  关键事件（击毁/护盾击穿/组件摧毁/无人机打击/战斗结束）可点击跳转到对应 tick。 */
  pushEvents(events: BattleEvent[], state: BattleState): void {
    for (const ev of events) {
      if (ev.type === 'shipDestroyed') {
        const team = ev.team === 'A' ? 'A' : 'B';
        this.addLog(
          ev.tick,
          `💥 舰队<span class="t-${team.toLowerCase()}">${team}</span> 的 ${SHIP_CN[ev.shipType] ?? ev.shipType}·${VARIANT_CN[ev.variant] ?? ev.variant} 被击毁`,
          ev.tick
        );
      } else if (ev.type === 'shieldDown') {
        const team = ev.team === 'A' ? 'A' : 'B';
        this.addLog(
          ev.tick,
          `🛡 舰队<span class="t-${team.toLowerCase()}">${team}</span> 一艘舰船护盾被击穿`,
          ev.tick
        );
      } else if (ev.type === 'componentDamaged' && ev.destroyed) {
        const ship = state.ships.find((s) => s.id === ev.shipId);
        if (ship) {
          const team = ship.team === 'A' ? 'A' : 'B';
          this.addLog(
            ev.tick,
            `🔧 舰队<span class="t-${team.toLowerCase()}">${team}</span> 一艘舰船关键组件被摧毁`,
            ev.tick
          );
        }
      } else if (ev.type === 'droneStrike') {
        const src = state.ships.find((s) => s.id === ev.sourceShipId);
        if (src) {
          const team = src.team === 'A' ? 'A' : 'B';
          this.addLog(
            ev.tick,
            `🛰 舰队<span class="t-${team.toLowerCase()}">${team}</span> 航母 #${ev.sourceShipId} 发动无人机打击（命中 ${ev.targetIds.length} 个目标）`,
            ev.tick
          );
        }
      } else if (ev.type === 'pointDefenseFired') {
        const atk = state.ships.find((s) => s.id === ev.attackerId);
        const tgt = state.ships.find((s) => s.id === ev.targetId);
        if (atk && tgt) {
          const team = atk.team === 'A' ? 'A' : 'B';
          this.addLog(
            ev.tick,
            `✨ 舰队<span class="t-${team.toLowerCase()}">${team}</span> 护航舰 #${ev.attackerId} 点防御击中 ${SHIP_CN[tgt.type] ?? tgt.type}`
          );
        }
      } else if (ev.type === 'supportEffect' && ev.tick % 120 === 0) {
        const src = state.ships.find((s) => s.id === ev.sourceShipId);
        if (src) {
          const team = src.team === 'A' ? 'A' : 'B';
          const what = ev.effectType === 'shield' ? '增强护盾' : '提供传感器支援';
          const label = SHIP_CN[src.type] ?? src.type;
          this.addLog(
            ev.tick,
            `🔆 舰队<span class="t-${team.toLowerCase()}">${team}</span> ${label}·${VARIANT_CN[src.variant] ?? src.variant} ${what}`
          );
        }
      } else if (ev.type === 'battleEnded') {
        const w = ev.winner ? `胜者：舰队${ev.winner}` : '平局/超时';
        this.addLog(ev.tick, `⚔ 战斗结束 · ${w}`, ev.tick);
      } else if (ev.type === 'retreatStarted') {
        const team = ev.team === 'A' ? 'A' : 'B';
        this.addLog(
          ev.tick,
          `🏳 舰队<span class="t-${team.toLowerCase()}">${team}</span> 一艘舰船开始撤退（${ev.reason}）`
        );
      } else if (ev.type === 'shipEscaped') {
        const team = ev.team === 'A' ? 'A' : 'B';
        this.addLog(
          ev.tick,
          `🚀 舰队<span class="t-${team.toLowerCase()}">${team}</span> 一艘舰船成功脱离战场（未损毁）`,
          ev.tick
        );
      } else if (ev.type === 'combatStateChanged') {
        if (ev.to === 'disabled') {
          const team = ev.team === 'A' ? 'A' : 'B';
          this.addLog(ev.tick, `⚠ 舰队<span class="t-${team.toLowerCase()}">${team}</span> #${ev.shipId} 失去战斗力`);
        }
      } else if (ev.type === 'shipDisabled' || ev.type === 'mobilityDisabled' || ev.type === 'weaponsDisabled' || ev.type === 'sensorsDisabled') {
        const team = ev.team === 'A' ? 'A' : 'B';
        const what = ev.type === 'mobilityDisabled' ? '机动' : ev.type === 'weaponsDisabled' ? '武器' : ev.type === 'sensorsDisabled' ? '传感器' : '系统';
        this.addLog(ev.tick, `🔧 舰队<span class="t-${team.toLowerCase()}">${team}</span> #${ev.shipId} ${what}失效`);
      } else if (ev.type === 'armorBreached') {
        const team = ev.team === 'A' ? 'A' : 'B';
        this.addLog(ev.tick, `🩹 舰队<span class="t-${team.toLowerCase()}">${team}</span> #${ev.shipId} 装甲被击穿（核心暴露）`);
      }
    }
  }

  private addLog(tick: number, html: string, seekTick?: number): void {
    const div = document.createElement('div');
    div.className = 'log-item' + (seekTick !== undefined ? ' clickable' : '');
    div.innerHTML = `[${tick}] ${html}`;
    if (seekTick !== undefined) {
      div.dataset.seek = String(seekTick);
      div.addEventListener('click', () => this.cb.onSeek(seekTick));
    }
    this.logList.appendChild(div);
    this.logItems.push(div);
    if (this.logItems.length > 30) {
      const removed = this.logItems.shift();
      removed?.remove();
    }
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  showWinner(winner: Team | null, state: BattleState, replay: ReplayConfig): void {
    if (this.finished) return;
    this.finished = true;

    const text = this.root.querySelector('#hudBannerText') as HTMLElement;
    let msg = '';
    if (winner === 'A') msg = '<span class="win-a">舰队 A 胜利</span>';
    else if (winner === 'B') msg = '<span class="win-b">舰队 B 胜利</span>';
    else msg = '<span class="win-draw">平局 / 超时</span>';
    const reason = state.victoryReason ? VICTORY_CN[state.victoryReason] ?? state.victoryReason : '';
    if (reason) msg += ` <span class="win-reason">（${reason}）</span>`;

    text.innerHTML = msg;
    const statsEl = this.root.querySelector('#hudStats') as HTMLElement;
    statsEl.innerHTML = this.renderStats(state, replay);
    this.banner.classList.add('show');
  }

  private renderStats(state: BattleState, replay: ReplayConfig): string {
    const s: StatsSummary = summarizeStats(state);
    const fleetText = (team: 'A' | 'B'): string => {
      const fleet = team === 'A' ? replay.teamA.fleet : replay.teamB.fleet;
      if (fleet.length === 0) return '（空）';
      return fleet
        .filter((e) => e.count > 0)
        .map((e) => `${SHIP_CN[e.shipClass]}${VARIANT_CN[e.variant]}×${e.count}`)
        .join('，');
    };
    const variantTable = (team: 'A' | 'B'): string => {
      const rows = s.variantStats
        .filter((v) => v.team === team)
        .map(
          (v) => `<tr>
            <td>${SHIP_CN[v.shipClass]}${VARIANT_CN[v.variant]}</td>
            <td>${v.deployed}</td>
            <td>${v.lost}</td>
            <td>${v.damage}</td>
            <td>${v.kills}</td>
            <td>${v.damagePerCost}</td>
            <td>${v.killsPerCost}</td>
          </tr>`
        )
        .join('');
      return `
        <table class="variant-table">
          <thead><tr><th>改型</th><th>投入</th><th>损失</th><th>伤害</th><th>击毁</th><th>伤害/点</th><th>击毁/点</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7">无</td></tr>'}</tbody>
        </table>`;
    };
    const c = s.counts;
    const reasonTxt = s.victoryReason ? VICTORY_CN[s.victoryReason] ?? s.victoryReason : '—';
    return `
      <div class="stat-grid">
        <div><span>总 Tick</span><b>${s.totalTicks}</b></div>
        <div><span>模拟时长</span><b>${s.simSeconds}s</b></div>
        <div><span>结束原因</span><b>${reasonTxt}</b></div>
        <div><span>在场舰船</span><b class="t-a">A ${s.battlefieldRemaining.A}</b> / <b class="t-b">B ${s.battlefieldRemaining.B}</b></div>
        <div><span>可战斗</span><b class="t-a">A ${s.combatCapableRemaining.A}</b> / <b class="t-b">B ${s.combatCapableRemaining.B}</b></div>
        <div><span>脱战/失能/损毁</span><b class="t-a">A ${c.A.escaped}/${c.A.disabled}/${c.A.destroyed}</b> / <b class="t-b">B ${c.B.escaped}/${c.B.disabled}/${c.B.destroyed}</b></div>
        <div><span>总伤害</span><b class="t-a">A ${s.totalDamage.A}</b> / <b class="t-b">B ${s.totalDamage.B}</b></div>
        <div><span>击毁数</span><b class="t-a">A ${s.kills.A}</b> / <b class="t-b">B ${s.kills.B}</b></div>
        <div><span>作战价值(operational)</span><b class="t-a">A ${Math.round(s.fleetValue.A.remainingOperationalValue)}</b> / <b class="t-b">B ${Math.round(s.fleetValue.B.remainingOperationalValue)}</b></div>
        <div><span>判定价值(decision)</span><b class="t-a">A ${Math.round(s.fleetValue.A.remainingDecisionValue)}</b> / <b class="t-b">B ${Math.round(s.fleetValue.B.remainingDecisionValue)}</b></div>
        <div><span>价值明细</span><b class="t-a">损毁${Math.round(s.fleetValue.A.destroyedValue)}/失能${Math.round(s.fleetValue.A.disabledValue)}/脱战${Math.round(s.fleetValue.A.escapedValue)}</b> / <b class="t-b">损毁${Math.round(s.fleetValue.B.destroyedValue)}/失能${Math.round(s.fleetValue.B.disabledValue)}/脱战${Math.round(s.fleetValue.B.escapedValue)}</b></div>
        <div><span>MVP 伤害</span><b>${formatMvp(s.mvpDamage)}</b></div>
        <div><span>MVP 击毁</span><b>${formatMvp(s.mvpKills)}</b></div>
      </div>
      <div class="stat-note-wrap">
        <details class="stat-note-details">
          <summary>价值口径说明（点击展开）</summary>
          <div class="stat-note">在场=未脱战且未损毁（含失能）；可战斗=排除脱战/失能/损毁；作战价值=仍在场且具战斗力(normal/damaged/critical/retreating=100%)；判定价值含脱战(100%)、失能(50%)、损毁(0%)，用于超时/点数裁决。价值守恒：损毁+失能+脱战+作战 = 初始成本。</div>
        </details>
      </div>
      <div class="stat-cfg">
        <div>舰队A：${fleetText('A')} · 阵型:${replay.teamA.formation} · 战术:${replay.teamA.doctrine}</div>
        <div>舰队B：${fleetText('B')} · 阵型:${replay.teamB.formation} · 战术:${replay.teamB.doctrine}</div>
      </div>
      <div class="variant-stats">
        <div class="vs-col">
          <div class="vs-title t-a">舰队 A 改型统计</div>
          ${variantTable('A')}
        </div>
        <div class="vs-col">
          <div class="vs-title t-b">舰队 B 改型统计</div>
          ${variantTable('B')}
        </div>
      </div>
    `;
  }

  resetWinner(): void {
    this.finished = false;
    this.banner.classList.remove('show');
    this.shareBox.classList.remove('open');
    this.logItems = [];
    this.logList.innerHTML = '';
    this.timelineMarkers = [];
    this.logPanel.style.display = 'none';
    this.logToggle.classList.remove('active');
  }

  show(): void {
    this.root.style.display = 'block';
  }
  hide(): void {
    this.root.style.display = 'none';
  }
}
