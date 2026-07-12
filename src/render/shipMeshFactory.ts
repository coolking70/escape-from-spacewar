// 飞船网格工厂：用 Three.js 内置几何体拼装出有辨识度的太空战舰。
// 每种飞船由多个命名组件组成，支持阵营配色与组件损毁变色。
//
// 正面方向：+X（与战斗模拟移动方向一致，heading=0 时机首朝 +X）。
// 所有几何体均为 Three.js 内置类型，不依赖外部模型或贴图。
//
// 组件下标与 sim/shipFactory.ts 中 ShipDef.components 的数组顺序一一对应，
// 这样渲染层可以根据 ship.components[i].hp 更新对应 Mesh 的损伤颜色。

import * as THREE from 'three';
import { ShipDef, ShipTypeName, ShipClass, ShipVariant, Team } from '../sim/battleTypes';
import {
  makeMaterial,
  applyDamageToMesh,
  GLOW_BASE_INTENSITY
} from './materials';

// ======================== 几何缓存（性能优化） ========================
// 同一（舰种, 改型）下大量飞船共享完全相同的几何参数。这里按
// `几何类型 + 参数` 缓存几何体实例，使 50+ 艘舰船只持有一份几何体，
// 大幅减少开战时的几何体分配与 GPU 上传。几何体为不可变资源，
// 由 disposeGeometryCache() 在场景/预览销毁时统一释放，避免重复释放或泄漏。

const geoCache = new Map<string, THREE.BufferGeometry>();

/** 获取（或创建并缓存）一个几何体。相同参数返回同一实例。 */
function acquireGeo(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const key = geo.type + '|' + JSON.stringify((geo as unknown as { parameters?: unknown }).parameters ?? {});
  const cached = geoCache.get(key);
  if (cached) {
    geo.dispose(); // 丢弃重复创建的实例，避免泄漏
    return cached;
  }
  geoCache.set(key, geo);
  return geo;
}

/** 统一释放所有缓存几何体（场景/预览销毁时调用一次）。 */
export function disposeGeometryCache(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

// ======================== Mesh 构建辅助 ========================

interface PartConfig {
  name: string;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  pos: [number, number, number];
  rot?: [number, number, number];
  /** 对应 ShipDef.components 的下标 */
  comp: number;
  /** 是否为引擎尾焰（threeScene 会据此做变暗/闪烁） */
  glow?: boolean;
}

/**
 * 创建一个 Mesh 并加入 group，同时登记到 parts 映射。
 * 每个_mesh_ 拥有独立的克隆材质（这样不同组件可以独立变色）。
 */
function addMesh(
  group: THREE.Group,
  parts: Map<number, THREE.Mesh[]>,
  cfg: PartConfig
): THREE.Mesh {
  // 克隆材质：确保每个 Mesh 的材质独立，损伤变色互不影响
  const mat = cfg.mat.clone();
  const mesh = new THREE.Mesh(acquireGeo(cfg.geo), mat);
  mesh.name = cfg.name;
  mesh.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
  if (cfg.rot) mesh.rotation.set(cfg.rot[0], cfg.rot[1], cfg.rot[2]);

  // 存储基础色，供 applyDamageToMesh 每帧恢复使用
  mesh.userData.componentIndex = cfg.comp;
  mesh.userData.baseColor = mat.color.clone();
  mesh.userData.baseEmissive = mat.emissive.clone();
  mesh.userData.baseEmissiveIntensity = mat.emissiveIntensity;
  if (cfg.glow) mesh.userData.isGlow = true;

  group.add(mesh);

  const arr = parts.get(cfg.comp) || [];
  arr.push(mesh);
  parts.set(cfg.comp, arr);
  return mesh;
}

// 绕 Y 轴旋转本地偏移（与 sim 的 rotateY 一致，用于炮口/尾焰等定位）
export function localToWorldOffset(
  offset: { x: number; y: number; z: number },
  heading: number
): THREE.Vector3 {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return new THREE.Vector3(
    offset.x * c + offset.z * s,
    offset.y,
    -offset.x * s + offset.z * c
  );
}

// ======================== 改型装饰（纯视觉，不改变组件数量） ========================
// 为不同改型追加轻量装饰性 Mesh（Fighter/Frigate/Cruiser 各自的改型）。
// 关键：所有装饰 Mesh 都登记到 comp 0（core），随主舰体一起做损伤变色，
// 因此不会破坏"按组件下标映射 Mesh"的渲染契约；组件数量依旧稳定。
function addVariantDecorations(
  group: THREE.Group,
  parts: Map<number, THREE.Mesh[]>,
  team: Team,
  cls: ShipClass,
  variant: ShipVariant
): void {
  if (variant === 'standard') return;
  const mAccent = makeMaterial(team, 'accent');
  const mDetail = makeMaterial(team, 'detail');
  const mArmor = makeMaterial(team, 'armor');
  const mWeapon = makeMaterial(team, 'weapon');
  const mTurret = makeMaterial(team, 'turret');
  const mSensor = makeMaterial(team, 'sensor');

  const decor = (
    name: string,
    geo: THREE.BufferGeometry,
    mat: THREE.MeshStandardMaterial,
    pos: [number, number, number],
    rot?: [number, number, number]
  ) => addMesh(group, parts, { name, geo, mat, pos, comp: 0, rot });

  if (cls === 'Fighter') {
    if (variant === 'bomber') {
      // 机腹重型炸弹挂架
      decor('variant-bomber-pod', new THREE.BoxGeometry(0.9, 0.3, 0.5), mDetail, [-0.1, -0.2, 0]);
    } else if (variant === 'scout') {
      // 顶部传感天线 + 探测球
      decor('variant-scout-rod', new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), mSensor, [0, 0.6, 0]);
      decor('variant-scout-dish', new THREE.SphereGeometry(0.13, 8, 8), mSensor, [0, 0.95, 0]);
    } else if (variant === 'interceptor') {
      // 后掠高垂尾
      decor('variant-interceptor-fin', new THREE.BoxGeometry(0.5, 0.5, 0.06), mAccent, [-1.0, 0.18, 0], [0, 0, 0.4]);
    }
  } else if (cls === 'Frigate') {
    if (variant === 'escort') {
      // 两舷点防御小炮
      decor('variant-escort-pd-l', new THREE.BoxGeometry(0.3, 0.2, 0.3), mWeapon, [0.6, 0.5, -1.4]);
      decor('variant-escort-pd-r', new THREE.BoxGeometry(0.3, 0.2, 0.3), mWeapon, [0.6, 0.5, 1.4]);
    } else if (variant === 'artillery') {
      // 主炮加长炮管
      decor('variant-artillery-barrel', new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8), mWeapon, [3.1, 0.6, 0], [0, 0, -Math.PI / 2]);
    } else if (variant === 'support') {
      // 护盾发生器（发光球）
      decor('variant-support-emit', new THREE.SphereGeometry(0.18, 10, 10), mSensor, [-1.2, 0.55, 0]);
    }
  } else if (cls === 'Cruiser') {
    if (variant === 'battleship') {
      // 顶部副炮塔 + 长管
      decor('variant-battleship-turret', new THREE.BoxGeometry(0.7, 0.3, 0.7), mTurret, [1.2, 1.0, 0]);
      decor('variant-battleship-barrel', new THREE.CylinderGeometry(0.1, 0.1, 1.2, 8), mWeapon, [2.0, 1.05, 0], [0, 0, -Math.PI / 2]);
    } else if (variant === 'carrier') {
      // 飞行甲板凸起 + 弹射口
      decor('variant-carrier-deck', new THREE.BoxGeometry(1.6, 0.3, 1.2), mDetail, [-1.0, 1.0, 0]);
      decor('variant-carrier-bay', new THREE.BoxGeometry(0.5, 0.2, 0.9), mTurret, [-1.6, 0.6, 0]);
    } else if (variant === 'fortress') {
      // 额外侧装甲板
      decor('variant-fortress-armor-l', new THREE.BoxGeometry(0.5, 1.0, 2.6), mArmor, [0.2, 0.1, -2.15]);
      decor('variant-fortress-armor-r', new THREE.BoxGeometry(0.5, 1.0, 2.6), mArmor, [0.2, 0.1, 2.15]);
    }
  }
}

// ======================== Fighter 小型战斗机 ========================
// 设计：箭头形高速截击机。尖锐机头、后掠三角翼、双尾引擎、机首激光、顶部传感器。
// 正面 +X，局部尺寸约 3.6(长) × 2.6(宽) × 0.9(高)。
// 组件映射：0=core(hull/nose/wings/canopy) 1=engine(双引擎) 2=weapon(激光) 3=sensor
function buildFighter(team: Team, parts: Map<number, THREE.Mesh[]>, variant: ShipVariant = 'standard'): THREE.Group {
  const group = new THREE.Group();
  const mHull = makeMaterial(team, 'hull');
  const mArmor = makeMaterial(team, 'armor');
  const mEngine = makeMaterial(team, 'engine');
  const mGlow = makeMaterial(team, 'engineGlow');
  const mWeapon = makeMaterial(team, 'weapon');
  const mSensor = makeMaterial(team, 'sensor');
  const mAccent = makeMaterial(team, 'accent');

  // --- core (idx 0): 主舰体 + 机头 + 机翼 + 座舱 ---
  addMesh(group, parts, {
    name: 'hull',
    geo: new THREE.BoxGeometry(1.9, 0.4, 0.6),
    mat: mHull,
    pos: [0, 0, 0],
    comp: 0
  });
  // 机头：尖锐锥体朝 +X
  addMesh(group, parts, {
    name: 'nose',
    geo: new THREE.ConeGeometry(0.3, 1.3, 10),
    mat: mHull,
    pos: [1.6, 0, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 0
  });
  // 座舱（轻微发光，增强辨识）
  addMesh(group, parts, {
    name: 'canopy',
    geo: new THREE.SphereGeometry(0.22, 10, 8),
    mat: mAccent,
    pos: [0.2, 0.22, 0],
    comp: 0
  });
  // 左翼：后掠扁平三角翼
  addMesh(group, parts, {
    name: 'left-wing',
    geo: new THREE.BoxGeometry(1.2, 0.07, 0.9),
    mat: mArmor,
    pos: [-0.35, 0, -0.7],
    rot: [0, 0.5, 0],
    comp: 0
  });
  // 右翼
  addMesh(group, parts, {
    name: 'right-wing',
    geo: new THREE.BoxGeometry(1.2, 0.07, 0.9),
    mat: mArmor,
    pos: [-0.35, 0, 0.7],
    rot: [0, -0.5, 0],
    comp: 0
  });
  // 翼尖导航灯
  addMesh(group, parts, {
    name: 'left-wing-light',
    geo: new THREE.SphereGeometry(0.06, 6, 6),
    mat: mAccent,
    pos: [-0.9, 0, -1.1],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'right-wing-light',
    geo: new THREE.SphereGeometry(0.06, 6, 6),
    mat: mAccent,
    pos: [-0.9, 0, 1.1],
    comp: 0
  });

  // --- engine (idx 1): 双尾引擎 + 尾焰 ---
  addMesh(group, parts, {
    name: 'engine-left',
    geo: new THREE.CylinderGeometry(0.15, 0.2, 0.7, 10),
    mat: mEngine,
    pos: [-1.15, -0.02, -0.28],
    rot: [0, 0, -Math.PI / 2],
    comp: 1
  });
  addMesh(group, parts, {
    name: 'engine-right',
    geo: new THREE.CylinderGeometry(0.15, 0.2, 0.7, 10),
    mat: mEngine,
    pos: [-1.15, -0.02, 0.28],
    rot: [0, 0, -Math.PI / 2],
    comp: 1
  });
  addMesh(group, parts, {
    name: 'engine-glow-left',
    geo: new THREE.SphereGeometry(0.14, 8, 8),
    mat: mGlow,
    pos: [-1.55, -0.02, -0.28],
    glow: true,
    comp: 1
  });
  addMesh(group, parts, {
    name: 'engine-glow-right',
    geo: new THREE.SphereGeometry(0.14, 8, 8),
    mat: mGlow,
    pos: [-1.55, -0.02, 0.28],
    glow: true,
    comp: 1
  });

  // --- weapon (idx 2): 机首激光炮 ---
  addMesh(group, parts, {
    name: 'turret-front',
    geo: new THREE.BoxGeometry(0.25, 0.18, 0.18),
    mat: mArmor,
    pos: [0.85, 0.14, 0],
    comp: 2
  });
  addMesh(group, parts, {
    name: 'cannon-barrel',
    geo: new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8),
    mat: mWeapon,
    pos: [1.55, 0.14, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 2
  });

  // --- sensor (idx 3): 顶部传感器 ---
  addMesh(group, parts, {
    name: 'sensor',
    geo: new THREE.SphereGeometry(0.13, 8, 8),
    mat: mSensor,
    pos: [0, 0.3, 0],
    comp: 3
  });

  addVariantDecorations(group, parts, team, 'Fighter', variant);
  return group;
}

// ======================== Frigate 护卫舰 ========================
// 设计：细长楔形舰身，前窄后宽。前方主炮、左右舷炮塔、舰桥传感器、双引擎。
// 正面 +X，局部尺寸约 5.6(长) × 3.2(宽) × 1.7(高)。
// 组件映射：0=core 1=engine-L 2=engine-R 3=weapon-front 4=weapon-L 5=weapon-R 6=sensor 7=shield(含侧装甲)
function buildFrigate(team: Team, parts: Map<number, THREE.Mesh[]>, variant: ShipVariant = 'standard'): THREE.Group {
  const group = new THREE.Group();
  const mHull = makeMaterial(team, 'hull');
  const mArmor = makeMaterial(team, 'armor');
  const mTurret = makeMaterial(team, 'turret');
  const mWeapon = makeMaterial(team, 'weapon');
  const mEngine = makeMaterial(team, 'engine');
  const mGlow = makeMaterial(team, 'engineGlow');
  const mBridge = makeMaterial(team, 'bridge');
  const mSensor = makeMaterial(team, 'sensor');
  const mShield = makeMaterial(team, 'accent');
  const mDetail = makeMaterial(team, 'detail');

  // --- core (idx 0): 主舰体 + 舰首 + 甲板 + 下层 ---
  addMesh(group, parts, {
    name: 'hull',
    geo: new THREE.BoxGeometry(3.0, 0.7, 1.3),
    mat: mHull,
    pos: [-0.2, 0, 0],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'hull-front',
    geo: new THREE.BoxGeometry(1.6, 0.55, 0.85),
    mat: mHull,
    pos: [2.0, 0.02, 0],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'nose',
    geo: new THREE.ConeGeometry(0.42, 1.3, 8),
    mat: mHull,
    pos: [3.4, 0.02, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 0
  });
  // 上层甲板（细节，归 core）
  addMesh(group, parts, {
    name: 'deck',
    geo: new THREE.BoxGeometry(2.0, 0.25, 0.9),
    mat: mDetail,
    pos: [-0.2, 0.42, 0],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'lower-hull',
    geo: new THREE.BoxGeometry(2.6, 0.4, 1.0),
    mat: mDetail,
    pos: [-0.4, -0.45, 0],
    comp: 0
  });

  // --- engine (idx 1): 左引擎 ---
  addMesh(group, parts, {
    name: 'engine-left',
    geo: new THREE.CylinderGeometry(0.26, 0.36, 1.0, 12),
    mat: mEngine,
    pos: [-2.2, 0, -0.5],
    rot: [0, 0, -Math.PI / 2],
    comp: 1
  });
  addMesh(group, parts, {
    name: 'engine-glow-left',
    geo: new THREE.SphereGeometry(0.22, 10, 10),
    mat: mGlow,
    pos: [-2.8, 0, -0.5],
    glow: true,
    comp: 1
  });

  // --- engine (idx 2): 右引擎 ---
  addMesh(group, parts, {
    name: 'engine-right',
    geo: new THREE.CylinderGeometry(0.26, 0.36, 1.0, 12),
    mat: mEngine,
    pos: [-2.2, 0, 0.5],
    rot: [0, 0, -Math.PI / 2],
    comp: 2
  });
  addMesh(group, parts, {
    name: 'engine-glow-right',
    geo: new THREE.SphereGeometry(0.22, 10, 10),
    mat: mGlow,
    pos: [-2.8, 0, 0.5],
    glow: true,
    comp: 2
  });

  // --- weapon (idx 3): 前方主炮 ---
  addMesh(group, parts, {
    name: 'turret-front',
    geo: new THREE.BoxGeometry(0.8, 0.4, 0.8),
    mat: mTurret,
    pos: [1.5, 0.55, 0],
    comp: 3
  });
  addMesh(group, parts, {
    name: 'turret-front-barrel',
    geo: new THREE.CylinderGeometry(0.1, 0.1, 1.5, 8),
    mat: mWeapon,
    pos: [2.7, 0.6, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 3
  });

  // --- weapon (idx 4): 左舷炮（炮管指向 -Z） ---
  addMesh(group, parts, {
    name: 'turret-left',
    geo: new THREE.BoxGeometry(0.5, 0.28, 0.5),
    mat: mTurret,
    pos: [0.2, 0.42, -1.0],
    comp: 4
  });
  addMesh(group, parts, {
    name: 'turret-left-barrel',
    geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6),
    mat: mWeapon,
    pos: [0.2, 0.48, -1.4],
    rot: [-Math.PI / 2, 0, 0],
    comp: 4
  });

  // --- weapon (idx 5): 右舷炮（炮管指向 +Z） ---
  addMesh(group, parts, {
    name: 'turret-right',
    geo: new THREE.BoxGeometry(0.5, 0.28, 0.5),
    mat: mTurret,
    pos: [0.2, 0.42, 1.0],
    comp: 5
  });
  addMesh(group, parts, {
    name: 'turret-right-barrel',
    geo: new THREE.CylinderGeometry(0.07, 0.07, 0.8, 6),
    mat: mWeapon,
    pos: [0.2, 0.48, 1.4],
    rot: [Math.PI / 2, 0, 0],
    comp: 5
  });

  // --- sensor (idx 6): 舰桥 + 传感器 ---
  addMesh(group, parts, {
    name: 'bridge',
    geo: new THREE.BoxGeometry(1.0, 0.55, 0.9),
    mat: mBridge,
    pos: [-0.5, 0.65, 0],
    comp: 6
  });
  addMesh(group, parts, {
    name: 'sensor',
    geo: new THREE.SphereGeometry(0.2, 10, 10),
    mat: mSensor,
    pos: [-0.5, 1.05, 0],
    comp: 6
  });

  // --- shield (idx 7): 侧装甲板 + 护盾发生器（Frigate 仅有 shield 组件） ---
  addMesh(group, parts, {
    name: 'armor-left',
    geo: new THREE.BoxGeometry(0.2, 0.65, 2.4),
    mat: mArmor,
    pos: [-0.4, 0, -1.0],
    comp: 7
  });
  addMesh(group, parts, {
    name: 'armor-right',
    geo: new THREE.BoxGeometry(0.2, 0.65, 2.4),
    mat: mArmor,
    pos: [-0.4, 0, 1.0],
    comp: 7
  });
  addMesh(group, parts, {
    name: 'shield-generator',
    geo: new THREE.SphereGeometry(0.16, 8, 8),
    mat: mShield,
    pos: [-1.2, 0.2, 0],
    comp: 7
  });

  addVariantDecorations(group, parts, team, 'Frigate', variant);
  return group;
}

// ======================== Cruiser 巡洋舰 ========================
// 设计：大型主力舰。厚重分层舰体、多炮塔（前方双联主炮 + 左右舷炮）、
// 三引擎阵列、舰桥、双传感器、护盾发生器、重型侧装甲。
// 正面 +X，局部尺寸约 8.2(长) × 5.4(宽) × 2.8(高)。
// 组件映射：0=core 1=eng-L 2=eng-C 3=eng-R 4=wpn-front 5=wpn-L 6=wpn-R
//           7=sensor-L(bridge) 8=sensor-R(radar) 9=shield-L 10=shield-R 11=armor-L 12=armor-R
function buildCruiser(team: Team, parts: Map<number, THREE.Mesh[]>, variant: ShipVariant = 'standard'): THREE.Group {
  const group = new THREE.Group();
  const mHull = makeMaterial(team, 'hull');
  const mArmor = makeMaterial(team, 'armor');
  const mTurret = makeMaterial(team, 'turret');
  const mWeapon = makeMaterial(team, 'weapon');
  const mEngine = makeMaterial(team, 'engine');
  const mGlow = makeMaterial(team, 'engineGlow');
  const mBridge = makeMaterial(team, 'bridge');
  const mSensor = makeMaterial(team, 'sensor');
  const mShield = makeMaterial(team, 'accent');
  const mDetail = makeMaterial(team, 'detail');

  // --- core (idx 0): 主舰体 + 下层 + 前段 + 舰首 ---
  addMesh(group, parts, {
    name: 'hull',
    geo: new THREE.BoxGeometry(5.0, 1.2, 2.8),
    mat: mHull,
    pos: [0, 0, 0],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'lower-hull',
    geo: new THREE.BoxGeometry(4.0, 0.6, 2.2),
    mat: mDetail,
    pos: [0, -0.8, 0],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'hull-front',
    geo: new THREE.BoxGeometry(2.0, 1.0, 2.0),
    mat: mHull,
    pos: [3.3, 0.05, 0],
    comp: 0
  });
  addMesh(group, parts, {
    name: 'nose',
    geo: new THREE.ConeGeometry(0.8, 1.6, 8),
    mat: mHull,
    pos: [4.9, 0.05, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 0
  });

  // --- engine (idx 1): 左引擎 ---
  addMesh(group, parts, {
    name: 'engine-left',
    geo: new THREE.CylinderGeometry(0.4, 0.56, 1.3, 12),
    mat: mEngine,
    pos: [-3.1, 0, -1.0],
    rot: [0, 0, -Math.PI / 2],
    comp: 1
  });
  addMesh(group, parts, {
    name: 'engine-glow-left',
    geo: new THREE.SphereGeometry(0.3, 10, 10),
    mat: mGlow,
    pos: [-3.9, 0, -1.0],
    glow: true,
    comp: 1
  });

  // --- engine (idx 2): 中引擎 ---
  addMesh(group, parts, {
    name: 'engine-center',
    geo: new THREE.CylinderGeometry(0.48, 0.66, 1.3, 12),
    mat: mEngine,
    pos: [-3.1, 0, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 2
  });
  addMesh(group, parts, {
    name: 'engine-glow-center',
    geo: new THREE.SphereGeometry(0.36, 12, 12),
    mat: mGlow,
    pos: [-3.9, 0, 0],
    glow: true,
    comp: 2
  });

  // --- engine (idx 3): 右引擎 ---
  addMesh(group, parts, {
    name: 'engine-right',
    geo: new THREE.CylinderGeometry(0.4, 0.56, 1.3, 12),
    mat: mEngine,
    pos: [-3.1, 0, 1.0],
    rot: [0, 0, -Math.PI / 2],
    comp: 3
  });
  addMesh(group, parts, {
    name: 'engine-glow-right',
    geo: new THREE.SphereGeometry(0.3, 10, 10),
    mat: mGlow,
    pos: [-3.9, 0, 1.0],
    glow: true,
    comp: 3
  });

  // --- weapon (idx 4): 前方双联主炮 ---
  addMesh(group, parts, {
    name: 'turret-front',
    geo: new THREE.BoxGeometry(1.2, 0.5, 1.2),
    mat: mTurret,
    pos: [2.0, 0.85, 0],
    comp: 4
  });
  addMesh(group, parts, {
    name: 'turret-front-barrel-l',
    geo: new THREE.CylinderGeometry(0.13, 0.13, 1.9, 8),
    mat: mWeapon,
    pos: [3.5, 0.95, -0.32],
    rot: [0, 0, -Math.PI / 2],
    comp: 4
  });
  addMesh(group, parts, {
    name: 'turret-front-barrel-r',
    geo: new THREE.CylinderGeometry(0.13, 0.13, 1.9, 8),
    mat: mWeapon,
    pos: [3.5, 0.95, 0.32],
    rot: [0, 0, -Math.PI / 2],
    comp: 4
  });

  // --- weapon (idx 5): 左舷炮塔（炮管 -Z） ---
  addMesh(group, parts, {
    name: 'turret-left',
    geo: new THREE.BoxGeometry(0.75, 0.38, 0.75),
    mat: mTurret,
    pos: [0.5, 0.8, -1.7],
    comp: 5
  });
  addMesh(group, parts, {
    name: 'turret-left-barrel',
    geo: new THREE.CylinderGeometry(0.1, 0.1, 1.0, 6),
    mat: mWeapon,
    pos: [0.5, 0.9, -2.2],
    rot: [-Math.PI / 2, 0, 0],
    comp: 5
  });

  // --- weapon (idx 6): 右舷炮塔（炮管 +Z） ---
  addMesh(group, parts, {
    name: 'turret-right',
    geo: new THREE.BoxGeometry(0.75, 0.38, 0.75),
    mat: mTurret,
    pos: [0.5, 0.8, 1.7],
    comp: 6
  });
  addMesh(group, parts, {
    name: 'turret-right-barrel',
    geo: new THREE.CylinderGeometry(0.1, 0.1, 1.0, 6),
    mat: mWeapon,
    pos: [0.5, 0.9, 2.2],
    rot: [Math.PI / 2, 0, 0],
    comp: 6
  });

  // --- weapon (idx 13): 顶部炮塔（近全向 turret 武器，体现多炮塔优势） ---
  addMesh(group, parts, {
    name: 'turret-top',
    geo: new THREE.BoxGeometry(0.9, 0.5, 0.9),
    mat: mTurret,
    pos: [-0.6, 1.9, 0],
    comp: 13
  });
  addMesh(group, parts, {
    name: 'turret-top-barrel',
    geo: new THREE.CylinderGeometry(0.12, 0.12, 1.3, 8),
    mat: mWeapon,
    pos: [0.3, 2.4, 0],
    rot: [0, 0, -Math.PI / 2],
    comp: 13
  });

  // --- sensor (idx 7): 舰桥 + 左传感器 ---
  addMesh(group, parts, {
    name: 'bridge',
    geo: new THREE.BoxGeometry(1.5, 0.85, 1.5),
    mat: mBridge,
    pos: [0.4, 1.05, 0],
    comp: 7
  });
  addMesh(group, parts, {
    name: 'bridge-top',
    geo: new THREE.BoxGeometry(0.9, 0.45, 0.9),
    mat: mBridge,
    pos: [0.4, 1.6, 0],
    comp: 7
  });
  addMesh(group, parts, {
    name: 'sensor-left',
    geo: new THREE.SphereGeometry(0.22, 10, 10),
    mat: mSensor,
    pos: [0.4, 2.0, -0.45],
    comp: 7
  });

  // --- sensor (idx 8): 右传感器 + 雷达天线 ---
  addMesh(group, parts, {
    name: 'sensor-right',
    geo: new THREE.SphereGeometry(0.22, 10, 10),
    mat: mSensor,
    pos: [0.4, 2.0, 0.45],
    comp: 8
  });
  addMesh(group, parts, {
    name: 'radar-antenna',
    geo: new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6),
    mat: mDetail,
    pos: [-0.6, 1.4, 0],
    comp: 8
  });
  addMesh(group, parts, {
    name: 'radar-dish',
    geo: new THREE.ConeGeometry(0.22, 0.18, 10),
    mat: mSensor,
    pos: [-0.6, 1.8, 0],
    comp: 8
  });

  // --- shield (idx 9): 左护盾发生器 ---
  addMesh(group, parts, {
    name: 'shield-left',
    geo: new THREE.BoxGeometry(0.35, 0.75, 1.6),
    mat: mShield,
    pos: [-1.6, 0.25, -1.4],
    comp: 9
  });

  // --- shield (idx 10): 右护盾发生器 ---
  addMesh(group, parts, {
    name: 'shield-right',
    geo: new THREE.BoxGeometry(0.35, 0.75, 1.6),
    mat: mShield,
    pos: [-1.6, 0.25, 1.4],
    comp: 10
  });

  // --- armor (idx 11): 左重型装甲 ---
  addMesh(group, parts, {
    name: 'armor-left',
    geo: new THREE.BoxGeometry(0.45, 1.35, 3.2),
    mat: mArmor,
    pos: [0, 0.05, -1.85],
    comp: 11
  });

  // --- armor (idx 12): 右重型装甲 ---
  addMesh(group, parts, {
    name: 'armor-right',
    geo: new THREE.BoxGeometry(0.45, 1.35, 3.2),
    mat: mArmor,
    pos: [0, 0.05, 1.85],
    comp: 12
  });

  addVariantDecorations(group, parts, team, 'Cruiser', variant);
  return group;
}

// ======================== 公共 API =====================

export interface ShipVisual {
  group: THREE.Group;
  /** 组件下标 → 属于该组件的所有 Mesh（用于批量更新损伤颜色） */
  parts: Map<number, THREE.Mesh[]>;
  /** 引擎尾焰网格引用（用于按引擎 HP 调整亮度/缩放/闪烁） */
  glows: { comp: number; mesh: THREE.Mesh; baseIntensity: number }[];
}

/** 由 ShipDef 构建飞船可视化（供 ThreeScene 使用） */
export function buildShipVisual(
  def: ShipDef,
  team: Team,
  variant: ShipVariant = 'standard',
  shipId = -1
): ShipVisual {
  const parts = new Map<number, THREE.Mesh[]>();
  let group: THREE.Group;

  switch (def.type) {
    case 'Fighter':
      group = buildFighter(team, parts, variant);
      break;
    case 'Frigate':
      group = buildFrigate(team, parts, variant);
      break;
    case 'Cruiser':
      group = buildCruiser(team, parts, variant);
      break;
    default:
      group = new THREE.Group();
  }

  group.scale.setScalar(def.scale);

  // 写入可回溯的标识：被点击的 Mesh 可经 parent 链找到所属 shipId / team / 舰种 / 改型
  group.userData.shipId = shipId;
  group.userData.team = team;
  group.userData.shipClass = def.type;
  group.userData.variant = variant;

  // 收集所有引擎尾焰引用
  const glows: ShipVisual['glows'] = [];
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.userData && mesh.userData.isGlow) {
      glows.push({
        comp: mesh.userData.componentIndex as number,
        mesh,
        baseIntensity: (mesh.userData.baseEmissiveIntensity as number) ?? GLOW_BASE_INTENSITY
      });
    }
  });

  return { group, parts, glows };
}

/**
 * 创建飞船网格（公共 API）。
 *
 * @param shipType        飞船类型
 * @param team            阵营（'A' 冷色蓝 / 'B' 暖色红）
 * @param componentHpRatios 可选的组件 HP 比例映射（组件下标字符串 → 0~1）。
 *                          未提供时所有组件为满 HP 状态。兼容旧调用。
 * @param variant         改型。
 */
export function createShipMesh(
  shipType: ShipTypeName,
  team: Team,
  componentHpRatios?: Record<string, number>,
  variant: ShipVariant = 'standard'
): THREE.Group {
  const parts = new Map<number, THREE.Mesh[]>();
  let group: THREE.Group;

  switch (shipType) {
    case 'Fighter':
      group = buildFighter(team, parts, variant);
      break;
    case 'Frigate':
      group = buildFrigate(team, parts, variant);
      break;
    case 'Cruiser':
      group = buildCruiser(team, parts, variant);
      break;
    default:
      group = new THREE.Group();
  }

  // 如果提供了组件 HP 比例，立即应用损伤外观
  if (componentHpRatios) {
    for (const [idx, meshes] of parts) {
      const hpRatio = componentHpRatios[String(idx)] ?? 1;
      const destroyed = hpRatio <= 0;
      for (const mesh of meshes) {
        applyDamageToMesh(mesh, hpRatio, destroyed);
      }
    }
  }

  return group;
}
