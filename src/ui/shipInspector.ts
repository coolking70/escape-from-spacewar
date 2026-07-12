// Ship Inspector：选中舰船后，在 HUD 侧边显示该舰的实时情报。
//
// 数据来源（全部来自 BattleState / 派生，绝不回写 sim）：
//   - 基础：ship.id / team / type / variant / alive（来自 state.ships）
//   - 目标与距离：ship.targetId + 对方实时 pos（来自 state）
//   - 速度/理想距离/命中率/护盾/传感器：ship.effectiveSpeed / 由公式推导 / ship.accuracy / ship.shield
//   - 支援光环：通过 sim.getAuraStatus(id) 只读读取（App 注入的 sim 引用）
//   - 伤害/击毁：state.stats.ships[id].damageDealt / .kills
//   - 组件/武器：ship.components（HP 进度条按 75/50/25% 分级配色）
//   - 改型说明：VARIANTS[variant].weaponNote / componentNote / role
//
// 性能：每帧调用 update()，但内部按帧节流（默认每 5 帧才重建一次文本），
// 且未选中或面板折叠时不做事。

import { BattleState, Ship, ShipComponent, ComponentTypeName, CombatState } from '../sim/battleTypes';
import { SHIP_RANGE_FACTOR, DOCTRINE_RANGE_FACTOR } from '../sim/battleConfig';
import { SHIP_CN, VARIANT_CN, getVariantDef } from '../sim/shipVariants';

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

const COMBAT_CN: Record<CombatState, string> = {
  normal: '正常',
  damaged: '受损',
  critical: '危急',
  disabled: '失能',
  retreating: '撤退中',
  escaped: '已脱战',
  destroyed: '已损毁'
};
const COMBAT_COLOR: Record<CombatState, string> = {
  normal: '#4fd06a',
  damaged: '#e8d44a',
  critical: '#f0913a',
  disabled: '#e0463a',
  retreating: '#5aa9ff',
  escaped: '#7ad0ff',
  destroyed: '#888'
};

export interface InspectorCallbacks {
  onFollow: (id: number) => void;
  onFollowTarget: (id: number) => void;
  onClose: () => void;
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 由组件 HP 比例得到进度条配色（75/50/25% 分级） */
function hpColor(ratio: number, destroyed: boolean): string {
  if (destroyed || ratio <= 0) return '#3a3a3a';
  if (ratio >= 0.75) return '#4fd06a';
  if (ratio >= 0.5) return '#e8d44a';
  if (ratio >= 0.25) return '#f0913a';
  return '#e0463a';
}

export class ShipInspector {
  private root: HTMLElement;
  private cb: InspectorCallbacks;
  private body!: HTMLElement;
  private title!: HTMLElement;
  private followBtn!: HTMLButtonElement;
  private targetBtn!: HTMLButtonElement;

  private currentId: number | null = null;
  private collapsed = false;
  private frame = 0;
  /** 由 App 注入：用于只读读取该舰当前受到的支援光环加成 */
  getAura: ((id: number) => { accuracy: number; shieldRegen: number }) | null = null;

  constructor(root: HTMLElement, cb: InspectorCallbacks) {
    this.root = root;
    this.cb = cb;
    this.render();
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="insp-head">
        <span class="insp-title" id="inspTitle">舰船情报</span>
        <button class="btn small" id="inspCollapse">折叠</button>
        <button class="btn small" id="inspClose">×</button>
      </div>
      <div class="insp-body" id="inspBody"></div>
      <div class="insp-actions">
        <button class="btn small accent-a" id="inspFollow">跟随此舰</button>
        <button class="btn small" id="inspTarget">切换目标舰</button>
      </div>
    `;
    this.body = this.root.querySelector('#inspBody') as HTMLElement;
    this.title = this.root.querySelector('#inspTitle') as HTMLElement;
    this.followBtn = this.root.querySelector('#inspFollow') as HTMLButtonElement;
    this.targetBtn = this.root.querySelector('#inspTarget') as HTMLButtonElement;

    (this.root.querySelector('#inspClose') as HTMLButtonElement).addEventListener('click', () =>
      this.cb.onClose()
    );
    (this.root.querySelector('#inspCollapse') as HTMLButtonElement).addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.body.style.display = this.collapsed ? 'none' : 'block';
      (this.root.querySelector('#inspCollapse') as HTMLElement).textContent = this.collapsed
        ? '展开'
        : '折叠';
    });
    this.followBtn.addEventListener('click', () => {
      if (this.currentId != null) this.cb.onFollow(this.currentId);
    });
    this.targetBtn.addEventListener('click', () => {
      if (this.currentId != null) this.cb.onFollowTarget(this.currentId);
    });
    this.root.style.display = 'none';
  }

  /** 选中某舰并显示 */
  showFor(id: number): void {
    this.currentId = id;
    this.root.style.display = 'block';
    this.frame = 0;
  }

  /** 取消选择（隐藏面板） */
  clear(): void {
    this.currentId = null;
    this.root.style.display = 'none';
  }

  isShowing(id: number): boolean {
    return this.currentId === id;
  }

  /** 每帧调用：节流刷新（默认每 5 帧） */
  update(state: BattleState): void {
    if (this.currentId == null) return;
    this.frame++;
    if (this.frame % 5 !== 0) return;
    const ship = state.ships.find((s) => s.id === this.currentId);
    if (!ship) {
      this.currentId = null;
      this.root.style.display = 'none';
      return;
    }
    this.body.innerHTML = this.renderBody(ship, state);
  }

  private renderBody(ship: Ship, state: BattleState): string {
    const teamCls = ship.team === 'A' ? 't-a' : 't-b';
    const aliveTxt = ship.alive ? '存活' : '已损毁';
    const target =
      ship.targetId != null ? state.ships.find((s) => s.id === ship.targetId) : null;
    const dToTgt = target ? dist(ship.pos, target.pos) : null;

    // 理想交火距离（与 sim.desiredRange 同公式，仅展示用）
    let maxW = 0;
    for (const c of ship.components) if (c.def.weapon && !c.destroyed) maxW = Math.max(maxW, c.def.weapon.range);
    if (maxW === 0) maxW = ship.effectiveRange;
    const rf = SHIP_RANGE_FACTOR[ship.type] ?? 0.9;
    const df = DOCTRINE_RANGE_FACTOR[state.teamDoctrine[ship.team]] ?? 1.0;
    const ideal = Math.round(maxW * rf * df);

    // 传感器状态
    const sensors = ship.components.filter((c) => c.def.type === 'sensor');
    const senHp = sensors.reduce((s, c) => s + c.hp, 0);
    const senMax = sensors.reduce((s, c) => s + c.maxHp, 0);
    const senRatio = senMax > 0 ? senHp / senMax : 1;

    // 支援光环
    const aura = this.getAura ? this.getAura(ship.id) : { accuracy: 0, shieldRegen: 0 };

    const st = state.stats.ships[ship.id];
    const dmg = st ? Math.round(st.damageDealt) : 0;
    const kills = st ? st.kills : 0;

    const variant = getVariantDef(ship.variant);

    // 战斗状态（core-v4）
    const cs = ship.combatState;
    const csBadge = `<span style="color:${COMBAT_COLOR[cs]};font-weight:700">${COMBAT_CN[cs]}</span>`;
    const csExtra =
      ship.retreatReason && cs === 'retreating'
        ? `（${ship.retreatReason}）`
        : ship.mobilityDisabled
        ? '（机动失效）'
        : ship.weaponsDisabled
        ? '（武器失效）'
        : ship.sensorsDisabled
        ? '（传感器失效）'
        : '';

    // 组件进度条
    const compRows = ship.components
      .map((c: ShipComponent) => {
        const r = c.maxHp > 0 ? c.hp / c.maxHp : 0;
        const col = hpColor(r, c.destroyed);
        return `<div class="insp-comp">
          <div class="ic-top"><span>${COMP_LABEL[c.def.type] ?? c.def.type} · ${c.def.name}</span><span>${Math.max(0, Math.round(c.hp))}/${c.maxHp}${c.destroyed ? ' 💥' : ''}</span></div>
          <div class="bar"><i style="width:${Math.round(r * 100)}%;background:${col}"></i></div>
        </div>`;
      })
      .join('');

    // 武器状态
    const weaponRows = ship.components
      .filter((c) => c.def.weapon)
      .map((c) => {
        const w = c.def.weapon!;
        const canFire = c.destroyed
          ? false
          : state.tick - (ship.lastFireTick.get(ship.components.indexOf(c)) ?? -999999) >= w.cooldownTicks;
        const arc = ARC_LABEL[w.arc ?? 'front'] ?? '前射';
        return `<div class="insp-wpn ${c.destroyed ? 'dead' : ''}">
          <span class="iw-name">${c.def.name}</span>
          <span class="iw-stat">伤害 ${w.damage} · 射程 ${w.range} · 冷却 ${w.cooldownTicks}</span>
          <span class="iw-stat">${arc}${c.destroyed ? ' · 已毁' : canFire ? ' · 可开火' : ' · 冷却中'}</span>
        </div>`;
      })
      .join('');

    return `
      <div class="insp-id"><b class="${teamCls}">#${ship.id}</b> · <span class="${teamCls}">舰队 ${ship.team}</span> · ${SHIP_CN[ship.type]}·${VARIANT_CN[ship.variant]}</div>
      <div class="insp-row"><span>状态</span><b>${aliveTxt}</b></div>
      <div class="insp-row"><span>战斗状态</span><b>${csBadge}${csExtra}</b></div>
      <div class="insp-row"><span>当前目标</span><b>${target ? `#${target.id}（${SHIP_CN[target.type]}·${VARIANT_CN[target.variant]}）` : '无'}</b></div>
      <div class="insp-row"><span>距目标</span><b>${dToTgt != null ? Math.round(dToTgt) : '—'}</b></div>
      <div class="insp-row"><span>速度 / 最大</span><b>${ship.effectiveSpeed.toFixed(3)} / ${ship.def.maxSpeed.toFixed(3)}</b></div>
      <div class="insp-row"><span>理想交火距离</span><b>${ideal}</b></div>
      <div class="insp-row"><span>护盾 / 最大</span><b>${Math.round(ship.shield)} / ${Math.round(ship.maxShield)}</b></div>
      <div class="insp-row"><span>当前命中率</span><b>${(ship.accuracy * 100).toFixed(0)}%</b></div>
      <div class="insp-row"><span>传感器</span><b style="color:${hpColor(senRatio, senRatio <= 0)}">${(senRatio * 100).toFixed(0)}%</b></div>
      <div class="insp-row"><span>机动效率</span><b style="color:${hpColor(ship.engineRatio, ship.engineRatio <= 0)}">${(ship.engineRatio * 100).toFixed(0)}%</b></div>
      <div class="insp-row"><span>武器效率</span><b style="color:${hpColor(ship.weaponEfficiency, ship.weaponEfficiency <= 0)}">${(ship.weaponEfficiency * 100).toFixed(0)}%</b></div>
      <div class="insp-row"><span>传感器效率</span><b style="color:${hpColor(ship.sensorRatio, ship.sensorRatio <= 0)}">${(ship.sensorRatio * 100).toFixed(0)}%</b></div>
      <div class="insp-row"><span>战术</span><b>${state.teamDoctrine[ship.team]}</b></div>
      <div class="insp-row"><span>造成伤害</span><b>${dmg}</b></div>
      <div class="insp-row"><span>击毁数</span><b>${kills}</b></div>
      <div class="insp-sub">支援光环</div>
      <div class="insp-row"><span>命中加成</span><b>${aura.accuracy > 0 ? '+' + (aura.accuracy * 100).toFixed(0) + '%' : '无'}</b></div>
      <div class="insp-row"><span>护盾恢复加成</span><b>${aura.shieldRegen > 0 ? '+' + aura.shieldRegen.toFixed(2) : '无'}</b></div>
      <div class="insp-sub">组件状态</div>
      ${compRows}
      <div class="insp-sub">武器状态</div>
      ${weaponRows}
      <div class="insp-sub">改型说明</div>
      <div class="insp-note">定位：${variant.role}</div>
      <div class="insp-note">武器：${variant.weaponNote}</div>
      <div class="insp-note">组件：${variant.componentNote}</div>
    `;
  }
}
