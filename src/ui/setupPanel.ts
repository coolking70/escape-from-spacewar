// 初始配置面板：舰队构筑、阵型、战术、随机种子、开始战斗与导入录像。
// 只负责收集输入并回调，绝不参与战斗逻辑。

import {
  FleetEntry,
  TeamConfig,
  FormationType,
  DoctrineType,
  BudgetConfig,
  ShipClass,
  ShipVariant
} from '../sim/battleTypes';
import { SIM_VERSION, DEFAULT_BUDGET_LIMIT } from '../sim/battleConfig';
import {
  VARIANTS_BY_CLASS,
  VARIANT_CN,
  VARIANTS,
  fleetCost,
  SHIP_CN
} from '../sim/shipVariants';
import { assertValidFleet } from '../sim/fleetValidator';

export interface SetupCallbacks {
  onStart: (teamA: TeamConfig, teamB: TeamConfig, seed: number, budget: BudgetConfig) => void;
  onImport: (code: string) => void;
  onPreview: () => void;
  onOpenBalance: () => void;
  onOpenFleet: () => void;
  onOpenAnalysis: () => void;
}

const FORMATION_OPTS: { value: FormationType; label: string; desc: string }[] = [
  { value: 'line', label: '横列阵', desc: '横向展开' },
  { value: 'wedge', label: '楔形阵', desc: '小船在前、主力在后' },
  { value: 'wall', label: '防御墙', desc: '重型居中、小船护侧' },
  { value: 'swarm', label: '蜂群阵', desc: '分散更广，适合 Fighter 多' },
  { value: 'random', label: '随机阵', desc: '基于种子的确定性散布' }
];

const DOCTRINE_OPTS: { value: DoctrineType; label: string; desc: string }[] = [
  { value: 'balanced', label: '均衡', desc: '默认行为' },
  { value: 'aggressive', label: '积极', desc: '压上、集火残血' },
  { value: 'defensive', label: '防御', desc: '保持距离、护重' },
  { value: 'kite', label: '拉扯', desc: '保持最大射程' },
  { value: 'focusFire', label: '集火', desc: '同队集火同一目标' },
  { value: 'antiCapital', label: '反大舰', desc: '优先 Cruiser→Frigate→Fighter' },
  { value: 'screen', label: '拦截', desc: '小船拦 Fighter、护大型舰' }
];

// 默认 1000 点预算下的快速预设（点击仅修改对应队伍）
export const PRESETS: { name: string; build: () => FleetEntry[] }[] = [
  {
    name: '均衡舰队',
    build: () => [
      { shipClass: 'Fighter', variant: 'standard', count: 5 },
      { shipClass: 'Frigate', variant: 'standard', count: 2 },
      { shipClass: 'Cruiser', variant: 'standard', count: 1 }
    ]
  },
  {
    name: '舰载机海',
    build: () => [
      { shipClass: 'Fighter', variant: 'interceptor', count: 6 },
      { shipClass: 'Frigate', variant: 'escort', count: 1 },
      { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
    ]
  },
  {
    name: '炮击舰队',
    build: () => [
      { shipClass: 'Frigate', variant: 'artillery', count: 2 },
      { shipClass: 'Cruiser', variant: 'battleship', count: 1 },
      { shipClass: 'Fighter', variant: 'scout', count: 1 }
    ]
  },
  {
    name: '堡垒防线',
    build: () => [
      { shipClass: 'Cruiser', variant: 'fortress', count: 1 },
      { shipClass: 'Frigate', variant: 'support', count: 1 },
      { shipClass: 'Frigate', variant: 'escort', count: 1 },
      { shipClass: 'Fighter', variant: 'interceptor', count: 3 }
    ]
  },
  {
    name: '反大型舰队',
    build: () => [
      { shipClass: 'Fighter', variant: 'bomber', count: 6 },
      { shipClass: 'Frigate', variant: 'escort', count: 2 },
      { shipClass: 'Fighter', variant: 'scout', count: 1 }
    ]
  }
];

export class SetupPanel {
  private root: HTMLElement;
  private cb: SetupCallbacks;
  private fleets: { a: FleetEntry[]; b: FleetEntry[] } = {
    a: [
      { shipClass: 'Fighter', variant: 'standard', count: 3 },
      { shipClass: 'Frigate', variant: 'standard', count: 1 }
    ],
    b: [
      { shipClass: 'Fighter', variant: 'standard', count: 3 },
      { shipClass: 'Frigate', variant: 'standard', count: 1 }
    ]
  };
  private unlimited = false;
  private limit = DEFAULT_BUDGET_LIMIT;

  constructor(root: HTMLElement, cb: SetupCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  private render(): void {
    const formationHtml = FORMATION_OPTS.map(
      (o) => `<option value="${o.value}">${o.label}（${o.desc}）</option>`
    ).join('');
    const doctrineHtml = DOCTRINE_OPTS.map(
      (o) => `<option value="${o.value}">${o.label}（${o.desc}）</option>`
    ).join('');
    const presetHtml = PRESETS.map(
      (p, i) => `<button class="btn preset" data-preset="${i}">${p.name}</button>`
    ).join('');

    this.root.innerHTML = `
      <div class="setup-card">
        <h1>SpaceWar · 3D 太空战斗模拟</h1>
        <div class="sub">确定性自动战斗 · 可分享录像 (版本 ${SIM_VERSION}) · 舰队点数构筑</div>

        <div class="budget-bar">
          <label class="budget-toggle"><input type="checkbox" id="unlimitedChk" /> 无限预算（测试模式）</label>
          <span class="budget-limit">单队预算：${this.limit} 点</span>
          <button class="btn" id="previewBtn">战舰图鉴</button>
          <button class="btn" id="analysisBtn">战前分析</button>
          <button class="btn" id="fleetBtn">舰队库</button>
          <button class="btn" id="balanceBtn">平衡实验室</button>
          <span class="sep-dot"></span>
          <button class="btn" id="importToggle">导入记录</button>
        </div>

        <div class="fleet-grid">
          ${this.fleetColHtml('a', '舰队 A（青色）', 'accent-a', formationHtml, doctrineHtml, 'A')}
          ${this.fleetColHtml('b', '舰队 B（品红）', 'accent-b', formationHtml, doctrineHtml, 'B')}
        </div>

        <div class="preset-row">
          <span class="preset-label">快速预设：</span>
          <select id="presetTeam" class="cfg-select">
            <option value="a">应用到舰队 A</option>
            <option value="b">应用到舰队 B</option>
          </select>
          ${presetHtml}
        </div>

        <div class="seed-row">
          <label>随机种子：</label>
          <input id="seedInput" type="text" value="123456" />
          <button class="btn" id="genSeed">生成随机种子</button>
        </div>

        <div class="actions">
          <button class="btn primary" id="startBtn">开始战斗</button>
          <div class="spacer"></div>
          <div id="startHint" class="start-hint"></div>
        </div>

        <div class="import-box" id="importBox" style="display:none">
          <textarea id="importCode" placeholder="在此粘贴 replay code，然后点击导入并播放"></textarea>
          <div class="actions" style="margin-top:8px">
            <button class="btn accent-a" id="importBtn">导入并播放</button>
            <div class="hint">导入后将以该录像的 seed 与舰队配置复现同一场战斗（仅支持 v0.5 录像）。</div>
          </div>
        </div>
      </div>
    `;

    const $ = (id: string) => this.root.querySelector('#' + id) as HTMLElement;

    ($('genSeed') as HTMLButtonElement).addEventListener('click', () => {
      const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
      (this.root.querySelector('#seedInput') as HTMLInputElement).value = String(seed);
    });

    ($('importToggle') as HTMLButtonElement).addEventListener('click', () => {
      const box = this.root.querySelector('#importBox') as HTMLElement;
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });

    ($('previewBtn') as HTMLButtonElement).addEventListener('click', () => this.cb.onPreview());

    ($('balanceBtn') as HTMLButtonElement).addEventListener('click', () => this.cb.onOpenBalance());

    ($('fleetBtn') as HTMLButtonElement).addEventListener('click', () => this.cb.onOpenFleet());

    ($('analysisBtn') as HTMLButtonElement).addEventListener('click', () => this.cb.onOpenAnalysis());

    ($('unlimitedChk') as HTMLInputElement).addEventListener('change', (e) => {
      this.unlimited = (e.target as HTMLInputElement).checked;
      this.refreshBudget();
    });

    ($('startBtn') as HTMLButtonElement).addEventListener('click', () => this.tryStart());

    ($('importBtn') as HTMLButtonElement).addEventListener('click', () => {
      const code = (this.root.querySelector('#importCode') as HTMLTextAreaElement).value;
      this.cb.onImport(code);
    });

    this.root.querySelectorAll('button.preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number((btn as HTMLElement).dataset.preset);
        const preset = PRESETS[i];
        if (!preset) return;
        const teamSel = this.root.querySelector('#presetTeam') as HTMLSelectElement | null;
        const team = (teamSel ? teamSel.value : 'a') as 'a' | 'b';
        const fleet = preset.build();
        assertValidFleet(fleet);
        this.fleets[team] = fleet;
        this.renderFleetColumn(team);
        this.refreshBudget();
      });
    });

    // 渲染双方舰队行
    this.renderFleetColumn('a');
    this.renderFleetColumn('b');
    this.refreshBudget();
  }

  private fleetColHtml(
    prefix: string,
    title: string,
    accent: string,
    formationHtml: string,
    doctrineHtml: string,
    teamUpper: string
  ): string {
    const teamLower = prefix;
    return `
      <div class="fleet-col ${prefix}" data-team="${teamUpper}">
        <h2>${title}</h2>
        <div class="budget-info" id="budget-${teamLower}"></div>
        <div class="fleet-rows" id="fleetRows-${teamLower}"></div>
        <div class="fleet-actions">
          <button class="btn small" id="add-${teamLower}">+ 添加编队项</button>
          <button class="btn small" id="clear-${teamLower}">清空</button>
        </div>
        <div class="cfg-row">
          <label>阵型</label>
          <select id="${prefix}Formation" class="cfg-select ${accent}">${formationHtml}</select>
        </div>
        <div class="cfg-row">
          <label>战术倾向</label>
          <select id="${prefix}Doctrine" class="cfg-select ${accent}">${doctrineHtml}</select>
        </div>
      </div>
    `;
  }

  /** 渲染某队的舰队行（结构性变化时调用） */
  private renderFleetColumn(team: 'a' | 'b'): void {
    const container = this.root.querySelector('#fleetRows-' + team) as HTMLElement;
    if (!container) return;
    container.innerHTML = this.fleets[team].map((e, idx) => this.rowHtml(team, e, idx)).join('');

    // 增删按钮
    (this.root.querySelector('#add-' + team) as HTMLButtonElement).onclick = () => {
      this.fleets[team].push({ shipClass: 'Fighter', variant: 'standard', count: 1 });
      this.renderFleetColumn(team);
      this.refreshBudget();
    };
    (this.root.querySelector('#clear-' + team) as HTMLButtonElement).onclick = () => {
      this.fleets[team] = [];
      this.renderFleetColumn(team);
      this.refreshBudget();
    };

    // 每行事件绑定
    this.fleets[team].forEach((_e, idx) => {
      const row = container.querySelector(`[data-idx="${idx}"]`) as HTMLElement;
      if (!row) return;
      const classSel = row.querySelector('.fe-class') as HTMLSelectElement;
      const variantSel = row.querySelector('.fe-variant') as HTMLSelectElement;
      const countInp = row.querySelector('.fe-count') as HTMLInputElement;
      const delBtn = row.querySelector('.fe-del') as HTMLButtonElement;

      classSel.onchange = () => {
        this.fleets[team][idx].shipClass = classSel.value as ShipClass;
        this.fleets[team][idx].variant = 'standard';
        // 重建整列以刷新 variant 下拉
        this.renderFleetColumn(team);
        this.refreshBudget();
      };
      variantSel.onchange = () => {
        this.fleets[team][idx].variant = variantSel.value as ShipVariant;
        this.updateRowCost(team, idx);
        this.refreshBudget();
      };
      countInp.oninput = () => {
        const n = Math.max(0, Math.floor(Number(countInp.value) || 0));
        this.fleets[team][idx].count = n;
        this.updateRowCost(team, idx);
        this.refreshBudget();
      };
      delBtn.onclick = () => {
        this.fleets[team].splice(idx, 1);
        this.renderFleetColumn(team);
        this.refreshBudget();
      };
    });
  }

  private rowHtml(team: 'a' | 'b', e: FleetEntry, idx: number): string {
    const classOpts = (['Fighter', 'Frigate', 'Cruiser'] as ShipClass[])
      .map(
        (c) =>
          `<option value="${c}" ${c === e.shipClass ? 'selected' : ''}>${SHIP_CN[c]}</option>`
      )
      .join('');
    const variantOpts = VARIANTS_BY_CLASS[e.shipClass]
      .map(
        (v) =>
          `<option value="${v}" ${v === e.variant ? 'selected' : ''}>${VARIANT_CN[v]}</option>`
      )
      .join('');
    const cost = VARIANTS[e.variant].cost;
    const sub = cost * Math.max(0, Math.floor(e.count || 0));
    return `
      <div class="fleet-entry" data-idx="${idx}">
        <select class="fe-class">${classOpts}</select>
        <select class="fe-variant">${variantOpts}</select>
        <input class="fe-count" type="number" min="0" value="${e.count}" />
        <span class="fe-cost">${cost}</span>
        <span class="fe-sub">${sub}</span>
        <button class="fe-del" title="删除">×</button>
      </div>`;
  }

  /** 仅更新某行的单价/小计显示（不重建 DOM，避免输入失焦） */
  private updateRowCost(team: 'a' | 'b', idx: number): void {
    const container = this.root.querySelector('#fleetRows-' + team) as HTMLElement;
    const row = container.querySelector(`[data-idx="${idx}"]`) as HTMLElement;
    if (!row) return;
    const e = this.fleets[team][idx];
    const cost = VARIANTS[e.variant].cost;
    const sub = cost * Math.max(0, Math.floor(e.count || 0));
    (row.querySelector('.fe-cost') as HTMLElement).textContent = String(cost);
    (row.querySelector('.fe-sub') as HTMLElement).textContent = String(sub);
  }

  /** 刷新点数预算显示 + 开始按钮可用性 */
  private refreshBudget(): void {
    const usedA = fleetCost(this.fleets.a);
    const usedB = fleetCost(this.fleets.b);
    const infoA = this.root.querySelector('#budget-a') as HTMLElement;
    const infoB = this.root.querySelector('#budget-b') as HTMLElement;
    if (infoA) infoA.innerHTML = this.budgetText(usedA);
    if (infoB) infoB.innerHTML = this.budgetText(usedB);

    const overA = !this.unlimited && usedA > this.limit;
    const overB = !this.unlimited && usedB > this.limit;
    infoA?.classList.toggle('over', overA);
    infoB?.classList.toggle('over', overB);

    const totalA = this.fleets.a.reduce((s, e) => s + Math.max(0, Math.floor(e.count || 0)), 0);
    const totalB = this.fleets.b.reduce((s, e) => s + Math.max(0, Math.floor(e.count || 0)), 0);
    const empty = totalA === 0 || totalB === 0;

    const startBtn = this.root.querySelector('#startBtn') as HTMLButtonElement;
    const hint = this.root.querySelector('#startHint') as HTMLElement;
    if (empty) {
      startBtn.disabled = true;
      hint.textContent = '双方舰队都不能为空。';
      hint.className = 'start-hint bad';
    } else if (overA || overB) {
      startBtn.disabled = true;
      const who = overA && overB ? '双方' : overA ? '舰队 A' : '舰队 B';
      hint.textContent = `${who}超出预算，无法开始战斗（开启无限预算可测试）。`;
      hint.className = 'start-hint bad';
    } else {
      startBtn.disabled = false;
      hint.textContent = this.unlimited ? '无限预算模式：可开始。' : '配置有效，可开始战斗。';
      hint.className = 'start-hint ok';
    }
  }

  private budgetText(used: number): string {
    if (this.unlimited) return `已用 <b>${used}</b> / 无限`;
    const over = used > this.limit;
    const diff = used - this.limit;
    const main = `已用 <b>${used}</b> / ${this.limit}`;
    return over ? `${main} · <span class="over-text">超出 ${diff} 点</span>` : main;
  }

  private tryStart(): void {
    const a = this.readTeam('a');
    const b = this.readTeam('b');
    const seedRaw = (this.root.querySelector('#seedInput') as HTMLInputElement).value.trim();
    const seed = (seedRaw === '' ? 123456 : Number(seedRaw)) >>> 0;
    const budget: BudgetConfig = {
      mode: this.unlimited ? 'unlimited' : 'limited',
      limit: this.limit
    };
    try {
      assertValidFleet(a.fleet);
      assertValidFleet(b.fleet);
      this.cb.onStart(a, b, seed, budget);
    } catch (e) {
      const hint = this.root.querySelector('#startHint') as HTMLElement;
      hint.textContent = (e as Error).message;
      hint.className = 'start-hint bad';
    }
  }

  private readTeam(prefix: 'a' | 'b'): TeamConfig {
    const formation = (this.root.querySelector('#' + prefix + 'Formation') as HTMLSelectElement)
      .value as FormationType;
    const doctrine = (this.root.querySelector('#' + prefix + 'Doctrine') as HTMLSelectElement)
      .value as DoctrineType;
    const fleet = this.fleets[prefix]
      .map((e) => ({
        shipClass: e.shipClass,
        variant: e.variant,
        count: Math.max(0, Math.floor(e.count || 0))
      }))
      .filter((e) => e.count > 0);
    assertValidFleet(fleet);
    return { fleet, formation, doctrine };
  }

  /** 供平衡实验室读取当前双方编队（含阵型/战术） */
  getTeamConfigs(): { teamA: TeamConfig; teamB: TeamConfig } {
    return { teamA: this.readTeam('a'), teamB: this.readTeam('b') };
  }

  /** 将一支舰队方案应用到指定队伍（舰队库载入/快速预设复用） */
  applyPresetToTeam(
    prefix: 'a' | 'b',
    fleet: FleetEntry[],
    formation: FormationType,
    doctrine: DoctrineType
  ): void {
    assertValidFleet(fleet);
    this.fleets[prefix] = fleet.map((e) => ({ ...e }));
    (this.root.querySelector('#' + prefix + 'Formation') as HTMLSelectElement).value = formation;
    (this.root.querySelector('#' + prefix + 'Doctrine') as HTMLSelectElement).value = doctrine;
    this.renderFleetColumn(prefix);
    this.refreshBudget();
  }

  show(): void {
    this.root.style.display = 'flex';
  }
  hide(): void {
    this.root.style.display = 'none';
  }
}
