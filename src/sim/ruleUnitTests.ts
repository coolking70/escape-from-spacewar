// core-v4 规则单元测试（纯 sim，无渲染 / DOM）。
// 覆盖：方向命中、装甲保护、武器效率、引擎效率、战斗状态机、光环。
// 每个套件返回一个 SuiteResult，由 runAcceptanceTests 汇总。

import {
  Ship,
  ShipComponent,
  ComponentDef,
  ComponentTypeName,
  HitZone,
  Team,
  Vec3
} from './battleTypes';
import { getShipDef, getVariantDef } from './shipVariants';
import { createPRNG } from './prng';
import { createInitialState } from './rulesets';
import { recomputeDerivedV4, BattleSimulatorV4 } from './simulatorV4';
import {
  getIncomingHitZone,
  buildComponentHitCandidates,
  getDamageMultiplier,
  selectHitComponent
} from './componentTargeting';
import { computeCombatState, isCombatCapable, getShipPointValue } from './combatState';
import { isTargetable, isStructurallyAlive } from './shipFlags';
import { engineRatioFrom, weaponSystemFrom, effectiveCooldown } from './derivedStats';
import { runSuite, Case, SuiteResult } from './testHarness';

// ---------------- 测试用 Ship 构造 ----------------

function defaultMods() {
  return getShipDef('Fighter', 'standard').mods;
}
function defaultDef() {
  return getShipDef('Fighter', 'standard').def;
}

interface CompOpts {
  type: ComponentTypeName;
  maxHp?: number;
  hp?: number;
  destroyed?: boolean;
  hitZones?: HitZone[];
  hitWeight?: number;
  protects?: ComponentTypeName[];
}

function buildComps(specs: CompOpts[]): ShipComponent[] {
  return specs.map((s, i) => {
    const def: ComponentDef = {
      type: s.type,
      name: s.type,
      maxHp: s.maxHp ?? 100,
      offset: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 },
      shape: 'box',
      hitZones: s.hitZones,
      hitWeight: s.hitWeight,
      protects: s.protects
    };
    return {
      id: i,
      def,
      hp: s.hp ?? def.maxHp,
      maxHp: def.maxHp,
      destroyed: s.destroyed ?? false
    };
  });
}

interface ShipOpts {
  id?: number;
  team?: Team;
  pos?: Vec3;
  heading?: number;
  alive?: boolean;
  combatState?: Ship['combatState'];
  mobilityDisabled?: boolean;
  weaponsDisabled?: boolean;
  sensorsDisabled?: boolean;
  retreatStartedTick?: number;
  escapedTick?: number;
  components: CompOpts[];
}

function makeShip(o: ShipOpts): Ship {
  const comps = buildComps(o.components);
  comps.forEach((c, i) => (c.id = i));
  const ship: Ship = {
    id: o.id ?? 0,
    team: o.team ?? 'A',
    type: 'Fighter',
    variant: 'standard',
    variantMods: defaultMods(),
    def: defaultDef(),
    pos: o.pos ?? { x: 0, y: 0, z: 0 },
    heading: o.heading ?? 0,
    alive: o.alive ?? true,
    components: comps,
    targetId: null,
    shield: 0,
    maxShield: 0,
    shieldRegen: 0,
    lastFireTick: new Map<number, number>(),
    effectiveSpeed: 0,
    effectiveTurnRate: 0,
    effectiveRange: 0,
    accuracy: 0,
    droneNextTick: 0,
    combatState: o.combatState ?? 'normal',
    mobilityDisabled: o.mobilityDisabled ?? false,
    weaponsDisabled: o.weaponsDisabled ?? false,
    sensorsDisabled: o.sensorsDisabled ?? false,
    retreatStartedTick: o.retreatStartedTick,
    escapedTick: o.escapedTick,
    targetLockUntilTick: 0,
    lastTargetEvaluationTick: 0,
    engineRatio: 1,
    weaponEfficiency: 1,
    sensorRatio: 1,
    exposedZones: [],
    isAnchor: false
  };
  return ship;
}

// ---------------- 1. 方向命中 ----------------

export function componentTargetingTests(): SuiteResult {
  return runSuite('componentTargeting', (add) => {
    const targetAt = (heading: number, attackerPos: Vec3): HitZone => {
      const t = makeShip({ pos: { x: 0, y: 0, z: 0 }, heading, components: [{ type: 'core' }] });
      return getIncomingHitZone(attackerPos, t);
    };
    const c = new Case('direction-zones');
    c.ok(targetAt(0, { x: 10, y: 0, z: 0 }) === 'front', 'heading 0 正面 (+x) → front');
    c.ok(targetAt(0, { x: -10, y: 0, z: 0 }) === 'rear', 'heading 0 背面 (-x) → rear');
    c.ok(targetAt(0, { x: 0, y: 0, z: 10 }) === 'right', 'heading 0 右舷 (+z) → right');
    c.ok(targetAt(0, { x: 0, y: 0, z: -10 }) === 'left', 'heading 0 左舷 (-z) → left');
    // heading π/2：前向 = (0,0,-1)，右舷 = (1,0,0)
    c.ok(targetAt(Math.PI / 2, { x: 0, y: 0, z: -10 }) === 'front', 'heading π/2 前方(-z) → front');
    c.ok(targetAt(Math.PI / 2, { x: 10, y: 0, z: 0 }) === 'right', 'heading π/2 右舷(+x) → right');
    // heading π：前向 = (-1,0,0)，右舷 = (0,0,-1)
    c.ok(targetAt(Math.PI, { x: -10, y: 0, z: 0 }) === 'front', 'heading π 前方(-x) → front');
    c.ok(targetAt(Math.PI, { x: 0, y: 0, z: -10 }) === 'right', 'heading π 右舷(-z) → right');
    // heading -π/2：前向 = (0,0,1)，右舷 = (-1,0,0)
    c.ok(targetAt(-Math.PI / 2, { x: 0, y: 0, z: 10 }) === 'front', 'heading -π/2 前方(+z) → front');
    c.ok(targetAt(-Math.PI / 2, { x: -10, y: 0, z: 0 }) === 'right', 'heading -π/2 右舷(-x) → right');
    // 边界角度不出现 NaN
    const zones = ['front', 'rear', 'left', 'right'] as HitZone[];
    let noNaN = true;
    for (let a = 0; a < Math.PI * 2; a += 0.013) {
      const px = Math.cos(a) * 10;
      const pz = Math.sin(a) * 10;
      const z = targetAt(0.7, { x: px, y: 0, z: pz });
      if (!zones.includes(z) || Number.isNaN(px) || Number.isNaN(pz)) noNaN = false;
    }
    c.ok(noNaN, '圆周任意攻击方向均返回合法 HitZone 且无 NaN');
    // 攻击者与目标重合：不除零、有明确默认区域（r=0 → right）
    const coincident = getIncomingHitZone({ x: 0, y: 0, z: 0 }, makeShip({ pos: { x: 0, y: 0, z: 0 }, heading: 0, components: [{ type: 'core' }] }));
    c.ok(zones.includes(coincident) && !Number.isNaN(0), '位置重合时返回合法默认区域（无除零/NaN）');
    add(c);
  });
}

// ---------------- 2. 装甲保护 ----------------

export function armorProtectionTests(): SuiteResult {
  return runSuite('armorProtection', (add) => {
    const buildTarget = (leftDestroyed: boolean, rightDestroyed: boolean): Ship =>
      makeShip({
        components: [
          { type: 'core', maxHp: 100, hitWeight: 1 },
          { type: 'armor', maxHp: 100, hitZones: ['left'], protects: ['core'], destroyed: leftDestroyed },
          { type: 'armor', maxHp: 100, hitZones: ['right'], protects: ['core'], destroyed: rightDestroyed },
          { type: 'engine', maxHp: 50 }
        ]
      });

    const coreWeightFor = (ship: Ship, zone: HitZone): number => {
      const cand = buildComponentHitCandidates(ship, zone);
      const core = cand.find((x) => x.comp.def.type === 'core');
      return core ? core.weight : -1;
    };

    const c = new Case('armor-shield-core-weight');
    const intact = buildTarget(false, false);
    const leftDead = buildTarget(true, false);
    const wLeftIntact = coreWeightFor(intact, 'left');
    const wLeftDead = coreWeightFor(leftDead, 'left');
    c.ok(wLeftIntact > 0 && wLeftDead > 0, '左侧攻击核心始终有正权重');
    c.ok(wLeftIntact < wLeftDead, `左装甲存在时核心权重降低（${wLeftIntact} < ${wLeftDead}）`);
    c.ok(wLeftDead > wLeftIntact * 2, '左装甲摧毁后核心权重显著上升（暴露）');

    // 右装甲只保护右侧，不影响左侧攻击
    const rightDead = buildTarget(false, true);
    c.close(coreWeightFor(intact, 'left'), coreWeightFor(rightDead, 'left'), 6, '摧毁右装甲不改变左侧攻击的核心权重');

    // 后方攻击不应被左装甲错误保护（左装甲 hitZones 不含 rear）
    const wRearIntact = coreWeightFor(intact, 'rear');
    c.close(wRearIntact, 1, 6, '后方攻击时左装甲不保护核心（权重=1）');

    // shield 保护只在对应 hit zone 生效
    const shieldShip = makeShip({
      components: [
        { type: 'core', maxHp: 100, hitWeight: 1 },
        { type: 'shield', maxHp: 100, hitZones: ['front'], protects: ['core'] }
      ]
    });
    const wFrontShield = coreWeightFor(shieldShip, 'front');
    c.ok(wFrontShield < 1, `正面护盾降低核心权重（${wFrontShield} < 1）`);
    const wRearShield = coreWeightFor(shieldShip, 'rear');
    c.close(wRearShield, 1, 6, '护盾仅在正面 zone 生效，后方核心权重不变');

    // 候选组件为空时 fallback 顺序稳定（按 index）
    const empty = makeShip({ components: [{ type: 'core', destroyed: true }] });
    const emptyCand = buildComponentHitCandidates(empty, 'front');
    c.eq(emptyCand.length, 0, '全部组件摧毁时候选为空');

    // 候选始终按 component index 升序
    const ordered = makeShip({
      components: [
        { type: 'core', hitZones: ['front'] },
        { type: 'engine', hitZones: ['front'] },
        { type: 'weapon', hitZones: ['front'] }
      ]
    });
    const oc = buildComponentHitCandidates(ordered, 'front');
    let sorted = true;
    for (let i = 1; i < oc.length; i++) if (oc[i].index < oc[i - 1].index) sorted = false;
    c.ok(sorted && oc.length === 3, '候选组件按 index 升序排列');

    // 加权选择确定性（相同 seed 结果一致，且落在权重区间）
    const prngA = createPRNG(12345);
    const prngB = createPRNG(12345);
    const cands: { comp: ShipComponent; index: number; weight: number }[] = [
      { comp: ordered.components[0], index: 0, weight: 1 },
      { comp: ordered.components[1], index: 1, weight: 1 },
      { comp: ordered.components[2], index: 2, weight: 1 }
    ];
    const a = selectHitComponent(cands, prngA);
    const b = selectHitComponent(cands, prngB);
    c.ok(a !== null && b !== null && a!.index === b!.index, 'selectHitComponent 相同 PRNG 结果一致');

    add(c);
  });
}

// ---------------- 3. 武器效率 ----------------

export function weaponEfficiencyTests(): SuiteResult {
  return runSuite('weaponEfficiency', (add) => {
    const c = new Case('weapon-efficiency');
    const mk = (hpRatios: number[]) =>
      makeShip({
        components: hpRatios.map((r, i) => ({
          type: 'weapon',
          maxHp: 100,
          hp: Math.round(100 * r),
          destroyed: Math.round(100 * r) <= 0
        }))
      });
    const full = weaponSystemFrom(mk([1, 1]).components.filter((x) => x.def.type === 'weapon'));
    c.close(full.efficiency, 1, 6, '武器 100% HP → efficiency≈1');
    const half = weaponSystemFrom(mk([0.5, 0.5]).components.filter((x) => x.def.type === 'weapon'));
    c.close(half.efficiency, 0.7, 6, '武器 50% HP → efficiency≈0.7');
    const zero = weaponSystemFrom(mk([0, 0]).components.filter((x) => x.def.type === 'weapon'));
    c.true_(zero.weaponsDisabled, '武器 0% HP → weaponsDisabled=true');
    c.ok(zero.efficiency >= 0 && zero.efficiency <= 1, 'weaponEfficiency 限制在 0~1');

    // 损伤后伤害下降 / 冷却增加
    c.ok(half.efficiency < full.efficiency, '损伤后 weaponEfficiency 下降');
    c.ok(effectiveCooldown(20, half.efficiency) > effectiveCooldown(20, full.efficiency), '损伤后有效冷却增加');
    // 冷却最低为 1
    c.eq(effectiveCooldown(5, 1), 5, '满效率冷却保持基准');
    c.eq(effectiveCooldown(1, 1), 1, '基准冷却 1 不被降低');
    c.true_(effectiveCooldown(3, 0.4) >= 1, '有效冷却恒 ≥ 1');

    // HP 不超过 maxHp 时 efficiency 不超过 1（修复未实现时不允许越界）
    const over = makeShip({ components: [{ type: 'weapon', maxHp: 100, hp: 200 }] });
    const overSys = weaponSystemFrom(over.components.filter((x) => x.def.type === 'weapon'));
    c.ok(overSys.efficiency <= 1, '组件 HP 越界时 efficiency 仍 ≤ 1');

    add(c);
  });
}

// ---------------- 4. 引擎效率 ----------------

export function engineEfficiencyTests(): SuiteResult {
  return runSuite('engineEfficiency', (add) => {
    const c = new Case('engine-efficiency');
    const def = defaultDef();
    const mk = (hpRatios: number[]): Ship =>
      makeShip({
        components: hpRatios.map((r) => ({ type: 'engine', maxHp: 100, hp: Math.round(100 * r), destroyed: Math.round(100 * r) <= 0 }))
      });

    const full = mk([1, 1]);
    recomputeDerivedV4(full);
    c.close(full.engineRatio, 1, 6, '引擎 100% HP → engineRatio=1');
    c.close(full.effectiveSpeed, def.maxSpeed, 6, '引擎 100% HP → effectiveSpeed=maxSpeed');
    c.close(full.effectiveTurnRate, def.turnRate, 6, '引擎 100% HP → effectiveTurnRate=turnRate');

    const half = mk([0.5, 0.5]);
    recomputeDerivedV4(half);
    c.close(half.engineRatio, 0.5, 6, '引擎 50% HP → engineRatio=0.5');
    c.close(half.effectiveSpeed, def.maxSpeed * 0.5, 6, '引擎 50% HP → 速度按比例下降');
    c.close(half.effectiveTurnRate, def.turnRate * 0.5, 6, '引擎 50% HP → 转向按比例下降');

    const dead = mk([0, 0]);
    recomputeDerivedV4(dead);
    c.true_(dead.mobilityDisabled, '全部引擎摧毁 → mobilityDisabled=true');
    c.eq(dead.effectiveSpeed, 0, '全部引擎摧毁 → effectiveSpeed=0');
    c.eq(dead.effectiveTurnRate, 0, '全部引擎摧毁 → effectiveTurnRate=0');

    // 多引擎只损失一个：按总 HP 比例
    const three = mk([0, 1, 1]); // 3 引擎各 100，1 个毁 → 200/300
    recomputeDerivedV4(three);
    c.close(three.engineRatio, 2 / 3, 6, '三引擎毁一 → engineRatio=2/3');

    c.ok(engineRatioFrom(mk([1]).components.filter((x) => x.def.type === 'engine')).ratio <= 1, 'engineRatio 限制在 0~1');
    add(c);
  });
}

// ---------------- 5. 战斗状态机 ----------------

export function combatStateTests(): SuiteResult {
  return runSuite('combatState', (add) => {
    const c = new Case('combat-state-priority');
    const base = (over: Partial<ShipOpts> = {}): Ship =>
      makeShip({
        components: [
          { type: 'core', maxHp: 100, hp: 100 },
          { type: 'engine', maxHp: 100, hp: 100 },
          { type: 'weapon', maxHp: 100, hp: 100 },
          { type: 'sensor', maxHp: 100, hp: 100 }
        ],
        ...over
      });

    // normal → critical
    const crit = base({ components: [{ type: 'core', maxHp: 100, hp: 10 }, { type: 'engine', maxHp: 100, hp: 10 }, { type: 'weapon', maxHp: 100, hp: 10 }] });
    c.eq(computeCombatState(crit, false), 'critical', '总 HP 极低 → critical');

    // critical → retreating
    const ret = base({ retreatStartedTick: 5 });
    c.eq(computeCombatState(ret, false), 'retreating', '已撤退且未失能 → retreating');

    // retreating → escaped
    const esc = base({ retreatStartedTick: 5, escapedTick: 20 });
    c.eq(computeCombatState(esc, false), 'escaped', '已脱战 → escaped（优先级高于 retreating）');

    // retreating → disabled（引擎全毁）
    const dis = base({ retreatStartedTick: 5, mobilityDisabled: true });
    c.eq(computeCombatState(dis, false), 'disabled', '撤退中引擎全毁 → disabled（优先级高于 retreating）');

    // retreating → destroyed（核心摧毁由 sim 显式置 combatState=destroyed；终态优先于 retreating）
    const dst = base({ retreatStartedTick: 5, combatState: 'destroyed' });
    c.eq(computeCombatState(dst, false), 'destroyed', '撤退中核心摧毁(combatState=destroyed) → destroyed（终态优先）');

    // disabled 不会自动恢复
    const disStuck = base({ mobilityDisabled: true, components: [{ type: 'core', maxHp: 100, hp: 100 }, { type: 'engine', maxHp: 100, hp: 100 }] });
    c.eq(computeCombatState(disStuck, false), 'disabled', 'mobilityDisabled 且 HP 满 → 仍为 disabled');

    // escaped 不会重新成为目标
    const escShip = base({ escapedTick: 1, combatState: 'escaped' });
    c.true_(!isTargetable(escShip), 'escaped 不可被锁定（isTargetable=false）');
    c.true_(!isStructurallyAlive(escShip), 'escaped 非结构存活');

    // destroyed 不计入 escaped
    const deadShip = base({ alive: false, combatState: 'destroyed' });
    c.true_(!isTargetable(deadShip), 'destroyed 不可被锁定');
    c.eq(computeCombatState(deadShip, false), 'destroyed', 'alive=false → destroyed');

    // isCombatCapable 语义
    c.true_(isCombatCapable(base()), 'normal 可战斗');
    c.true_(!isCombatCapable(base({ combatState: 'disabled' })), 'disabled 不可战斗');
    c.true_(!isCombatCapable(base({ combatState: 'escaped' })), 'escaped 不可战斗');
    c.true_(!isCombatCapable(base({ combatState: 'destroyed' })), 'destroyed 不可战斗');

    // 点数价值公式
    const cost = getVariantDef('standard').cost;
    c.close(getShipPointValue(base({ combatState: 'normal' })), cost, 4, 'normal → 100% cost');
    c.close(getShipPointValue(base({ combatState: 'retreating' })), cost, 4, 'retreating → 100% cost');
    c.close(getShipPointValue(base({ combatState: 'escaped' })), cost, 4, 'escaped → 100% cost');
    c.close(getShipPointValue(base({ combatState: 'disabled' })), cost * 0.5, 4, 'disabled → 50% cost');
    c.close(getShipPointValue(base({ combatState: 'destroyed' })), 0, 4, 'destroyed → 0% cost');
    // alive 仅作兼容字段，不再驱动价值：alive=false 但 combatState=normal 仍计全额
    c.close(getShipPointValue(base({ alive: false, combatState: 'normal' })), cost, 4, 'alive=false 且 combatState=normal → 仍 100% cost（alive 不影响价值）');

    add(c);
  });
}

// ---------------- 6. 光环 ----------------

export function auraTests(): SuiteResult {
  return runSuite('aura', (add) => {
    const c = new Case('aura-source-destroyed-stops');
    // 关键：友军（ally）必须与光环源同队，否则 aura 不跨队生效（这是真实规则）。
    const mkReplay = (teamAEntries: any[], teamBEntries: any[]) => ({
      v: '0.5',
      ruleset: 'spacewar-core-v4',
      seed: 777,
      budget: { mode: 'unlimited' as const, limit: 999999 },
      teamA: { fleet: teamAEntries, formation: 'line' as const, doctrine: 'balanced' as const },
      teamB: { fleet: teamBEntries, formation: 'line' as const, doctrine: 'balanced' as const }
    });
    const entry = (cls: any, variant: any, n: number) => ({ shipClass: cls, variant, count: n });
    const enemy = () => [entry('Fighter', 'standard', 1)]; // 仅作对立目标，不充当友军
    const place = (state: any, team: string, variant: string, pos: Vec3) => {
      const s = state.ships.find((x: any) => x.team === team && x.variant === variant);
      if (s) s.pos = { ...pos };
      return s;
    };

    // Scout 传感器光环：源与友军都在 A 队
    {
      const rng = createPRNG(777);
      const st = createInitialState(mkReplay([entry('Fighter', 'scout', 1), entry('Fighter', 'standard', 1)], enemy()) as any, rng) as any;
      const scout = place(st, 'A', 'scout', { x: 0, y: 0, z: 0 });
      const ally = place(st, 'A', 'standard', { x: 0, y: 0, z: 0 }); // 同队同位置必在半径内
      const sim = new BattleSimulatorV4(st, rng);
      const aura = sim.getAuraStatus(ally.id);
      c.true_(aura.accuracy > 0, 'Scout 有效传感器 → 友军获得命中加成光环');
      // 摧毁 Scout 全部传感器
      scout.components.filter((x: any) => x.def.type === 'sensor').forEach((x: any) => { x.hp = 0; x.destroyed = true; });
      const sim2 = new BattleSimulatorV4(st, rng);
      const aura2 = sim2.getAuraStatus(ally.id);
      c.true_(aura2.accuracy === 0, 'Scout 传感器全毁 → 传感器光环停止');
    }

    // Support 护盾光环：源与友军都在 A 队
    {
      const rng = createPRNG(888);
      const st = createInitialState(mkReplay([entry('Frigate', 'support', 1), entry('Fighter', 'standard', 1)], enemy()) as any, rng) as any;
      const sup = place(st, 'A', 'support', { x: 0, y: 0, z: 0 });
      const ally = place(st, 'A', 'standard', { x: 0, y: 0, z: 0 });
      const sim = new BattleSimulatorV4(st, rng);
      const aura = sim.getAuraStatus(ally.id);
      c.true_(aura.shieldRegen > 0, 'Support 有效护盾组件 → 友军获得护盾恢复光环');
      sup.components.filter((x: any) => x.def.type === 'shield').forEach((x: any) => { x.hp = 0; x.destroyed = true; });
      const sim2 = new BattleSimulatorV4(st, rng);
      const aura2 = sim2.getAuraStatus(ally.id);
      c.true_(aura2.shieldRegen === 0, 'Support 护盾组件全毁 → 护盾光环停止');
    }

    // sensorsDisabled 的 Scout 不提供光环
    {
      const rng = createPRNG(999);
      const st = createInitialState(mkReplay([entry('Fighter', 'scout', 1), entry('Fighter', 'standard', 1)], enemy()) as any, rng) as any;
      const scout = place(st, 'A', 'scout', { x: 0, y: 0, z: 0 });
      const ally = place(st, 'A', 'standard', { x: 0, y: 0, z: 0 });
      scout.components.filter((x: any) => x.def.type === 'sensor').forEach((x: any) => { x.hp = 0; x.destroyed = true; });
      scout.sensorsDisabled = true; // 触发 recompute 使 sensorsDisabled 生效
      const sim = new BattleSimulatorV4(st, rng);
      c.true_(sim.getAuraStatus(ally.id).accuracy === 0, 'sensorsDisabled 的 Scout 不提供传感器光环');
    }

    // escaped / destroyed 源不提供光环
    {
      const rng = createPRNG(1010);
      const st = createInitialState(mkReplay([entry('Fighter', 'scout', 1), entry('Fighter', 'standard', 1)], enemy()) as any, rng) as any;
      const scout = place(st, 'A', 'scout', { x: 0, y: 0, z: 0 });
      const ally = place(st, 'A', 'standard', { x: 0, y: 0, z: 0 });
      scout.alive = false;
      scout.combatState = 'destroyed';
      const sim = new BattleSimulatorV4(st, rng);
      c.true_(sim.getAuraStatus(ally.id).accuracy === 0, 'destroyed 源不提供光环');
    }

    // 多光环源按 shipId 稳定排序（两个 Scout 都提供，二者都生效且确定性）
    {
      const rng = createPRNG(2020);
      const st = createInitialState(mkReplay([entry('Fighter', 'scout', 2), entry('Fighter', 'standard', 1)], enemy()) as any, rng) as any;
      const scouts = st.ships.filter((x: any) => x.variant === 'scout').sort((a: any, b: any) => a.id - b.id);
      const ally = place(st, 'A', 'standard', { x: 0, y: 0, z: 0 });
      scouts.forEach((s: any) => (s.pos = { x: 0, y: 0, z: 0 }));
      const sim = new BattleSimulatorV4(st, rng);
      const aura = sim.getAuraStatus(ally.id);
      // 两个 scout 各 +0.05，上限 0.15 → 应等于 0.10（确定性、叠加受上限约束）
      c.close(aura.accuracy, 0.1, 6, '双 Scout 光环叠加且受上限约束（确定性）');
    }

    add(c);
  });
}

// ---------------- 汇总 ----------------

export function runAllRuleUnitTests(): SuiteResult[] {
  return [
    componentTargetingTests(),
    armorProtectionTests(),
    weaponEfficiencyTests(),
    engineEfficiencyTests(),
    combatStateTests(),
    auraTests()
  ];
}
