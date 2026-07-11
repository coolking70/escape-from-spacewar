// Three.js 场景：创建渲染器、灯光、星空背景，并把 BattleState 映射为可视飞船。
// 渲染层只"展示"当前 tick 的结果，可在 prev/cur 之间插值（不影响战斗结果）。
// V0.2：处理引擎尾焰损坏表现、死亡残骸保留、视觉事件路由、自动镜头焦点计算。

import * as THREE from 'three';
import { BattleState, Ship, BattleEvent, Vec3 } from '../sim/battleTypes';
import { ShipVisual, buildShipVisual } from './shipMeshFactory';
import { applyDamageToMesh } from './materials';
import { EffectsManager } from './effects';
import { CameraController, CameraFocus } from './cameraController';
import { ShipSelector, PickResult } from './shipSelection';
import { VARIANT_CN } from '../sim/shipVariants';
import { ViewFilters } from '../ui/viewPrefs';
import { disposeGeometryCache } from './shipMeshFactory';

export interface PosSnapshot {
  pos: Vec3;
  heading: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 死亡后残骸保留的 tick 数（与 state.explosions 的存活窗口一致） */
const DEATH_HOLD_TICKS = 45;

export class ThreeScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private cameraCtl: CameraController;
  private shipGroup: THREE.Group;
  private visuals = new Map<number, ShipVisual>();
  private effects: EffectsManager;
  private container: HTMLElement;
  private onResize: () => void;

  /** 舰船选择（Raycaster，仅读取、不修改 sim） */
  private selector: ShipSelector;
  /** 选中高亮环（独立挂场景，不随飞船 dispose 销毁） */
  private selectionRing: THREE.Mesh;
  /** 当前选中飞船 id（null=未选） */
  private selectedId: number | null = null;
  /** 镜头跟随的飞船 id（null=不跟随） */
  private followId: number | null = null;
  /** 拾取回调（App 注入：用于显示 Ship Inspector） */
  onSelect: ((r: PickResult | null) => void) | null = null;

  /** 战斗视图筛选（纯渲染，不影响 sim） */
  private filters: ViewFilters = {
    labels: false,
    componentDamage: false,
    auraRanges: false,
    weaponRanges: false,
    targetLines: false,
    selectedOnly: false
  };

  // —— 视图筛选所需的可视对象（均在 scene 内，dispose 时统一释放） ——
  private labelLayer: HTMLElement;
  private labelPool = new Map<number, HTMLDivElement>();
  private damageMarkerGeo: THREE.BufferGeometry;
  private damageMarkerMat: THREE.Material;
  private damageMarkers = new Map<number, THREE.Mesh[]>();
  private auraMeshes = new Map<number, THREE.Mesh>();
  private weaponRangeMesh: THREE.Mesh | null = null;
  private targetLineObj: THREE.LineSegments | null = null;
  private targetLinePos = new Float32Array(200 * 6);
  private targetLineCol = new Float32Array(200 * 6);

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.0016);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 3000);
    this.camera.position.set(0, 70, 110);

    this.cameraCtl = new CameraController(this.camera, this.renderer.domElement);

    this.setupLights();
    this.buildStarfield();
    this.shipGroup = new THREE.Group();
    this.scene.add(this.shipGroup);
    this.effects = new EffectsManager(this.scene);

    // 选中高亮环（独立挂场景，不随飞船网格销毁）
    const ringGeo = new THREE.TorusGeometry(4, 0.18, 8, 40);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.visible = false;
    this.selectionRing.rotation.x = Math.PI / 2;
    this.scene.add(this.selectionRing);

    // 舰船选择（Raycaster + 点击/拖拽区分）
    this.selector = new ShipSelector(this.camera);
    this.selector.attach(this.renderer.domElement);
    this.selector.onPick = (r) => {
      if (r) this.selectShip(r.shipId);
      else this.clearSelection();
      this.onSelect?.(r);
    };

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);

    // 舰船标签层（HTML 覆盖在 canvas 之上，纯显示）
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    this.labelLayer.style.display = 'none';
    this.container.appendChild(this.labelLayer);

    // 组件受损标记：共享的线框八面体几何与材质
    this.damageMarkerGeo = new THREE.OctahedronGeometry(0.9, 0);
    this.damageMarkerMat = new THREE.MeshBasicMaterial({
      color: 0xff4444,
      wireframe: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    });
  }

  /** 三点照明 + 边缘光，让 MeshStandardMaterial 金属表面有高光与阴影 */
  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0x3a4458, 0.6);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff0e0, 0.9);
    key.position.set(60, 100, 50);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8899ff, 0.4);
    fill.position.set(-50, 40, -60);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffaa88, 0.25);
    rim.position.set(0, -40, 80);
    this.scene.add(rim);
  }

  private buildStarfield(): void {
    const count = 1200;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 1600;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 800;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 1600;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x8899bb, size: 1.2, sizeAttenuation: true });
    this.scene.add(new THREE.Points(geo, mat));
  }

  /** 根据初始状态构建所有飞船网格 */
  buildBattle(state: BattleState): void {
    // 重新构建时清除旧选择（避免出现指向已不存在飞船的幽灵高亮）
    this.clearSelection();
    for (const v of this.visuals.values()) this.disposeVisual(v);
    this.visuals.clear();
    while (this.shipGroup.children.length) this.shipGroup.remove(this.shipGroup.children[0]);

    for (const ship of state.ships) {
      const visual = buildShipVisual(ship.def, ship.team, ship.variant, ship.id);
      visual.group.position.set(ship.pos.x, ship.pos.y, ship.pos.z);
      visual.group.rotation.y = ship.heading;
      this.shipGroup.add(visual.group);
      this.visuals.set(ship.id, visual);
    }
    this.selector.setRoot(this.shipGroup);
  }

  /** 处理本帧由 sim 派发的视觉事件（命中闪光 / 火花） */
  applyEvents(events: BattleEvent[], state: BattleState): void {
    this.effects.syncEvents(events, state);
  }

  /** 开关自动镜头（HUD 调用） */
  setAutoCamera(on: boolean): void {
    this.cameraCtl.setAuto(on);
  }

  /** 每帧更新：插值位置 + 损伤变色 + 引擎尾焰 + 特效 + 镜头 */
  update(state: BattleState, prev: Map<number, PosSnapshot>, alpha: number): void {
    const focus = this.computeFocus(state);

    for (const ship of state.ships) {
      const visual = this.visuals.get(ship.id);
      if (!visual) continue;

      if (!ship.alive) {
        // 死亡后保留残骸片刻（爆炸期间），随后隐藏
        const ex = state.explosions.find((e) => e.shipId === ship.id);
        const holding = ex && state.tick - ex.tick < DEATH_HOLD_TICKS;
        if (holding) {
          visual.group.visible = true;
          if (this.filters.selectedOnly && this.selectedId != null && ship.id !== this.selectedId) {
            visual.group.visible = false;
          }
          // 残骸整体焦黑
          for (const meshes of visual.parts.values()) {
            for (const mesh of meshes) applyDamageToMesh(mesh, 0, true);
          }
        } else {
          visual.group.visible = false;
        }
        continue;
      }

      visual.group.visible = true;
      if (this.filters.selectedOnly && this.selectedId != null && ship.id !== this.selectedId) {
        visual.group.visible = false;
      }

      const p = prev.get(ship.id);
      if (p) {
        visual.group.position.set(
          lerp(p.pos.x, ship.pos.x, alpha),
          lerp(p.pos.y, ship.pos.y, alpha),
          lerp(p.pos.z, ship.pos.z, alpha)
        );
        let dh = ship.heading - p.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        visual.group.rotation.y = p.heading + dh * alpha;
      } else {
        visual.group.position.set(ship.pos.x, ship.pos.y, ship.pos.z);
        visual.group.rotation.y = ship.heading;
      }

      // 组件损伤变色
      for (const [i, meshes] of visual.parts) {
        const comp = ship.components[i];
        if (!comp) continue;
        const hpRatio = comp.hp / comp.maxHp;
        for (const mesh of meshes) {
          applyDamageToMesh(mesh, hpRatio, comp.destroyed);
        }
      }

      // 引擎尾焰：按引擎 HP 调整亮度、缩放，重伤时轻微闪烁（纯视觉）
      for (const g of visual.glows) {
        const comp = ship.components[g.comp];
        if (!comp) continue;
        const alive = !comp.destroyed && comp.hp > 0;
        if (!alive) {
          g.mesh.visible = false;
          continue;
        }
        g.mesh.visible = true;
        const ratio = comp.hp / comp.maxHp;
        const f = 0.4 + 0.6 * ratio;
        let inten = g.baseIntensity * f;
        let scale = 0.55 + 0.45 * ratio;
        if (ratio < 0.25) {
          // 重伤闪烁
          scale *= 0.82 + 0.18 * Math.random();
          inten *= 0.8 + 0.2 * Math.random();
        }
        (g.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = inten;
        g.mesh.scale.setScalar(scale);
      }
    }

    this.effects.sync(state);
    this.effects.update(state);

    // 视图筛选叠加层（纯渲染，不影响 sim）
    this.syncDamageMarkers(state);
    this.syncAuraMeshes(state);
    this.syncWeaponRange(state);
    this.syncTargetLines(state);
    this.updateLabels(state);

    // 选中高亮环：跟随所选飞船当前位置（死亡后保留残骸位置短暂展示）
    if (this.selectedId != null) {
      const v = this.visuals.get(this.selectedId);
      const ship = state.ships.find((s) => s.id === this.selectedId);
      if (v && ship && (ship.alive || state.explosions.some((e) => e.shipId === this.selectedId))) {
        const g = v.group;
        const base = 3.2 * (ship.def.scale || 1) + 1.5;
        this.selectionRing.visible = true;
        this.selectionRing.position.set(g.position.x, g.position.y, g.position.z);
        this.selectionRing.scale.setScalar(base);
        const mat = this.selectionRing.material as THREE.MeshBasicMaterial;
        mat.color.setHex(ship.team === 'A' ? 0x66e0ff : 0xff9a6c);
      } else {
        this.selectionRing.visible = false;
      }
    } else {
      this.selectionRing.visible = false;
    }

    this.cameraCtl.setFocus(focus);
    this.updateFollow(state);
    this.cameraCtl.update();
  }

  /** 镜头跟随：平滑把观察中心移向所选飞船；死亡后保留残骸位置一段时间，再退回自动镜头 */
  private updateFollow(state: BattleState): void {
    if (this.followId == null) {
      this.cameraCtl.setFollow(null);
      return;
    }
    const ship = state.ships.find((s) => s.id === this.followId);
    const ex = ship ? state.explosions.find((e) => e.shipId === ship.id) : null;
    const alive = ship && ship.alive;
    const holding = ex && state.tick - ex.tick < DEATH_HOLD_TICKS;
    if (alive || holding) {
      const p = alive ? ship!.pos : ex!.pos;
      this.cameraCtl.setFollow(new THREE.Vector3(p.x, p.y, p.z));
    } else {
      // 残骸过期：自动取消跟随（回到自动镜头），并清除选择高亮
      this.followId = null;
      this.cameraCtl.setFollow(null);
      this.clearSelection();
    }
  }

  /** 跟随某艘飞船（同时选中以显示高亮环） */
  followShip(id: number): void {
    this.followId = id;
    this.selectedId = id;
  }

  /** 取消镜头跟随 */
  clearFollow(): void {
    this.followId = null;
    this.cameraCtl.setFollow(null);
  }

  /** 选中某艘飞船（设置高亮环；不影响 sim） */
  selectShip(id: number): void {
    this.selectedId = id;
  }

  /** 取消选择 */
  clearSelection(): void {
    this.selectedId = null;
    this.selectionRing.visible = false;
  }

  /** 当前选中 id（null=未选） */
  getSelectedId(): number | null {
    return this.selectedId;
  }

  // ---------------- 战斗视图筛选（纯渲染，不影响 sim） ----------------

  setViewFilter(key: keyof ViewFilters, value: boolean): void {
    if (this.filters[key] === value) return;
    this.filters[key] = value;
    if (!value) this.clearVisualForFilter(key);
  }

  setViewFilters(p: ViewFilters): void {
    (Object.keys(p) as (keyof ViewFilters)[]).forEach((k) => this.setViewFilter(k, p[k]));
  }

  getViewFilters(): ViewFilters {
    return { ...this.filters };
  }

  private clearVisualForFilter(key: keyof ViewFilters): void {
    switch (key) {
      case 'labels':
        this.labelLayer.style.display = 'none';
        for (const el of this.labelPool.values()) el.style.display = 'none';
        break;
      case 'componentDamage':
        for (const id of Array.from(this.damageMarkers.keys())) this.removeDamageMarkers(id);
        break;
      case 'auraRanges':
        for (const id of Array.from(this.auraMeshes.keys())) this.removeAura(id);
        break;
      case 'weaponRanges':
        if (this.weaponRangeMesh) this.weaponRangeMesh.visible = false;
        break;
      case 'targetLines':
        if (this.targetLineObj) this.targetLineObj.visible = false;
        break;
      case 'selectedOnly':
        // 显隐将在下一帧 update 中重新计算
        break;
    }
  }

  /** 组件受损标记：为已摧毁组件添加红色线框八面体（随舰船网格移动） */
  private syncDamageMarkers(state: BattleState): void {
    if (!this.filters.componentDamage) return;
    for (const ship of state.ships) {
      if (!ship.alive) {
        if (this.damageMarkers.has(ship.id)) this.removeDamageMarkers(ship.id);
        continue;
      }
      const destroyedIdx: number[] = [];
      ship.components.forEach((c, i) => {
        if (c.destroyed) destroyedIdx.push(i);
      });
      const visual = this.visuals.get(ship.id);
      if (!visual) continue;
      const existing = this.damageMarkers.get(ship.id);
      if (existing && existing.length === destroyedIdx.length) continue;
      if (existing) this.removeDamageMarkers(ship.id);
      const meshes: THREE.Mesh[] = [];
      for (const i of destroyedIdx) {
        const comp = ship.components[i];
        const m = new THREE.Mesh(this.damageMarkerGeo, this.damageMarkerMat);
        m.position.set(comp.def.offset.x, comp.def.offset.y, comp.def.offset.z);
        visual.group.add(m);
        meshes.push(m);
      }
      this.damageMarkers.set(ship.id, meshes);
    }
  }

  private removeDamageMarkers(id: number): void {
    const meshes = this.damageMarkers.get(id);
    if (!meshes) return;
    for (const m of meshes) {
      if (m.parent) m.parent.remove(m);
    }
    this.damageMarkers.delete(id);
  }

  /** 支援光环范围：线框球，按光环类型着色（sensor=蓝 / shield=绿） */
  private syncAuraMeshes(state: BattleState): void {
    if (!this.filters.auraRanges) return;
    for (const ship of state.ships) {
      const aura = ship.variantMods.supportAura;
      if (!aura || !ship.alive) {
        if (this.auraMeshes.has(ship.id)) this.removeAura(ship.id);
        continue;
      }
      let mesh = this.auraMeshes.get(ship.id);
      if (!mesh) {
        const geo = new THREE.SphereGeometry(aura.radius, 16, 12);
        const color = aura.type === 'sensor' ? 0x66ccff : 0x66ff99;
        const mat = new THREE.MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity: 0.18,
          depthWrite: false
        });
        mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        this.auraMeshes.set(ship.id, mesh);
      }
      const visual = this.visuals.get(ship.id);
      if (visual) {
        mesh.position.copy(visual.group.position);
        mesh.visible = true;
      }
    }
  }

  private removeAura(id: number): void {
    const mesh = this.auraMeshes.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.auraMeshes.delete(id);
  }

  /** 武器射程：仅当选中舰船且开关开启时，显示其最大射程线框球 */
  private syncWeaponRange(state: BattleState): void {
    if (!this.filters.weaponRanges || this.selectedId == null) {
      if (this.weaponRangeMesh) this.weaponRangeMesh.visible = false;
      return;
    }
    const ship = state.ships.find((s) => s.id === this.selectedId);
    const visual = this.visuals.get(this.selectedId);
    if (!ship || !ship.alive || !visual) {
      if (this.weaponRangeMesh) this.weaponRangeMesh.visible = false;
      return;
    }
    if (!this.weaponRangeMesh) {
      const geo = new THREE.SphereGeometry(1, 24, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd166,
        wireframe: true,
        transparent: true,
        opacity: 0.12,
        depthWrite: false
      });
      this.weaponRangeMesh = new THREE.Mesh(geo, mat);
      this.scene.add(this.weaponRangeMesh);
    }
    this.weaponRangeMesh.scale.setScalar(Math.max(ship.effectiveRange, 1));
    this.weaponRangeMesh.position.copy(visual.group.position);
    this.weaponRangeMesh.visible = true;
  }

  /** 目标连线：存活舰船 -> 当前目标，按攻击方队伍着色 */
  private syncTargetLines(state: BattleState): void {
    if (!this.filters.targetLines) {
      if (this.targetLineObj) this.targetLineObj.visible = false;
      return;
    }
    if (!this.targetLineObj) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.targetLinePos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(this.targetLineCol, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false
      });
      this.targetLineObj = new THREE.LineSegments(geo, mat);
      this.targetLineObj.frustumCulled = false;
      this.scene.add(this.targetLineObj);
    }
    const ca = new THREE.Color(0x66e0ff);
    const cb = new THREE.Color(0xff9a6c);
    const pos = this.targetLinePos;
    const col = this.targetLineCol;
    let n = 0;
    for (const ship of state.ships) {
      if (n >= 200) break;
      if (!ship.alive || ship.targetId == null) continue;
      const tgt = state.ships.find((s) => s.id === ship.targetId);
      if (!tgt || !tgt.alive) continue;
      const pv = this.visuals.get(ship.id);
      const tv = this.visuals.get(tgt.id);
      if (!pv || !tv) continue;
      const c = ship.team === 'A' ? ca : cb;
      const o = n * 6;
      pos[o] = pv.group.position.x;
      pos[o + 1] = pv.group.position.y;
      pos[o + 2] = pv.group.position.z;
      pos[o + 3] = tv.group.position.x;
      pos[o + 4] = tv.group.position.y;
      pos[o + 5] = tv.group.position.z;
      col[o] = c.r;
      col[o + 1] = c.g;
      col[o + 2] = c.b;
      col[o + 3] = c.r;
      col[o + 4] = c.g;
      col[o + 5] = c.b;
      n++;
    }
    const geo = this.targetLineObj.geometry as THREE.BufferGeometry;
    geo.setDrawRange(0, n * 2);
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.targetLineObj.visible = true;
  }

  /** 舰船标签：HTML 覆盖层，显示 id + 改型，随镜头投影定位 */
  private updateLabels(state: BattleState): void {
    if (!this.filters.labels) {
      if (this.labelLayer.style.display !== 'none') this.labelLayer.style.display = 'none';
      return;
    }
    this.labelLayer.style.display = 'block';
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const seen = new Set<number>();
    const v = new THREE.Vector3();
    for (const ship of state.ships) {
      if (!ship.alive) continue;
      const visual = this.visuals.get(ship.id);
      if (!visual) continue;
      if (
        this.filters.selectedOnly &&
        this.selectedId != null &&
        ship.id !== this.selectedId
      ) {
        const hide = this.labelPool.get(ship.id);
        if (hide) hide.style.display = 'none';
        continue;
      }
      let el = this.labelPool.get(ship.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ship-label t-' + ship.team.toLowerCase();
        this.labelLayer.appendChild(el);
        this.labelPool.set(ship.id, el);
      }
      v.set(visual.group.position.x, visual.group.position.y + 4, visual.group.position.z);
      v.project(this.camera);
      if (v.z > 1) {
        el.style.display = 'none';
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      el.style.display = 'block';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.textContent = `#${ship.id} ${VARIANT_CN[ship.variant] ?? ship.variant}`;
      seen.add(ship.id);
    }
    for (const [id, el] of this.labelPool) {
      if (!seen.has(id)) el.style.display = 'none';
    }
  }

  /** 计算自动镜头焦点：存活舰船中心与分布半径 */
  private computeFocus(state: BattleState): CameraFocus {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let count = 0;
    let maxR = 0;
    for (const ship of state.ships) {
      if (!ship.alive) continue;
      cx += ship.pos.x;
      cy += ship.pos.y;
      cz += ship.pos.z;
      count++;
    }
    if (count === 0) {
      return { center: new THREE.Vector3(0, 0, 0), radius: 60, finished: state.finished };
    }
    cx /= count;
    cy /= count;
    cz /= count;
    for (const ship of state.ships) {
      if (!ship.alive) continue;
      const dx = ship.pos.x - cx;
      const dy = ship.pos.y - cy;
      const dz = ship.pos.z - cz;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (r > maxR) maxR = r;
    }
    return {
      center: new THREE.Vector3(cx, cy, cz),
      radius: Math.max(maxR, 30),
      finished: state.finished
    };
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 释放一支飞船可视网格内的所有材质（几何体为跨舰共享缓存，不在此释放）。 */
  private disposeVisual(v: ShipVisual): void {
    v.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else (m as THREE.Material)?.dispose();
      }
    });
    this.shipGroup.remove(v.group);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.selector.dispose();
    for (const v of this.visuals.values()) this.disposeVisual(v);
    this.visuals.clear();
    while (this.shipGroup.children.length) this.shipGroup.remove(this.shipGroup.children[0]);

    // 视图筛选叠加层释放
    this.damageMarkerGeo.dispose();
    (this.damageMarkerMat as THREE.Material).dispose();
    for (const id of Array.from(this.auraMeshes.keys())) this.removeAura(id);
    if (this.weaponRangeMesh) {
      this.scene.remove(this.weaponRangeMesh);
      this.weaponRangeMesh.geometry.dispose();
      (this.weaponRangeMesh.material as THREE.Material).dispose();
      this.weaponRangeMesh = null;
    }
    if (this.targetLineObj) {
      this.scene.remove(this.targetLineObj);
      this.targetLineObj.geometry.dispose();
      (this.targetLineObj.material as THREE.Material).dispose();
      this.targetLineObj = null;
    }
    if (this.labelLayer.parentElement === this.container) {
      this.container.removeChild(this.labelLayer);
    }

    this.selectionRing.geometry.dispose();
    (this.selectionRing.material as THREE.Material).dispose();
    disposeGeometryCache();
    this.effects.dispose();
    this.cameraCtl.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
