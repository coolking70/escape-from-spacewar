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
import { applyCampaignAction, applyCampaignBattleResult } from './campaign/campaignReducerV09';
import { loadCampaign, saveCampaign } from './campaign/campaignPersistence';
import { encodeCampaign, decodeCampaign } from './campaign/campaignCode';
import { encodeCampaignLog } from './campaign/campaignLog';
import { CampaignBattleContext, deriveBattleSeed, enemyFleetFor, prepareCampaignBattle } from './campaign/fleet/battleAdapter';

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
  private battleOrigin: 'single' | 'campaign' = 'single';
  private campaignBattleContext: CampaignBattleContext | null = null;
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
      onShare: () =>
        this.battleOrigin === 'campaign' ? '' : this.replay ? encodeReplay(this.replay) : '',
      onExit: () => this.exitBattle(),
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
      onSingle: () => this.showSetup(),
      onNew: () => this.startCampaign(Date.now() >>> 0),
      onContinue: () => this.continueCampaign(),
      onImport: (code) => this.importCampaign(code),
      hasSave: () => {
        try {
          return !!loadCampaign();
        } catch {
          return false;
        }
      }
    });
    this.sectorMap = new SectorMapPanel(campaignRoot, {
      onAction: (action) => this.campaignAction(action),
      onBattle: () => this.resolveCampaignBattle(),
      onExport: () => this.exportCampaign(),
      onExportLog: () => this.exportCampaignLog(),
      onExit: () => this.showMenu()
    });
  }

  start(): void {
    this.showMenu();
  }

  campaignDebugState(): unknown {
    return this.campaign
      ? {
          sector: this.campaign.sectorIndex,
          turn: this.campaign.turn,
          node: this.campaign.sector.currentNodeId,
          threat: this.campaign.sector.threat,
          resources: this.campaign.resources,
          organization: this.campaign.organization,
          pendingBattle: this.campaign.pendingBattle,
          pendingOrganizationEvent: this.campaign.pendingOrganizationEvent,
          status: this.campaign.status
        }
      : { screen: 'menu' };
  }

  private showMenu(): void {
    this.setupRoot.style.display = 'none';
    this.battleRoot.style.display = 'none';
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'block';
    this.menu.show();
  }

  private showSetup(): void {
    this.menu.hide();
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    this.setupRoot.style.display = 'flex';
    this.battleRoot.style.display = 'none';
    this.setupPanel.show();
    this.hud.hide();
  }

  private showBattle(): void {
    this.menu.hide();
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'none';
    this.setupRoot.style.display = 'none';
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    this.battleRoot.style.display = 'block';
    this.setupPanel.hide();
    this.hud.show();
  }

  private startCampaign(seed: number): void {
    this.campaign = createCampaign(seed);
    saveCampaign(this.campaign);
    this.showCampaign();
  }

  private continueCampaign(): void {
    try {
      this.campaign = loadCampaign();
      if (!this.campaign) throw new Error('没有可继续的战役。');
      this.showCampaign();
    } catch (error) {
      alert((error as Error).message);
    }
  }

  private importCampaign(code: string): void {
    try {
      this.campaign = decodeCampaign(code);
      saveCampaign(this.campaign);
      this.showCampaign();
    } catch (error) {
      alert('战役导入失败：' + (error as Error).message);
    }
  }

  private showCampaign(): void {
    if (!this.campaign) return;
    this.menu.hide();
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'none';
    this.setupRoot.style.display = 'none';
    this.battleRoot.style.display = 'none';
    const root = this.root.querySelector('#campaign-root') as HTMLElement;
    root.style.display = 'block';
    this.sectorMap.render(this.campaign);
  }

  private campaignAction(action: CampaignAction): void {
    if (!this.campaign) return;
    this.campaign = applyCampaignAction(this.campaign, action);
    saveCampaign(this.campaign);
    this.showCampaign();
  }

  private resolveCampaignBattle(): void {
    if (!this.campaign?.pendingBattle) return;
    const pending = this.campaign.pendingBattle;
    const seed = deriveBattleSeed(
      this.campaign.campaignSeed,
      this.campaign.sectorIndex,
      pending.nodeId,
      pending.battleIndex
    );
    const enemy = enemyFleetFor(
      seed,
      this.campaign.sectorIndex,
      this.campaign.sector.threat.level,
      pending.reason === '星门守卫'
    );
    const context = prepareCampaignBattle(this.campaign.fleet, enemy, seed);
    this.beginWithReplay(context.replay, context);
  }

  private exportCampaign(): void {
    if (!this.campaign) return;
    const code = encodeCampaign(this.campaign);
    navigator.clipboard?.writeText(code);
    prompt('Campaign Code（已尝试复制）', code);
  }

  private exportCampaignLog(): void {
    if (!this.campaign) return;
    const blob = new Blob([encodeCampaignLog(this.campaign)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `spacewar-campaign-log-${this.campaign.campaignSeed}-s${this.campaign.sectorIndex}-t${this.campaign.turn}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

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
    } catch (error) {
      alert('录像导入失败：' + (error as Error).message);
    }
  }

  private beginWithReplay(replay: ReplayConfig, campaignContext?: CampaignBattleContext): void {
    this.replay = replay;
    this.fleetLibrary?.hide();
    this.analysisPanel?.hide();
    this.battleOrigin = campaignContext ? 'campaign' : 'single';
    this.campaignBattleContext = campaignContext ?? null;
    this.rng = campaignContext?.rng ?? createPRNG(replay.seed);
    this.state = campaignContext?.state ?? createInitialState(replay, this.rng);
    this.sim = createSimulator(replay, this.rng);
    this.running = true;
    this.paused = false;
    this.speed = 1;
    this.lastTime = performance.now();
    this.acc = 0;
    this.prev = new Map();
    this.winnerShown = false;
    this.showBattle();
    this.scene = new ThreeScene(this.canvasRoot, replay, this.state);
    this.scene.setViewFilters(this.viewPrefs);
    this.capturePrev();
    this.rafId = requestAnimationFrame((time) => this.frame(time));
  }

  private frame(time: number): void {
    if (!this.running || !this.state || !this.scene || !this.sim) return;
    const delta = Math.min(250, time - this.lastTime);
    this.lastTime = time;
    if (!this.paused) {
      this.acc += delta * this.speed;
      while (this.acc >= TICK_MS) {
        this.capturePrev();
        this.sim.step(this.state);
        this.acc -= TICK_MS;
      }
    }
    const alpha = Math.max(0, Math.min(1, this.acc / TICK_MS));
    this.scene.render(this.state, this.prev, alpha);
    this.hud.update(this.state, this.replay, this.paused, this.speed, this.autoCam);
    if (this.state.winner && !this.winnerShown) {
      this.winnerShown = true;
      if (this.battleOrigin === 'campaign' && this.campaign && this.campaignBattleContext) {
        this.campaign = applyCampaignBattleResult(
          this.campaign,
          this.state,
          this.campaignBattleContext.bindings
        );
        saveCampaign(this.campaign);
      }
    }
    this.rafId = requestAnimationFrame((next) => this.frame(next));
  }

  private capturePrev(): void {
    if (!this.state) return;
    this.prev = new Map(this.state.ships.map((ship) => [ship.id, { pos: { ...ship.pos }, rotY: ship.rotY }]));
  }

  private togglePause(): void {
    this.paused = !this.paused;
  }

  private toggleAuto(): void {
    this.autoCam = !this.autoCam;
    this.scene?.setAutoCam(this.autoCam);
  }

  private setViewFilter(key: keyof ViewFilters, value: boolean): void {
    this.viewPrefs = { ...this.viewPrefs, [key]: value };
    saveViewPrefs(this.viewPrefs);
    this.scene?.setViewFilters(this.viewPrefs);
  }

  private seek(tick: number): void {
    if (!this.replay || this.battleOrigin === 'campaign') return;
    const result = simulateFull(this.replay, tick);
    this.state = result.state;
    this.rng = result.rng;
    this.sim = createSimulator(this.replay, this.rng);
    this.acc = 0;
    this.capturePrev();
  }

  private exitBattle(): void {
    cancelAnimationFrame(this.rafId);
    this.running = false;
    this.scene?.dispose();
    this.scene = null;
    this.state = null;
    this.sim = null;
    this.rng = null;
    if (this.battleOrigin === 'campaign') {
      this.showCampaign();
    } else {
      this.showSetup();
    }
  }

  private startBalanceRun(config: BalanceRunConfig): void {
    this.cancelBalance();
    const run = () => {
      const result = runBalance(config);
      this.balanceLab.showResult(result);
    };
    setTimeout(run, 0);
  }

  private cancelBalance(): void {
    this.balanceWorker?.terminate();
    this.balanceWorker = null;
  }

  private exportBalance(result: BalanceResult, format: 'json' | 'csv'): void {
    const content = format === 'json'
      ? JSON.stringify(result, null, 2)
      : this.balanceToCsv(result);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `spacewar-balance.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  private balanceToCsv(result: BalanceResult): string {
    const rows = [['seed', 'winner', 'ticks', 'teamAHp', 'teamBHp']];
    for (const item of result.runs) {
      rows.push([
        String(item.seed),
        item.winner ?? 'draw',
        String(item.ticks),
        String(item.teamAHp),
        String(item.teamBHp)
      ]);
    }
    return rows.map((row) => row.join(',')).join('\n');
  }
}
