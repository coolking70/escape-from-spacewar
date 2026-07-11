// 摄像机控制器：基于 OrbitControls 的封装，支持拖拽旋转与滚轮缩放。
// 新增自动镜头模式：跟随存活舰船中心，按分布范围自动调整距离，
// 战斗结束时缓慢拉远展示残余舰队。仅影响观察，不影响模拟。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface CameraFocus {
  /** 存活舰船中心（世界坐标） */
  center: THREE.Vector3;
  /** 存活舰船分布半径（用于决定取景距离） */
  radius: number;
  /** 战斗是否已结束（结束则拉远） */
  finished: boolean;
}

export class CameraController {
  private controls: OrbitControls;
  private auto = true;
  private focus: CameraFocus = {
    center: new THREE.Vector3(0, 0, 0),
    radius: 60,
    finished: false
  };
  /** 跟随目标位置（不为 null 时进入跟随模式，覆盖自动取景） */
  private followPos: THREE.Vector3 | null = null;

  constructor(camera: THREE.Camera, dom: HTMLElement) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 600;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 0, 0);
  }

  /** 开关自动镜头 */
  setAuto(on: boolean): void {
    this.auto = on;
  }

  isAuto(): boolean {
    return this.auto;
  }

  /** 设置本帧的跟随目标（存活舰船中心/范围/是否结束） */
  setFocus(focus: CameraFocus): void {
    this.focus = focus;
  }

  /** 设置跟随目标位置（null = 取消跟随，回到自动镜头） */
  setFollow(pos: THREE.Vector3 | null): void {
    this.followPos = pos;
  }

  isFollowing(): boolean {
    return this.followPos != null;
  }

  update(): void {
    const cam = this.controls.object as THREE.PerspectiveCamera;

    // 跟随模式：仅平滑移动观察中心，保留用户的环绕/缩放（不锁死鼠标）
    if (this.followPos) {
      this.controls.target.lerp(this.followPos, 0.12);
      this.controls.update();
      return;
    }

    if (this.auto) {
      // 平滑将观察目标移向战场中心
      this.controls.target.lerp(this.focus.center, 0.05);

      // 根据分布半径决定理想距离，并保证最小/最大范围
      let want = THREE.MathUtils.clamp(this.focus.radius * 2.3 + 55, 70, 560);
      if (this.focus.finished) want *= 1.5; // 结束缓慢拉远

      const offset = cam.position.clone().sub(this.controls.target);
      const curDist = offset.length() || 1;
      const newDist = THREE.MathUtils.lerp(curDist, want, 0.045);
      offset.setLength(newDist);
      cam.position.copy(this.controls.target).add(offset);
    }

    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }
}
