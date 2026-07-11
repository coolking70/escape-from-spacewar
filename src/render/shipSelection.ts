// 舰船选择（渲染/UI 层）：用 Three.js Raycaster 在 3D 场景中拾取飞船。
//
// 关键约束（来自验收要求）：
//   - 选择逻辑完全在渲染层，只读取、不修改 BattleState / ReplayConfig。
//   - 被选中的飞船只是"高亮 + 镜头跟随"的输入，绝不回写任何战斗判定。
//   - group.userData 在 shipMeshFactory 中写入（shipId / team / shipClass / variant），
//     子 Mesh 经 parent 链即可回溯到所属飞船。
//   - 为避免与 OrbitControls 拖拽冲突，仅在"按下→抬起几乎未移动"时视为点击拾取。

import * as THREE from 'three';
import { Team, ShipClass, ShipVariant } from '../sim/battleTypes';

export interface PickResult {
  shipId: number;
  team: Team;
  shipClass: ShipClass;
  variant: ShipVariant;
}

export class ShipSelector {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private camera: THREE.Camera;
  /** 用于区分"点击"与"拖拽旋转" */
  private downX = 0;
  private downY = 0;
  private downAt = 0;
  private attached: HTMLElement | null = null;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
  }

  /** 绑定到渲染画布（仅监听 pointer 事件，区分点击与拖拽） */
  attach(dom: HTMLElement): void {
    this.attached = dom;
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
  }

  dispose(): void {
    if (this.attached) {
      this.attached.removeEventListener('pointerdown', this.onDown);
      this.attached.removeEventListener('pointerup', this.onUp);
      this.attached = null;
    }
  }

  private onDown = (e: PointerEvent): void => {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.downAt = performance.now();
  };

  private onUp = (e: PointerEvent): void => {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    const dist = Math.hypot(dx, dy);
    const dt = performance.now() - this.downAt;
    // 移动过远或按住过久 → 视为拖拽/旋转，不拾取
    if (dist > 6 || dt > 500) return;
    const picked = this.pickAt(e.clientX, e.clientY, this.root);
    if (picked) {
      this.onPick?.(picked);
    } else {
      this.onPick?.(null);
    }
  };

  /** 由 ThreeScene 注入当前舰船根节点（每次 buildBattle 后刷新） */
  setRoot(root: THREE.Object3D): void {
    this.root = root;
  }

  /** 拾取回调（App 注入）：传入选中结果，或 null 表示点击空白处取消 */
  onPick: ((r: PickResult | null) => void) | null = null;

  private root: THREE.Object3D = new THREE.Object3D();

  /** 在 (clientX, clientY) 处做射线拾取，返回所属飞船标识（点击空白返回 null） */
  pickAt(clientX: number, clientY: number, root: THREE.Object3D): PickResult | null {
    if (!root) return null;
    const rect = (this.attached as HTMLElement).getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(root.children, true);
    for (const h of hits) {
      const r = this.findShip(h.object);
      if (r) return r;
    }
    return null;
  }

  /** 沿 parent 链向上找带 userData.shipId 的节点 */
  private findShip(obj: THREE.Object3D | null): PickResult | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const ud = cur.userData;
      if (ud && typeof ud.shipId === 'number' && ud.shipId >= 0) {
        return {
          shipId: ud.shipId as number,
          team: ud.team as Team,
          shipClass: ud.shipClass as ShipClass,
          variant: ud.variant as ShipVariant
        };
      }
      cur = cur.parent;
    }
    return null;
  }
}
