// 应用编排：连接配置面板、模拟器、渲染层与 HUD。
// 关键：模拟用固定 tick 推进（来自真实时间累加器，但每 tick 结果只取决于 seed）；
//   渲染在 prev/cur 之间插值，仅视觉，不影响结果。

import { createPRNG, PRNG } from './sim/prng';
import { createInitialState, createSimulator, SimContext, V4 } from './sim/rulesets';
import { encodeReplay, decodeReplay } from './sim/replayCodec';
import { SIM_VERSION_V5, TICK_MS } from './sim/battleConfig';
import { BattleState, BattleEvent, TeamConfig, ReplayConfig, Vec3, BudgetConfig } from './sim/battleTypes';
import type { ThreeScene, PosSnapshot } from './render/threeScene';
import BalanceWorker from './sim/balanceWorker?worker&inline';
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
import { encodeCampaignLog } from './campaign/campaignLog';
import { CampaignBattleContext, PersistentBattleContext, deriveBattleSeed, enemyFleetFor, prepareCampaignBattle, prepareStrategicBattle } from './campaign/fleet/battleAdapter';
import { defaultDeployment } from './campaign/deployment/deploymentSystem';
import { StrategicUniversePanel } from './ui/strategicUniversePanel';
import { generateUniverse } from './strategy/universeGenerator';
import {
  applyUniverseAction,
  applyStrategicBattleResult,
  ownedStrategicStations,
  strategicIncomeReport,
  strategicTransportStatus,
  toPersistentFleet
} from './strategy/universeRules';
import { decodeUniverse, encodeUniverse, loadUniverse, saveUniverse } from './strategy/universePersistence';
import type { UniverseAction, UniverseState } from './strategy/universeTypes';

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
  private strategyPanel!: StrategicUniversePanel;
  private campaign: CampaignState | null = null;
  private universe: UniverseState | null = null;
  private battleOrigin: 'single' | 'campaign' | 'strategy' = 'single';
  private battleContext: PersistentBattleContext | null = null;
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
  private battleLoadSequence = 0;
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
      <div id="strategy-root"></div>
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
    const strategyRoot = root.querySelector('#strategy-root') as HTMLElement;

    this.setupPanel = new SetupPanel(this.setupRoot, {
      onStart: (a, b, seed, budget) => this.startBattle(a, b, seed, budget),
      onImport: (code) => this.importReplay(code),
      onPreview: () => void this.previewPanel.show(),
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
      },
      onStrategicNew: (factionName) => this.startStrategicUniverse(Date.now() >>> 0, factionName),
      onStrategicContinue: () => this.continueStrategicUniverse(),
      onStrategicImport: (code) => this.importStrategicUniverse(code),
      hasStrategicSave: () => {
        try {
          return !!loadUniverse();
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
    this.strategyPanel = new StrategicUniversePanel(strategyRoot, {
      onAction: (action) => this.strategicAction(action),
      onExport: () => this.exportStrategicUniverse(),
      onExit: () => this.showMenu()
    });
  }

  start(): void {
    this.showMenu();
  }

  campaignDebugState(): unknown {
    if (this.universe) {
      return {
        screen: 'strategic-universe',
        sector: this.universe.sectorIndex,
        targetSectors: this.universe.targetSectorCount,
        turn: this.universe.turn,
        finalTurn: this.universe.crisis.finalTurn,
        status: this.universe.status,
        pressure: this.universe.crisis.pressure,
        selectedSystem: this.universe.selectedSystemId,
        fleetSystem: this.universe.fleet.systemId,
        fleet: {
          fuel: this.universe.fleet.fuel,
          maxFuel: this.universe.fleet.maxFuel,
          ships: this.universe.fleet.ships.map((ship) => ({
            id: ship.campaignShipId,
            shipClass: ship.shipClass,
            variant: ship.variant,
            disabled: ship.disabled,
            deployed: ship.deployed !== false
          }))
        },
        resources: this.universe.faction.resources,
        network: {
          mainBaseId: this.universe.faction.baseEntityId ?? null,
          income: strategicIncomeReport(this.universe).total,
          outposts: ownedStrategicStations(this.universe).map((station) => {
            const link = this.universe!.transportLinks.find((candidate) => candidate.outpostEntityId === station.id);
            return {
              id: station.id,
              name: station.name,
              systemId: station.systemId,
              main: station.id === this.universe!.faction.baseEntityId,
              facilities: station.facilities?.map((facility) => facility.type) ?? [],
              queue: station.constructionQueue?.map((order) => order.facilityType) ?? [],
              shipProductionQueue: station.shipProductionQueue?.map((order) => ({
                id: order.id,
                campaignShipId: order.campaignShipId,
                shipClass: order.shipClass,
                variant: order.variant,
                turnsRemaining: order.turnsRemaining,
                totalTurns: order.totalTurns
              })) ?? [],
              transport: link
                ? strategicTransportStatus(this.universe!, link)
                : station.id === this.universe!.faction.baseEntityId ? 'local' : 'missing',
              transportPath: link?.pathSystemIds ?? []
            };
          })
        },
        enemyOperations: {
          taskForces: this.universe.enemyTaskForces.map((force) => ({ ...force })),
          sieges: this.universe.sieges.map((siege) => ({ ...siege })),
          gateDefense: this.universe.extraction.gateDefense
        },
        extraction: {
          discovered: this.universe.extraction.discovered,
          calibration: this.universe.extraction.calibration,
          requiredCalibration: this.universe.extraction.requiredCalibration,
          gateDefense: this.universe.extraction.gateDefense
        },
        commander: {
          id: this.universe.commander.id,
          name: this.universe.commander.name,
          level: this.universe.commander.level,
          alive: this.universe.commander.alive,
          conditions: this.universe.commander.conditions ?? [],
          injuries: this.universe.commander.injuries ?? [],
          reserves: this.universe.reserveCommanders.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            level: candidate.level,
            alive: candidate.alive
          })),
          reserveCount: this.universe.reserveCommanders.length,
          pendingSuccession: this.universe.pendingSuccession,
          pendingRecruitment: this.universe.pendingRecruitment
            ? {
                supplyCost: this.universe.pendingRecruitment.supplyCost,
                candidates: this.universe.pendingRecruitment.candidates.map((candidate) => ({
                  id: candidate.id,
                  name: candidate.name
                }))
              }
            : null,
          recruitmentUsedThisSector: this.universe.recruitmentUsedThisSector
        }
      };
    }
    return this.campaign
      ? {
          sector: this.campaign.sectorIndex,
          turn: this.campaign.turn,
          node: this.campaign.sector.currentNodeId,
          threat: this.campaign.sector.threat,
          resources: this.campaign.resources,
          pendingBattle: this.campaign.pendingBattle,
          status: this.campaign.status
        }
      : { screen: 'menu' };
  }

  private showMenu(): void {
    this.setupRoot.style.display = 'none';
    this.battleRoot.style.display = 'none';
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#strategy-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'block';
    this.menu.show();
  }

  private showSetup(): void {
    this.menu.hide();
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#strategy-root') as HTMLElement).style.display = 'none';
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
    (this.root.querySelector('#strategy-root') as HTMLElement).style.display = 'none';
    this.battleRoot.style.display = 'block';
    this.setupPanel.hide();
    this.hud.show();
  }

  private startCampaign(seed: number): void {
    this.universe = null;
    this.campaign = createCampaign(seed);
    saveCampaign(this.campaign);
    this.showCampaign();
  }

  private continueCampaign(): void {
    try {
      this.universe = null;
      this.campaign = loadCampaign();
      if (!this.campaign) throw new Error('没有可继续的战役。');
      this.showCampaign();
    } catch (error) {
      alert((error as Error).message);
    }
  }

  private importCampaign(code: string): void {
    try {
      this.universe = null;
      this.campaign = decodeCampaign(code);
      saveCampaign(this.campaign);
      this.showCampaign();
    } catch (error) {
      alert('战役导入失败：' + (error as Error).message);
    }
  }

  private showCampaign(): void {
    if (!this.campaign) return;
    this.universe = null;
    this.menu.hide();
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'none';
    this.setupRoot.style.display = 'none';
    this.battleRoot.style.display = 'none';
    const root = this.root.querySelector('#campaign-root') as HTMLElement;
    (this.root.querySelector('#strategy-root') as HTMLElement).style.display = 'none';
    root.style.display = 'block';
    this.sectorMap.render(this.campaign);
  }

  private campaignAction(action: CampaignAction): void {
    if (!this.campaign) return;
    this.campaign = applyCampaignAction(this.campaign, action);
    saveCampaign(this.campaign);
    this.showCampaign();
  }

  private startStrategicUniverse(seed: number, factionName: string): void {
    this.campaign = null;
    this.universe = generateUniverse(seed, factionName);
    saveUniverse(this.universe);
    this.showStrategicUniverse();
  }

  private continueStrategicUniverse(): void {
    try {
      this.campaign = null;
      this.universe = loadUniverse();
      if (!this.universe) throw new Error('没有可继续的战略宇宙。');
      this.showStrategicUniverse();
    } catch (error) {
      alert((error as Error).message);
    }
  }

  private importStrategicUniverse(code: string): void {
    try {
      this.campaign = null;
      this.universe = decodeUniverse(code);
      saveUniverse(this.universe);
      this.showStrategicUniverse();
    } catch (error) {
      alert('战略宇宙导入失败：' + (error as Error).message);
    }
  }

  private showStrategicUniverse(): void {
    if (!this.universe) return;
    this.menu.hide();
    (this.root.querySelector('#menu-root') as HTMLElement).style.display = 'none';
    (this.root.querySelector('#campaign-root') as HTMLElement).style.display = 'none';
    this.setupRoot.style.display = 'none';
    this.battleRoot.style.display = 'none';
    const root = this.root.querySelector('#strategy-root') as HTMLElement;
    root.style.display = 'block';
    this.strategyPanel.render(this.universe);
  }

  private strategicAction(action: UniverseAction): void {
    if (!this.universe) return;
    const wasInBattle = this.battleOrigin === 'strategy';
    const pendingBefore = this.universe.pendingBattle?.battleId;
    this.universe = applyUniverseAction(this.universe, action);
    saveUniverse(this.universe);
    // 主动攻击、继续战斗，或星门校准自动触发的新防御战，都复用同一真实 core-v4 场景。
    if (
      this.universe.pendingBattle && !wasInBattle &&
      (action.type === 'engageEnemy' || this.universe.pendingBattle.battleId !== pendingBefore)
    ) {
      this.launchStrategicBattle(this.universe);
      return;
    }
    this.showStrategicUniverse();
  }

  private exportStrategicUniverse(): void {
    if (!this.universe) return;
    const code = encodeUniverse(this.universe);
    navigator.clipboard?.writeText(code);
    prompt('Strategic Universe Code（已尝试复制）', code);
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

  private beginWithReplay(replay: ReplayConfig, context?: PersistentBattleContext): void {
    const sequence = ++this.battleLoadSequence;
    void import('./render/threeScene')
      .then(({ ThreeScene }) => {
        if (sequence !== this.battleLoadSequence) return;
        this.beginWithLoadedRenderer(replay, context, ThreeScene);
      })
      .catch((error: unknown) => {
        if (sequence !== this.battleLoadSequence) return;
        console.error('[battle] 战斗渲染器加载失败：', error);
        alert('战斗界面加载失败：' + (error instanceof Error ? error.message : String(error)));
      });
  }

  private beginWithLoadedRenderer(
    replay: ReplayConfig,
    context: PersistentBattleContext | undefined,
    Scene: typeof import('./render/threeScene').ThreeScene
  ): void {
    this.replay = replay;
    // 关闭可能仍打开的配置期覆盖层（舰队库 / 战前分析），避免盖住战斗画面
    this.fleetLibrary?.hide();
    this.analysisPanel?.hide();
    this.battleOrigin = context ? context.origin : 'single';
    this.battleContext = context ?? null;
    this.rng = context?.rng ?? createPRNG(replay.seed);
    this.state = context?.state ?? createInitialState(replay, this.rng);
    this.sim = createSimulator(this.state, this.rng);

    if (!this.scene) {
      this.scene = new Scene(this.canvasRoot);
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
    this.configureBattleControls(this.battleOrigin);
    this.hud.update(this.state);

    // 单场战斗可从 Replay 确定性重模拟时间线；战役战斗包含额外的继承损伤，暂不重建。
    this.generateTimeline();

    this.running = true;
    this.acc = 0;
    this.lastTime = performance.now();
    this.prev = snapshot(this.state);
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);
  }

  private configureBattleControls(origin: 'single' | 'campaign' | 'strategy'): void {
    const persistent = origin === 'campaign' || origin === 'strategy';
    const seek = this.hudRoot.querySelector('#hudSeek') as HTMLInputElement | null;
    const timeline = this.hudRoot.querySelector('#hudTimeline') as HTMLElement | null;
    const share = this.hudRoot.querySelector('#hudShare') as HTMLButtonElement | null;
    const back = this.hudRoot.querySelector('#hudBack') as HTMLButtonElement | null;
    const exit = this.hudRoot.querySelector('#hudExit') as HTMLButtonElement | null;
    const reason = '战役 / 战略战斗包含跨战斗继承损伤，暂不支持进度跳转或分享 Replay。';

    if (seek) {
      seek.disabled = persistent;
      seek.title = persistent ? reason : '';
    }
    if (timeline) {
      timeline.style.pointerEvents = persistent ? 'none' : '';
      timeline.title = persistent ? reason : '';
    }
    if (share) share.style.display = persistent ? 'none' : '';
    if (back) back.textContent = origin === 'strategy' ? '返回战略星图' : persistent ? '返回星域' : '返回设置';
    if (exit) exit.textContent = origin === 'strategy' ? '返回战略星图' : persistent ? '返回星域' : '返回设置';
  }

  /** 单场战斗由 replay 生成时间线。战役 / 战略战斗的继承 HP 不在 ReplayConfig 中，因此禁用重模拟。 */
  private generateTimeline(): void {
    if (!this.replay || !this.state) return;
    if (this.battleOrigin === 'campaign' || this.battleOrigin === 'strategy') {
      this.hud.setTimeline([], this.state.maxTicks);
      return;
    }
    try {
      const events = simulateFull(this.replay);
      const markers = buildTimeline(events);
      this.hud.setTimeline(markers, this.state.maxTicks);
    } catch (error) {
      // 时间线生成失败不应阻断战斗播放
      console.warn('[timeline] 生成失败：', error);
    }
  }

  /** 进度条跳转仅用于普通 Replay；战役 / 战略战斗禁用以保持继承损伤和 binding。 */
  private seek(targetTick: number): void {
    if (this.battleOrigin === 'campaign' || this.battleOrigin === 'strategy') return;
    if (!this.replay || !this.scene) return;
    this.rng = createPRNG(this.replay.seed);
    this.state = createInitialState(this.replay, this.rng);
    this.sim = createSimulator(this.state, this.rng);

    const target = Math.max(0, Math.min(targetTick, this.state.maxTicks));
    let guard = 0;
    while (
      this.state.tick < target &&
      !this.state.finished &&
      guard < this.state.maxTicks + 5
    ) {
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
        const result = this.sim.step();
        for (const event of result.events) frameEvents.push(event);
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
      if (this.battleOrigin === 'campaign' || this.battleOrigin === 'strategy') {
        setTimeout(() => this.completePersistentBattle(), 800);
      }
    }

    if (this.running) {
      this.rafId = requestAnimationFrame(this.frame);
    }
  };

  private exitBattle(): void {
    if (this.battleOrigin === 'campaign' || this.battleOrigin === 'strategy') {
      if (!this.state?.finished) {
        alert(this.battleOrigin === 'strategy' ? '战略战斗必须完成后才能返回星图。' : '战役战斗必须完成后才能返回星域地图。');
        return;
      }
      this.completePersistentBattle();
      return;
    }
    this.exitToSetup();
  }

  private completePersistentBattle(): void {
    if (this.battleOrigin === 'campaign') this.completeCampaignBattle();
    else if (this.battleOrigin === 'strategy') this.completeStrategicBattle();
  }

  private completeCampaignBattle(): void {
    if (
      this.battleOrigin !== 'campaign' ||
      !this.campaign ||
      !this.state?.finished ||
      !this.battleContext
    ) {
      return;
    }
    this.campaign = applyCampaignBattleResult(
      this.campaign,
      this.state,
      this.battleContext.bindings
    );
    saveCampaign(this.campaign);
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.scene?.dispose();
    this.scene = null;
    this.sim = null;
    this.state = null;
    this.rng = null;
    this.battleContext = null;
    this.battleOrigin = 'single';
    this.showCampaign();
  }

  private launchStrategicBattle(state: UniverseState): void {
    if (!state.pendingBattle) return;
    const persistentFleet = toPersistentFleet(state.fleet);
    const deployment = state.pendingBattle.deployment ?? defaultDeployment(persistentFleet);
    const context = prepareStrategicBattle(persistentFleet, state.pendingBattle.enemyFleet, state.pendingBattle.battleSeed, deployment);
    this.beginWithReplay(context.replay, context);
  }

  private completeStrategicBattle(): void {
    if (
      this.battleOrigin !== 'strategy' ||
      !this.universe ||
      !this.state?.finished ||
      !this.battleContext
    ) {
      return;
    }
    this.universe = applyStrategicBattleResult(
      this.universe,
      this.state,
      this.battleContext.bindings
    );
    saveUniverse(this.universe);
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.scene?.dispose();
    this.scene = null;
    this.sim = null;
    this.state = null;
    this.rng = null;
    this.battleContext = null;
    this.battleOrigin = 'single';
    this.showStrategicUniverse();
  }

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
      worker = new BalanceWorker();
    } catch {
      worker = null;
    }
    if (worker) {
      this.balanceWorker = worker;
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data;
        if (message.type === 'progress') {
          this.balanceLab.setProgress(message.done, message.total);
        } else if (message.type === 'done') {
          this.balanceLab.showResult(message.result as BalanceResult);
          this.balanceWorker = null;
        }
      };
      worker.onerror = () => {
        // 静态单文件构建等环境可能缺少 worker 分块，回退到主线程（结果一致）
        console.warn('[balance] Worker 不可用，回退主线程运行');
        this.balanceWorker = null;
        const result = runBalance(cfg, (done, total) =>
          this.balanceLab.setProgress(done, total)
        );
        this.balanceLab.showResult(result);
      };
      worker.postMessage({ type: 'run', config: cfg });
    } else {
      const result = runBalance(cfg, (done, total) =>
        this.balanceLab.setProgress(done, total)
      );
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
    const seeds = result.runsList.map((run) => run.seed);
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
        (run) =>
          `${run.seed},${run.winner ?? 'draw'},${run.ticks},${run.teamARemaining},${run.teamBRemaining},${run.teamADamage},${run.teamBDamage}`
      );
      const fleetValue = result.fleetValue;
      const average = (value: number) => Math.round(value / Math.max(1, result.runs));
      const reasons = Object.entries(result.victoryReasons)
        .map(([key, value]) => `${key}:${value}`)
        .join(' ');
      const outcome = result.outcome;
      const summary = [
        '',
        `# 汇总（core-v4 价值口径；operational=仍在场且具战斗力，decision=点数判定价值）`,
        `# 平均作战价值 A,${average(fleetValue.A.remainingOperationalValue)},B,${average(fleetValue.B.remainingOperationalValue)}`,
        `# 平均判定价值 A,${average(fleetValue.A.remainingDecisionValue)},B,${average(fleetValue.B.remainingDecisionValue)}`,
        `# 初始成本 A,${average(fleetValue.A.initialFleetCost)},B,${average(fleetValue.B.initialFleetCost)}`,
        `# 损毁 A,${outcome.destroyed.A},B,${outcome.destroyed.B} | 失能 A,${outcome.disabled.A},B,${outcome.disabled.B} | 脱战 A,${outcome.escaped.A},B,${outcome.escaped.B}`,
        `# 结束原因 ${reasons}`
      ];
      downloadFile(`${base}.csv`, [header, ...rows, ...summary].join('\n'), 'text/csv');
    }
  }
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function snapshot(state: BattleState): Map<number, PosSnapshot> {
  const snapshots = new Map<number, PosSnapshot>();
  for (const ship of state.ships) {
    const pos: Vec3 = { ...ship.pos };
    snapshots.set(ship.id, { pos, heading: ship.heading });
  }
  return snapshots;
}
