// 应用编排：连接配置面板、模拟器、渲染层与 HUD。
// 关键：模拟用固定 tick 推进（来自真实时间累加器，但每 tick 结果只取决于 seed）；
//   渲染在 prev/cur 之间插值，仅视觉，不影响结果。

import { createPRNG, PRNG } from './sim/prng';
import { createInitialState, createSimulator, SimContext, V4 } from './sim/rulesets';
import { encodeReplay, decodeReplay } from './sim/replayCodec';
import { SIM_VERSION_V5, TICK_MS } from './sim/battleConfig';
import { BattleState, BattleEvent, TeamConfig, ReplayConfig, Vec3, BudgetConfig } from './sim/battleTypes';
import { ThreeScene, PosSnapshot } from './render/threeScene';
import { SetupPanel } from './ui/setupPanel';
import { BattleHud } from './ui/battleHud';
import { ShipPreviewPanel } from './ui/shipPreviewPanel';
import { simulateFull, buildTimeline } from './sim/timeline';
import { loadViewPrefs, saveViewPrefs, ViewFilters } from './ui/viewPrefs';
import { BalanceLab } from './ui/balanceLab';
import { FleetLibrary } from './ui/fleetLibrary';
import { PreBattleAnalysisPanel } from './ui/preBattleAnalysis';
import { runBalance, BalanceRunConfig, BalanceResult } from './sim/balanceRunner';
import { CampaignMenu } from './ui/campaignMenu';
import { SectorMapPanel } from './ui/sectorMapPanel';
import { CampaignState, CampaignAction } from './campaign/campaignTypes';
import { createCampaign } from './campaign/campaignGenerator';
import { applyCampaignAction, applyCampaignBattleResult } from './campaign/campaignReducer';
import { loadCampaign, saveCampaign } from './campaign/campaignPersistence';
import { encodeCampaign, decodeCampaign } from './campaign/campaignCode';
import { deriveBattleSeed, enemyFleetFor, runCampaignBattle } from './campaign/fleet/battleAdapter';

export class App {
  private root: HTMLElement;
  private setupRoot: HTMLElement;
  private battleRoot: HTMLElement;
  private canvasRoot: HTMLElement;
  private hudRoot: HTMLElement;

  private setupPanel: SetupPanel;
  private hud: BattleHud;
  private previewPanel: ShipPreviewPanel;
  private balanceLab!: BalanceLab;
  private fleetLibrary!: FleetLibrary;
  private analysisPanel!: PreBattleAnalysisPanel;
  private menu!: CampaignMenu;
  private sectorMap!: SectorMapPanel;
  private campaign: CampaignState | null = null;
  private balanceWorker: Worker | null = null;

  private scene: ThreeScene | null = null;
  private sim: SimContext | null = null;
  private state: BattleState | null = null;
  private replay: ReplayConfig | null = null;
  private rng: PRNG | null = null;

  private running = false;
  private paused = false;
  private speed = 1;
  private autoCam = true;
  private lastTime = 0;
  private acc = 0;
  private rafId = 0;
  private prev = new Map<number, PosSnapshot>();
  private winnerShown = false;
  private viewPrefs: ViewFilters = {
    labels: false,
    componentDamage: false,
    auraRanges: false,
    weaponRanges: false,
    targetLines: false,
    selectedOnly: false
  };

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div id="setup-root"></div>
      <div id="menu-root"></div>
      <div id="campaign-root"></div>
      <div id="battle-root" style="display:none">
        <div id="canvas-root"></div>
        <div id="hud-root"></div>
      </div>
      <div id="preview-root"></div>
      <div id="balance-root"></div>
      <div id="fleet-root"></div>
      <div id="analysis-root"></div>
    `;
    this.setupRoot = root.querySelector('#setup-root') as HTMLElement;
    this.battleRoot = root.querySelector('#battle-root') as HTMLElement;
    this.canvasRoot = root.querySelector('#canvas-root') as HTMLElement;
    this.hudRoot = root.querySelector('#hud-root') as HTMLElement;
    const previewRoot = root.querySelector('#preview-root') as HTMLElement;
    const menuRoot = root.querySelector('#menu-root') as HTMLElement;
    const campaignRoot = root.querySelector('#campaign-root') as HTMLElement;

    this.setupPanel = new SetupPanel(this.setupRoot, {
      onStart: (a, b, seed, budget) => this.startBattle(a, b, seed, budget),
      onImport: (code) => this.importReplay(code),
      onPreview: () => this.previewPanel.show(),
      onOpenBalance: () => this.balanceLab.show(),
      onOpenFleet: () => this.fleetLibrary.show(),
      onOpenAnalysis: () => this.analysisPanel.show()
    });
    this.hud = new BattleHud(this.hudRoot, {
      onShare: () => (this.replay ? encodeReplay(this.replay) : ''),
      onExit: () => this.exitToSetup(),
      onTogglePause: () => this.togglePause(),
      onSpeed: (m) => (this.speed = m),
      onToggleAuto: () => this.toggleAuto(),
      onSeek: (tick) => this.seek(tick),
      onViewFilter: (key, value) => this.setViewFilter(key, value)
    });
    this.previewPanel = new ShipPreviewPanel(previewRoot);
    this.balanceLab = new BalanceLab(document.getElementById('balance-root') as HTMLElement, {
      onRun: (cfg) => this.startBalanceRun(cfg),
      onCancel: () => this.cancelBalance(),
      onExport: (result, format) => this.exportBalance(result, format),
      getTeamConfigs: () => this.setupPanel.getTeamConfigs()
    });
    this.fleetLibrary = new FleetLibrary(document.getElementById('fleet-root') as HTMLElement, {
      onClose: () => this.fleetLibrary.hide(),
      getTeamConfigs: () => this.setupPanel.getTeamConfigs(),
      applyPreset: (team, fleet, formation, doctrine) =>
        this.setupPanel.applyPresetToTeam(team, fleet, formation, doctrine)
    });
    this.analysisPanel = new PreBattleAnalysisPanel(
      document.getElementById('analysis-root') as HTMLElement,
      {
        onClose: () => this.analysisPanel.hide(),
        getTeamConfigs: () => this.setupPanel.getTeamConfigs()
      }
    );
    this.menu = new CampaignMenu(menuRoot, {
      onSingle: () => this.showSetup(), onNew: () => this.startCampaign((Date.now() >>> 0)), onContinue: () => this.continueCampaign(), onImport: (code) => this.importCampaign(code),
      hasSave: () => { try { return !!loadCampaign(); } catch { return false; } }
    });
    this.sectorMap = new SectorMapPanel(campaignRoot, { onAction: (a) => this.campaignAction(a), onBattle: () => this.resolveCampaignBattle(), onExport: () => this.exportCampaign(), onExit: () => this.showMenu() });
  }

  start(): void {
    this.showMenu();
  }

  campaignDebugState(): unknown { return this.campaign ? { sector: this.campaign.sectorIndex, turn: this.campaign.turn, node: this.campaign.sector.currentNodeId, threat: this.campaign.sector.threat, resources: this.campaign.resources, pendingBattle: this.campaign.pendingBattle, status: this.campaign.status } : { screen: 'menu' }; }

  private showMenu(): void { this.setupRoot.style.display = 'none'; this.battleRoot.style.display = 'none'; (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none'; this.menu.show(); }

  private showSetup(): void {
    this.menu.hide();
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    this.setupRoot.style.display = 'flex';
    this.battleRoot.style.display = 'none';
    this.setupPanel.show();
    this.hud.hide();
  }

  private showBattle(): void {
    this.menu.hide();
    this.setupRoot.style.display = 'none';
    this.battleRoot.style.display = 'block';
    this.setupPanel.hide();
    this.hud.show();
  }

  private startCampaign(seed: number): void { this.campaign = createCampaign(seed); saveCampaign(this.campaign); this.showCampaign(); }
  private continueCampaign(): void { try { this.campaign = loadCampaign(); if (!this.campaign) throw new Error('没有可继续的战役。'); this.showCampaign(); } catch (e) { alert((e as Error).message); } }
  private importCampaign(code: string): void { try { this.campaign = decodeCampaign(code); saveCampaign(this.campaign); this.showCampaign(); } catch (e) { alert('战役导入失败：' + (e as Error).message); } }
  private showCampaign(): void { if (!this.campaign) return; this.menu.hide(); this.setupRoot.style.display = 'none'; this.battleRoot.style.display = 'none'; const root = this.root.querySelector('#campaign-root') as HTMLElement; root.style.display = 'block'; this.sectorMap.render(this.campaign); }
  private campaignAction(action: CampaignAction): void { if (!this.campaign) return; this.campaign = applyCampaignAction(this.campaign, action); saveCampaign(this.campaign); this.showCampaign(); }
  private resolveCampaignBattle(): void { if (!this.campaign?.pendingBattle) return; const pending = this.campaign.pendingBattle; const seed = deriveBattleSeed(this.campaign.campaignSeed, this.campaign.sectorIndex, pending.nodeId, pending.battleIndex); const enemy = enemyFleetFor(seed, this.campaign.sectorIndex, this.campaign.sector.threat.level); const result = runCampaignBattle(this.campaign.fleet, enemy, seed); this.campaign = applyCampaignBattleResult(this.campaign, result); saveCampaign(this.campaign); this.showCampaign(); }
  private exportCampaign(): void { if (!this.campaign) return; const code = encodeCampaign(this.campaign); navigator.clipboard?.writeText(code); prompt('Campaign Code（已尝试复制）', code); }

  private startBattle(
    teamA: TeamConfig,
    teamB: TeamConfig,
    seed: number,
    budget: BudgetConfig
  ): void {
    const replay: ReplayConfig = {
      v: SIM_VERSION_V5,
      ruleset: V4,
      seed: seed >>> 0,
      budget,
      teamA,
      teamB
    };
    this.beginWithReplay(replay);
  }

  private importReplay(code: string): void {
    try {
      const replay = decodeReplay(code);
      this.beginWithReplay(replay);
    } catch (e) {
      alert('录像导入失败：' + (e as Error).message);
    }
  }

  private beginWithReplay(replay: ReplayConfig): void {
    this.replay = replay;
    // 关闭可能仍打开的配置期覆盖层（舰队库 / 战前分析），避免盖住战斗画面
    this.fleetLibrary?.hide();
    this.analysisPanel?.hide();
    this.rng = createPRNG(replay.seed);
    this.state = createInitialState(replay, this.rng);
    this.sim = createSimulator(this.state, this.rng);

    if (!this.scene) {
      this.scene = new ThreeScene(this.canvasRoot);
    }
    this.scene.buildBattle(this.state);
    this.scene.setAutoCamera(this.autoCam);

    // 应用持久化的战斗视图筛选偏好（纯渲染，不影响 sim）
    const prefs = loadViewPrefs();
    this.viewPrefs = prefs;
    this.scene.setViewFilters(prefs);
    this.hud.initViewFilters(prefs);

    this.hud.resetWinner();
    this.winnerShown = false;
    this.paused = false;
    this.speed = 1;
    this.showBattle();
    this.hud.update(this.state);

    // 通过确定性重模拟生成完整战斗时间线（不渲染、不影响结果）。
    this.generateTimeline();

    this.running = true;
    this.acc = 0;
    this.lastTime = performance.now();
    this.prev = snapshot(this.state);
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** 无渲染地完整模拟当前 replay，聚合出关键事件时间线并交给 HUD 渲染。
   *  纯读取 replay 配置，不修改任何运行中的 BattleState / sim，故不影响战斗结果。 */
  private generateTimeline(): void {
    if (!this.replay || !this.state) return;
    try {
      const events = simulateFull(this.replay);
      const markers = buildTimeline(events);
      this.hud.setTimeline(markers, this.state.maxTicks);
    } catch (e) {
      // 时间线生成失败不应阻断战斗播放
      console.warn('[timeline] 生成失败：', e);
    }
  }

  /** 进度条跳转：从初始配置 + 相同 seed 确定性重模拟到目标 tick，然后继续播放。
   *  不改变最终战斗结果——因为推进逻辑只依赖 seed，与是否中途跳转无关。 */
  private seek(targetTick: number): void {
    if (!this.replay || !this.scene) return;
    this.rng = createPRNG(this.replay.seed);
    this.state = createInitialState(this.replay, this.rng);
    this.sim = createSimulator(this.state, this.rng);

    const t = Math.max(0, Math.min(targetTick, this.state.maxTicks));
    let guard = 0;
    while (this.state.tick < t && !this.state.finished && guard < this.state.maxTicks + 5) {
      this.sim.step();
      guard++;
    }

    // 重建可视飞船（飞船 id 稳定，直接重建即可；瞬时激光/爆炸会按当前 state 重新同步）
    this.scene.buildBattle(this.state);

    this.prev = snapshot(this.state);
    this.acc = 0;
    this.winnerShown = false;
    this.paused = false;
    this.running = true;
    this.hud.resetWinner();
    this.hud.update(this.state);

    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);
  }

  private togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  private toggleAuto(): boolean {
    if (!this.scene) return false;
    this.autoCam = !this.autoCam;
    this.scene.setAutoCamera(this.autoCam);
    return this.autoCam;
  }

  /** 切换战斗视图筛选：更新渲染层并持久化偏好，不触及任何 sim 状态 */
  private setViewFilter(key: keyof ViewFilters, value: boolean): void {
    this.viewPrefs = { ...this.viewPrefs, [key]: value };
    this.scene?.setViewFilter(key, value);
    saveViewPrefs(this.viewPrefs);
  }

  private frame = (now: number): void => {
    if (!this.running || !this.state || !this.sim || !this.scene) return;
    // 限制单帧时间步长，避免后台标签页恢复时一次性推进过多（不影响确定性）
    const dt = Math.min(now - this.lastTime, 100);
    this.lastTime = now;

    // 倍速：仅控制每个渲染帧推进多少个固定 tick（dt 不参与战斗计算）
    if (!this.paused && !this.state.finished) {
      this.acc += dt * this.speed;
      const frameEvents: BattleEvent[] = [];
      while (this.acc >= TICK_MS && !this.state.finished) {
        this.prev = snapshot(this.state);
        const res = this.sim.step();
        for (const e of res.events) frameEvents.push(e);
        this.acc -= TICK_MS;
      }
      if (frameEvents.length) {
        this.scene.applyEvents(frameEvents, this.state);
        this.hud.pushEvents(frameEvents, this.state);
      }
    }

    const alpha = this.state.finished ? 1 : Math.min(this.acc / TICK_MS, 1);
    this.scene.update(this.state, this.prev, alpha);
    this.scene.render();
    this.hud.update(this.state);

    if (this.state.finished && !this.winnerShown) {
      this.winnerShown = true;
      if (this.replay) this.hud.showWinner(this.state.winner, this.state, this.replay);
      this.running = false;
    }

    if (this.running) {
      this.rafId = requestAnimationFrame(this.frame);
    }
  };

  private exitToSetup(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
    this.sim = null;
    this.state = null;
    this.rng = null;
    this.showSetup();
  }

  // ---------------- 平衡实验室（Web Worker 优先，失败回退主线程） ----------------

  private startBalanceRun(cfg: BalanceRunConfig): void {
    this.cancelBalance();
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./sim/balanceWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (worker) {
      this.balanceWorker = worker;
      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          this.balanceLab.setProgress(msg.done, msg.total);
        } else if (msg.type === 'done') {
          this.balanceLab.showResult(msg.result as BalanceResult);
          this.balanceWorker = null;
        }
      };
      worker.onerror = () => {
        // 静态单文件构建等环境可能缺少 worker 分块，回退到主线程（结果一致）
        console.warn('[balance] Worker 不可用，回退主线程运行');
        this.balanceWorker = null;
        const result = runBalance(cfg, (d, t) => this.balanceLab.setProgress(d, t));
        this.balanceLab.showResult(result);
      };
      worker.postMessage({ type: 'run', config: cfg });
    } else {
      const result = runBalance(cfg, (d, t) => this.balanceLab.setProgress(d, t));
      this.balanceLab.showResult(result);
    }
  }

  private cancelBalance(): void {
    if (this.balanceWorker) {
      this.balanceWorker.terminate();
      this.balanceWorker = null;
    }
  }

  private exportBalance(result: BalanceResult, format: 'json' | 'csv'): void {
    const seeds = result.runsList.map((r) => r.seed);
    const minSeed = seeds.length ? Math.min(...seeds) : 0;
    const maxSeed = seeds.length ? Math.max(...seeds) : 0;
    const date = new Date().toISOString().slice(0, 10);
    const base = `balance-${date}-seed${minSeed}-${maxSeed}`;
    if (format === 'json') {
      const payload = {
        type: 'spacewar-balance-result',
        v: '1',
        ruleset: result.ruleset,
        simVersion: result.simVersion,
        generatedAt: new Date().toISOString(),
        result
      };
      downloadFile(`${base}.json`, JSON.stringify(payload, null, 2), 'application/json');
    } else {
      const header = 'seed,winner,ticks,teamARemaining,teamBRemaining,teamADamage,teamBDamage';
      const rows = result.runsList.map(
        (r) =>
          `${r.seed},${r.winner ?? 'draw'},${r.ticks},${r.teamARemaining},${r.teamBRemaining},${r.teamADamage},${r.teamBDamage}`
      );
      const fv = result.fleetValue;
      const avg = (x: number) => Math.round(x / Math.max(1, result.runs));
      const reasons = Object.entries(result.victoryReasons)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      const o = result.outcome;
      const summary = [
        '',
        `# 汇总（core-v4 价值口径；operational=仍在场且具战斗力，decision=点数判定价值）`,
        `# 平均作战价值 A,${avg(fv.A.remainingOperationalValue)},B,${avg(fv.B.remainingOperationalValue)}`,
        `# 平均判定价值 A,${avg(fv.A.remainingDecisionValue)},B,${avg(fv.B.remainingDecisionValue)}`,
        `# 初始成本 A,${avg(fv.A.initialFleetCost)},B,${avg(fv.B.initialFleetCost)}`,
        `# 损毁 A,${o.destroyed.A},B,${o.destroyed.B} | 失能 A,${o.disabled.A},B,${o.disabled.B} | 脱战 A,${o.escaped.A},B,${o.escaped.B}`,
        `# 结束原因 ${reasons}`
      ];
      downloadFile(`${base}.csv`, [header, ...rows, ...summary].join('\n'), 'text/csv');
    }
  }
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function snapshot(state: BattleState): Map<number, PosSnapshot> {
  const m = new Map<number, PosSnapshot>();
  for (const s of state.ships) {
    const pos: Vec3 = { ...s.pos };
    m.set(s.id, { pos, heading: s.heading });
  }
  return m;
}
