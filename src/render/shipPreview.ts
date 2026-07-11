// 战舰预览渲染器：独立的小型 Three.js 场景，用于单独查看某一艘飞船的模型。
// 不依赖 BattleState，也不参与任何战斗逻辑，纯展示用途。
// 复用 shipMeshFactory 的 createShipMesh 与阵营材质系统，保证预览外观与实战一致。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ShipTypeName, Team, ShipVariant } from '../sim/battleTypes';
import { createShipMesh, disposeGeometryCache } from './shipMeshFactory';

export class ShipPreview {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private pivot: THREE.Group;
  private starfield: THREE.Points | null = null;

  private type: ShipTypeName = 'Fighter';
  private team: Team = 'A';
  private variant: ShipVariant = 'standard';

  private running = false;
  private rafId = 0;
  private onResize = () => this.resize();

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 3000);
    this.camera.position.set(8, 5, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 120;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.2;
    this.controls.target.set(0, 0, 0);

    this.setupLights();
    this.buildStarfield();

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    window.addEventListener('resize', this.onResize);
  }

  /** 三点照明 + 边缘光，让金属舰船有层次感（与实战场景一致） */
  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0x3a4458, 0.6);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff0e0, 0.95);
    key.position.set(8, 12, 8);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8899ff, 0.45);
    fill.position.set(-8, 4, -10);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffaa88, 0.3);
    rim.position.set(0, -6, 10);
    this.scene.add(rim);
  }

  private buildStarfield(): void {
    const count = 600;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 400;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 200;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 400;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x8899bb, size: 0.8, sizeAttenuation: true });
    this.starfield = new THREE.Points(geo, mat);
    this.scene.add(this.starfield);
  }

  /** 切换展示的飞船类型、阵营与改型，自动居中并取景 */
  setShip(type: ShipTypeName, team: Team, variant: ShipVariant = 'standard'): void {
    this.type = type;
    this.team = team;
    this.variant = variant;

    // 清理旧模型
    this.disposeGroup(this.pivot);
    while (this.pivot.children.length) this.pivot.remove(this.pivot.children[0]);

    const group = createShipMesh(type, team, undefined, variant);
    this.pivot.add(group);

    // 将模型中心移到原点，便于绕中心旋转观察
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    group.position.sub(center);

    // 根据包围球半径自动取景
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.05;

    this.camera.position.set(dist * 0.8, dist * 0.5, dist * 0.8);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.resize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // 确保容器尺寸正确（此时覆盖层已显示）
    this.resize();
    if (this.pivot.children.length === 0) {
      this.setShip(this.type, this.team);
    }
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private loop = (): void => {
    if (!this.running) return;
    if (this.starfield) this.starfield.rotation.y += 0.0004;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.rafId = requestAnimationFrame(this.loop);
  };

  resize(): void {
    const w = this.container.clientWidth || 640;
    const h = this.container.clientHeight || 420;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.disposeGroup(this.pivot);
    if (this.starfield) {
      this.starfield.geometry.dispose();
      (this.starfield.material as THREE.Material).dispose();
      this.scene.remove(this.starfield);
    }
    this.controls.dispose();
    this.renderer.dispose();
    disposeGeometryCache();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  /** 递归释放组内所有 material（几何体为跨舰共享缓存，不在此释放） */
  private disposeGroup(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.material) {
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
  }
}
