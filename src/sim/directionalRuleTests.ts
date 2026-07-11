// 定向规则测试（黄金测试类别 B）：构造固定 BattleState，从四个方位连续攻击，
// 验证方向命中模型的确定性行为（同 seed 结果完全一致），并验证关键性质：
//  - 后方攻击优先命中引擎（rear.engine > front.engine）
//  - 左侧攻击优先命中左侧装甲（不会命中右侧装甲）
//  - 右侧攻击优先命中右侧装甲（不会命中左侧装甲）
// 纯 sim，无渲染 / DOM。由 runAcceptanceTests 汇总。

import { createPRNG } from './prng';
import { createInitialState } from './rulesets';
import { applyDamageV4 } from './simulatorV4';
import { ReplayConfig, Ship, BattleState, ComponentTypeName, HitZone } from './battleTypes';
import { runSuite, Case, SuiteResult } from './testHarness';

const COMP_TYPES: ComponentTypeName[] = ['core', 'engine', 'weapon', 'armor', 'sensor', 'shield'];

interface DirCounts {
  comp: Record<string, number>;
  leftArmor: number;
  rightArmor: number;
}
type MeasureResult = Record<'front' | 'rear' | 'left' | 'right', DirCounts>;

function freshTarget(variant: string): { state: BattleState; target: Ship } {
  const rng = createPRNG(1);
  const cfg: ReplayConfig = {
    v: '0.5',
    ruleset: 'spacewar-core-v4',
    seed: 1,
    budget: { mode: 'unlimited', limit: 999999 },
    teamA: { fleet: [{ shipClass: 'Cruiser', variant: variant as any, count: 1 }], formation: 'line', doctrine: 'balanced' },
    teamB: { fleet: [{ shipClass: 'Fighter', variant: 'standard', count: 1 }], formation: 'line', doctrine: 'balanced' }
  };
  const state = createInitialState(cfg, rng);
  const target = state.ships.find((s) => s.team === 'A')!;
  target.pos = { x: 0, y: 0, z: 0 };
  target.heading = 0;
  target.shield = 0;
  return { state, target };
}

const DIRS: Record<'front' | 'rear' | 'left' | 'right', { x: number; y: number; z: number }> = {
  front: { x: 10, y: 0, z: 0 },
  rear: { x: -10, y: 0, z: 0 },
  left: { x: 0, y: 0, z: -10 },
  right: { x: 0, y: 0, z: 10 }
};

function measure(seed: number, variant = 'standard', N = 400): MeasureResult {
  const { state, target } = freshTarget(variant);
  const snap = target.components.map((c) => ({ hp: c.hp, destroyed: c.destroyed }));
  const reset = () => {
    target.components.forEach((c, i) => {
      c.hp = snap[i].hp;
      c.destroyed = snap[i].destroyed;
    });
    target.combatState = 'normal';
    target.alive = true;
    target.mobilityDisabled = false;
    target.weaponsDisabled = false;
    target.sensorsDisabled = false;
    target.shield = 0;
  };
  const rng = createPRNG(seed);
  const result: MeasureResult = {
    front: { comp: {}, leftArmor: 0, rightArmor: 0 },
    rear: { comp: {}, leftArmor: 0, rightArmor: 0 },
    left: { comp: {}, leftArmor: 0, rightArmor: 0 },
    right: { comp: {}, leftArmor: 0, rightArmor: 0 }
  };
  (Object.keys(DIRS) as (keyof typeof DIRS)[]).forEach((dir) => {
    for (let i = 0; i < N; i++) {
      reset();
      const res = applyDamageV4(state, target, 2, 'cannon', DIRS[dir], rng);
      if (!res) continue;
      result[dir].comp[res.compType] = (result[dir].comp[res.compType] ?? 0) + 1;
      if (res.compType === 'armor') {
        const hz = target.components[res.compIndex].def.hitZones;
        if (hz && hz.includes('left')) result[dir].leftArmor++;
        else if (hz && hz.includes('right')) result[dir].rightArmor++;
      }
    }
  });
  return result;
}

function equalMeasure(a: MeasureResult, b: MeasureResult): boolean {
  const keys = Object.keys(a) as (keyof typeof a)[];
  for (const k of keys) {
    for (const t of COMP_TYPES) {
      if ((a[k].comp[t] ?? 0) !== (b[k].comp[t] ?? 0)) return false;
    }
    if (a[k].leftArmor !== b[k].leftArmor) return false;
    if (a[k].rightArmor !== b[k].rightArmor) return false;
  }
  return true;
}

export function runDirectionalRuleTests(): SuiteResult {
  return runSuite('directionalRule', (add) => {
    const c = new Case('direction-hit-model');

    const m = measure(12345);
    const m2 = measure(12345);

    // 1. 确定性：相同 seed 两次测量结果完全一致
    c.true_(equalMeasure(m, m2), '相同 seed 的方向命中统计完全一致（确定性）');

    // 2. 后方攻击优先命中引擎（front 不会命中引擎，因为引擎仅在 rear 方位）
    c.true_((m.front.comp.engine ?? 0) === 0, '正面攻击不会命中引擎（引擎仅在 rear）');
    c.true_((m.rear.comp.engine ?? 0) > 0, '后方攻击命中引擎（>0）');
    c.true_(
      (m.rear.comp.engine ?? 0) > (m.front.comp.engine ?? 0),
      `后方引擎命中(${m.rear.comp.engine}) > 正面引擎命中(${m.front.comp.engine})`
    );

    // 3. 左侧攻击优先命中左侧装甲，绝不命中右侧装甲
    c.true_(m.left.leftArmor > 0, `左侧攻击命中左侧装甲（${m.left.leftArmor} 次）`);
    c.eq(m.left.rightArmor, 0, '左侧攻击不会命中右侧装甲（rightArmor=0）');

    // 4. 右侧攻击优先命中右侧装甲，绝不命中左侧装甲
    c.true_(m.right.rightArmor > 0, `右侧攻击命中右侧装甲（${m.right.rightArmor} 次）`);
    c.eq(m.right.leftArmor, 0, '右侧攻击不会命中左侧装甲（leftArmor=0）');

    // 5. 正面装甲保护核心（正面攻击命中的装甲应 > 0；但正面无装甲的 Fighter 不适用，这里 Cruiser 正面武器/装甲共存）
    c.true_(m.front.leftArmor === 0 && m.front.rightArmor === 0, '正面攻击不命中左右侧装甲（Cruiser 侧装甲仅在左右方位）');

    add(c);
  });
}
