// 战舰预览面板：覆盖层 UI，提供分舰种 / 分阵营 / 分改型单独查看飞船模型的能力。
// V0.4：升级为"改型图鉴"——每个改型一张卡片，含名称/成本/定位/优势/劣势/
//   推荐阵型/战术/武器说明/组件说明/数值条；3D 预览随舰种+改型切换。
// 只负责 DOM 与交互，3D 渲染委托给 render/shipPreview.ts。

import { ShipTypeName, ShipClass, ShipVariant, Team, ComponentTypeName } from '../sim/battleTypes';
import { SHIP_DEFS } from '../sim/shipFactory';
import { ShipPreview } from '../render/shipPreview';
import {
  SHIP_CN,
  VARIANT_CN,
  VARIANTS_BY_CLASS,
  getVariantDef
} from '../sim/shipVariants';

const SHIP_DESC: Record<ShipTypeName, string> = {
  Fighter: '小型、尖锐、速度感强的箭头形战机，适合快速突袭与拦截。',
  Frigate: '中型细长舰，主炮 + 左右舷炮塔，攻守均衡，适合护航与侧翼。',
  Cruiser: '大型主力舰，厚重分层装甲、多炮塔（含近全向顶部炮塔）、三引擎阵列。'
};

const SHIP_ROLE: Record<ShipTypeName, string> = {
  Fighter: '定位：高速突击 / 拦截 / 骚扰',
  Frigate: '定位：中坚火力 / 护航 / 侧翼压制',
  Cruiser: '定位：核心输出 / 正面主力 / 扛线'
};

const COMP_LABEL: Record<ComponentTypeName, string> = {
  core: '核心',
  engine: '引擎',
  weapon: '武器',
  sensor: '传感器',
  shield: '护盾',
  armor: '装甲'
};

const ARC_LABEL: Record<string, string> = {
  front: '前射',
  broadside: '侧舷',
  turret: '全向炮塔',
  rear: '后射'
};

const SHIP_LABEL: Record<ShipTypeName, string> = {
  Fighter: 'Fighter 战斗机',
  Frigate: 'Frigate 护卫舰',
  Cruiser: 'Cruiser 巡洋舰'
};

export class ShipPreviewPanel {
  private root: HTMLElement;
  private overlay: HTMLElement;
  private canvasEl: HTMLElement;
  private infoEl: HTMLElement;
  private preview: ShipPreview;

  private curType: ShipTypeName = 'Fighter';
  private curTeam: Team = 'A';
  private curVariant: ShipVariant = 'standard';

  constructor(root: HTMLElement) {
    this.root = root;
    this.overlay = this.buildDom();
    this.root.appendChild(this.overlay);

    this.canvasEl = this.overlay.querySelector('#previewCanvas') as HTMLElement;
    this.infoEl = this.overlay.querySelector('#previewInfo') as HTMLElement;
    this.preview = new ShipPreview(this.canvasEl);

    this.bindTabs();
    this.renderVariantTabs();
    this.renderInfo();
  }

  private buildDom(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'preview-overlay';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="preview-card">
        <div class="preview-head">
          <h2>战舰图鉴</h2>
          <button class="btn" id="previewClose">关闭</button>
        </div>
        <div class="preview-body">
          <div class="preview-canvas" id="previewCanvas"></div>
          <div class="preview-side">
            <div class="preview-group">
              <div class="preview-label">舰体类别</div>
              <div class="preview-tabs" id="previewShipTabs">
                <button class="tab active" data-ship="Fighter">Fighter</button>
                <button class="tab" data-ship="Frigate">Frigate</button>
                <button class="tab" data-ship="Cruiser">Cruiser</button>
              </div>
            </div>
            <div class="preview-group">
              <div class="preview-label">改型 (loadout)</div>
              <div class="preview-tabs variant-tabs" id="previewVariantTabs"></div>
            </div>
            <div class="preview-group">
              <div class="preview-label">阵营</div>
              <div class="preview-tabs" id="previewTeamTabs">
                <button class="tab team-a active" data-team="A">舰队 A</button>
                <button class="tab team-b" data-team="B">舰队 B</button>
              </div>
            </div>
            <div class="preview-info" id="previewInfo"></div>
            <div class="hint">拖拽可旋转视角，滚轮缩放；模型会自动缓慢旋转。</div>
          </div>
        </div>
      </div>
    `;

    (el.querySelector('#previewClose') as HTMLButtonElement).addEventListener('click', () => this.hide());
    return el;
  }

  private bindTabs(): void {
    const shipTabs = this.overlay.querySelector('#previewShipTabs') as HTMLElement;
    shipTabs.querySelectorAll('button[data-ship]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.curType = (btn as HTMLElement).dataset.ship as ShipTypeName;
        shipTabs.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        // 切换舰种后，改型重置为该类别的首个改型（standard）
        this.curVariant = VARIANTS_BY_CLASS[this.curType][0];
        this.renderVariantTabs();
        this.preview.setShip(this.curType, this.curTeam, this.curVariant);
        this.renderInfo();
      });
    });

    const teamTabs = this.overlay.querySelector('#previewTeamTabs') as HTMLElement;
    teamTabs.querySelectorAll('button[data-team]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.curTeam = (btn as HTMLElement).dataset.team as Team;
        teamTabs.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.preview.setShip(this.curType, this.curTeam, this.curVariant);
        this.renderInfo();
      });
    });
  }

  /** 根据当前舰种渲染改型标签（不同舰种允许的改型不同） */
  private renderVariantTabs(): void {
    const host = this.overlay.querySelector('#previewVariantTabs') as HTMLElement;
    host.innerHTML = '';
    const variants = VARIANTS_BY_CLASS[this.curType];
    for (const v of variants) {
      const btn = document.createElement('button');
      btn.className = 'tab' + (v === this.curVariant ? ' active' : '');
      btn.dataset.variant = v;
      btn.textContent = VARIANT_CN[v];
      btn.addEventListener('click', () => {
        this.curVariant = v;
        host.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.preview.setShip(this.curType, this.curTeam, this.curVariant);
        this.renderInfo();
      });
      host.appendChild(btn);
    }
  }

  private renderInfo(): void {
    const def = SHIP_DEFS[this.curType];
    const variant = getVariantDef(this.curVariant);
    const reco = { formation: variant.recFormation, doctrine: variant.recDoctrine };

    const weapons = def.components
      .filter((c) => c.weapon)
      .map((c) => {
        const w = c.weapon!;
        const arc = ARC_LABEL[w.arc ?? 'front'] ?? '前射';
        const role = w.role ? ` · ${w.role}` : '';
        return `<li><span class="ci-type">${c.name}</span> ${w.name}${role} · 射程 ${w.range} · 伤害 ${w.damage} · <b>${arc}</b></li>`;
      })
      .join('');

    const comps = def.components
      .map(
        (c) =>
          `<li><span class="ci-type">${COMP_LABEL[c.type]}</span> <b>${c.name}</b> · HP ${c.maxHp}</li>`
      )
      .join('');

    const b = variant.bars;
    const bar = (label: string, v: number) =>
      `<div class="bar-row"><span>${label}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div></div>`;

    const barsHtml =
      bar('速度', b.speed) +
      bar('火力', b.firepower) +
      bar('防御', b.defense) +
      bar('射程', b.range) +
      bar('支援', b.support);

    this.infoEl.innerHTML = `
      <div class="pi-title">${SHIP_CN[this.curType as ShipClass]} · ${variant.displayName}</div>
      <div class="pi-cost">成本 <b>${variant.cost}</b> 点</div>
      <div class="pi-desc">${SHIP_DESC[this.curType]}</div>
      <div class="pi-role">${SHIP_ROLE[this.curType]}</div>
      <div class="pi-variant-desc">${variant.description}</div>
      <div class="pi-grid">
        <div><span class="pi-k">定位</span><span class="pi-v">${variant.role}</span></div>
        <div><span class="pi-k">优势</span><span class="pi-v pi-good">${variant.strength}</span></div>
        <div><span class="pi-k">劣势</span><span class="pi-v pi-bad">${variant.weakness}</span></div>
        <div><span class="pi-k">推荐阵型</span><span class="pi-v">${reco.formation}</span></div>
        <div><span class="pi-k">推荐战术</span><span class="pi-v">${reco.doctrine}</span></div>
      </div>
      <div class="pi-bars">${barsHtml}</div>
      <div class="pi-comps-title">武器（开火弧 / 基础值）</div>
      <ul class="pi-comps">${weapons}</ul>
      <div class="pi-comps-title">改型武器说明</div>
      <div class="pi-note">${variant.weaponNote}</div>
      <div class="pi-comps-title">改型组件说明</div>
      <div class="pi-note">${variant.componentNote}</div>
      <div class="pi-comps-title">组件构成（基础舰体）</div>
      <ul class="pi-comps">${comps}</ul>
    `;
  }

  show(): void {
    this.overlay.style.display = 'flex';
    this.preview.setShip(this.curType, this.curTeam, this.curVariant);
    this.preview.start();
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.preview.stop();
  }
}
