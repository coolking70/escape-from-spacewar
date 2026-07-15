// core-v4 模拟器：
//   - 方向命中模型（HitZone + 护盾/装甲保护 + 武器/引擎/传感器效率）
//   - 战斗状态机（normal/damaged/critical/disabled/retreating/escaped/destroyed）
//   - 确定性撤退系统（retreating → escaped，不触发爆炸）
//   - 战术深化（aggressive/defensive/kite/focusFire/antiCapital/screen）
//   - 轻量转向（separation / cohesion / anchor / lateral / retreat 力）
//   - 目标缓存（每 5 tick 重选）与光环缓存（每 5 tick 重算）
// 所有随机性来自 seed 派生的 PRNG；不读取渲染 / 真实时间 / 帧率。
// 相同 (config, ruleset, seed) 必得相同结果；缓存不影响确定性（护盾/引擎/传感器均按 shipId 稳定遍历）。

import {
  BattleState,
  Ship,
  Vec3,
  BattleEvent,
  BattleStepResult,
  DoctrineType,
  WeaponSpec,
  Team,
  CombatState,
  HitZone,
  DamageType,
  FormationType,
  ShipClass
} from './battleTypes';
import { PRNG } from './prng';
import { createInitialState as createStateV3 } from './battleState';
import { addDamage, addKill } from './battleStats';
import { ARENA, SPAWN } from './battleConfig';
import { RulesetId } from './rulesets';
import {
  getIncomingHitZone,
  buildComponentHitCandidates,
  selectHitComponent,
  getDamageMultiplier,
  weaponDamageType,
  hpRatio,
  WeightedCandidate
} from './componentTargeting';
import { computeCombatState, isCombatCapable, decideVictory } from './combatState';
import { isTargetable, isPresentOnBattlefield, isDestroyed } from './shipFlags';
import { engineRatioFrom, weaponSystemFrom, sensorSystemFrom } from './derivedStats';
import { shouldRetreat, DEFAULT_RETREAT_RULES, RetreatRules } from './retreatSystem';
import { computeSteering, desiredBand } from './movementSystem';

// ---------------- 向量 / 角度辅助（纯数学，无随机） ----------------

function dist2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(dist2(a, b));
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: 0, z: a.z - b.z };
}
function normXZ(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, y: 0, z: v.z / l };
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: 0, z: a.z + b.z };
}
function scaleVec(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}
function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function turnToward(cur: number, target: number, maxStep: number): number {
  const diff = wrapAngle(target - cur);
  if (Math.abs(diff) <= maxStep) return target;
  return cur + Math.sign(diff) * maxStep;
}

const AURA_ACC_CAP = 0.15;
const AURA_SHIELD_CAP = 2.0;
const ESCAPE_MARGIN = 12;
const CLOSE_ENEMY_RADIUS = 42;
const SEP_RADIUS: Record<string, number> = { Fighter: 7, Frigate: 11, Cruiser: 17 };
const MAX_CHASE: Record<string, number> = {
  balanced: 170,
  aggressive: 210,
  defensive: 120,
  kite: 200,
  focusFire: 185,
  antiCapital: 220,
  screen: 70
};
const ANCHOR_VARIANTS = new Set(['fortress', 'carrier', 'support']);

// ---------------- v4 初始状态 ----------------

export function createInitialStateV4(
  replay: Parameters<typeof createStateV3>[0],
  rng: PRNG,
  ruleset: RulesetId
): BattleState {
  const state = createStateV3(replay, rng);
  state.ruleset = ruleset;
  state.victoryReason = undefined;
  state.v4 = {
    hitFront: 0,
    hitLeft: 0,
    hitRight: 0,
    hitRear: 0,
    armorDamage: 0,
    coreDamage: 0,
    engineDamage: 0,
    weaponDamage: 0,
    sensorDamage: 0,
    shieldDamage: 0
  };
  for (const s of state.ships) {
    const doc = state.teamDoctrine[s.team];
    s.isAnchor = (doc === 'defensive' || doc === 'screen') && (s.type === 'Cruiser' || ANCHOR_VARIANTS.has(s.variant));
  }
  // 出生布局限制在各自半场，避免双方舰船在出生即交叉重叠。
  applyV4Spawn(state, replay);
  return state;
}

/** v4 出生布局：每队限制在 [homeEdge ± 不越中线] 的半场内，保留阵型形状但整体缩放以适配半场。 */
const V4_SPAWN_GAP = 10; // 最前排距中线的最小间隔
function sizeRank(t: ShipClass): number {
  return t === 'Fighter' ? 0 : t === 'Frigate' ? 1 : 2;
}
function applyV4Spawn(state: BattleState, replay: Parameters<typeof createStateV3>[0]): void {
  const layoutFor = (team: Team, formation: FormationType) => {
    const ships = state.ships.filter((s) => s.team === team);
    const n = ships.length;
    if (n === 0) return;
    const side = team === 'A' ? -1 : 1;
    const frontDir = team === 'A' ? 1 : -1;
    const baseX = side * SPAWN.x;
    const maxOffset = Math.max(0, SPAWN.x - V4_SPAWN_GAP); // A: x ∈ [-35, -10]
    const rank = (t: ShipClass) => sizeRank(t);
    const zAt = (k: number) => (k - (n - 1) / 2) * SPAWN.spacing;
    const yAt = (k: number) => ((k % 3) - 1) * SPAWN.yStep;
    const out: Vec3[] = new Array(n);

    if (formation === 'wedge') {
      const order = ships.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s.type) - rank(b.s.type));
      const total = Math.min((n - 1) * SPAWN.wedgeStep, maxOffset);
      const step = n > 1 ? total / (n - 1) : 0;
      order.forEach((o, k) => {
        out[o.i] = { x: baseX + frontDir * (k * step), y: yAt(k), z: zAt(k) };
      });
    } else if (formation === 'swarm') {
      for (let i = 0; i < n; i++) out[i] = { x: baseX, y: yAt(i), z: zAt(i) * SPAWN.swarmScale };
    } else {
      // line / wall / random：紧凑沿 z 展开，不向前突（不跨中线）
      for (let i = 0; i < n; i++) out[i] = { x: baseX, y: yAt(i), z: zAt(i) };
    }
    ships.forEach((s, i) => {
      s.pos = { ...out[i] };
    });
  };
  layoutFor('A', replay.teamA.formation);
  layoutFor('B', replay.teamB.formation);
}

// ---------------- 派生属性（v4：引擎/武器/传感器效率 + 装甲保护） ----------------

function hasIntact(ship: Ship, type: string): boolean {
  return ship.components.some((c) => c.def.type === type && !c.destroyed);
}

export function recomputeDerivedV4(ship: Ship): void {
  const def = ship.def;

  const eng = engineRatioFrom(ship.components.filter((c) => c.def.type === 'engine'));
  ship.engineRatio = eng.ratio;
  ship.mobilityDisabled = eng.mobilityDisabled;

  const wpn = weaponSystemFrom(ship.components.filter((c) => c.def.type === 'weapon'));
  ship.weaponEfficiency = wpn.efficiency;
  ship.weaponsDisabled = wpn.weaponsDisabled;

  const sen = sensorSystemFrom(ship.components.filter((c) => c.def.type === 'sensor'));
  ship.sensorRatio = sen.ratio;
  ship.sensorsDisabled = sen.sensorsDisabled;

  const shields = ship.components.filter((c) => c.def.type === 'shield');
  const intactShields = shields.filter((c) => !c.destroyed);
  ship.maxShield = intactShields.reduce((s, c) => s + c.maxHp, 0);
  ship.shieldRegen = ship.maxShield * 0.004;

  ship.effectiveSpeed = def.maxSpeed * eng.ratio;
  if (ship.mobilityDisabled) ship.effectiveSpeed = 0;
  // 引擎损伤同时降低转向能力（与速度同比例，全毁为 0）
  ship.effectiveTurnRate = ship.mobilityDisabled ? 0 : def.turnRate * eng.ratio;
  ship.effectiveRange = def.baseRange * (0.5 + 0.5 * sen.ratio);
  ship.accuracy = clamp(0.5 + 0.45 * sen.ratio, 0.05, 0.95);

  if (ship.shield > ship.maxShield) ship.shield = ship.maxShield;
}

// ---------------- 伤害结算（v4：方向 / 效率 / 装甲抗性） ----------------

interface V4DamageResult {
  compIndex: number;
  hpRatio: number;
  destroyed: boolean;
  oldHp: number;
  shipDestroyed: boolean;
  applied: number;
  shieldDamage: number;
  zone: HitZone;
  compType: string;
  breachedArmor: boolean;
}

export function applyDamageV4(
  state: BattleState,
  ship: Ship,
  baseDamage: number,
  dmgType: DamageType,
  attackerPos: Vec3,
  rng: PRNG
): V4DamageResult | null {
  let remaining = baseDamage;
  let absorbed = 0;

  if (ship.shield > 0) {
    absorbed = Math.min(ship.shield, remaining);
    ship.shield -= absorbed;
    remaining -= absorbed;
    if (state.v4) state.v4.shieldDamage += absorbed;
  }

  const fallback = (): WeightedCandidate[] => {
    // 方位过滤后为空时，退回全部未摧毁组件（仍按 index 升序）
    return ship.components
      .map((c, i) => ({ c, i }))
      .filter((x) => !x.c.destroyed)
      .sort((a, b) => a.i - b.i)
      .map((x) => ({ comp: x.c, index: x.i, weight: x.c.def.hitWeight ?? 1 }));
  };

  let result: V4DamageResult | null = null;
  let hullRemoved = 0;
  if (remaining > 0) {
    const zone = getIncomingHitZone(attackerPos, ship);
    if (state.v4) {
      if (zone === 'front') state.v4.hitFront++;
      else if (zone === 'left') state.v4.hitLeft++;
      else if (zone === 'right') state.v4.hitRight++;
      else state.v4.hitRear++;
    }
    let candidates = buildComponentHitCandidates(ship, zone);
    if (candidates.length === 0) candidates = fallback();
    const chosen = selectHitComponent(candidates, rng);
    if (chosen) {
      const mult = getDamageMultiplier(dmgType, chosen.comp.def.type);
      const dmgToComp = remaining * mult;
      const before = chosen.comp.hp;
      chosen.comp.hp -= dmgToComp;
      hullRemoved = before - chosen.comp.hp;
      const wasArmor = chosen.comp.def.type === 'armor';
      let breached = false;
      if (chosen.comp.hp <= 0) {
        chosen.comp.hp = 0;
        chosen.comp.destroyed = true;
        if (wasArmor) breached = true;
      }
      if (state.v4) {
        if (wasArmor) state.v4.armorDamage += hullRemoved;
        else if (chosen.comp.def.type === 'core') state.v4.coreDamage += hullRemoved;
        else if (chosen.comp.def.type === 'engine') state.v4.engineDamage += hullRemoved;
        else if (chosen.comp.def.type === 'weapon') state.v4.weaponDamage += hullRemoved;
        else if (chosen.comp.def.type === 'sensor') state.v4.sensorDamage += hullRemoved;
      }
      result = {
        compIndex: chosen.index,
        hpRatio: chosen.comp.hp / chosen.comp.maxHp,
        destroyed: chosen.comp.destroyed,
        oldHp: before,
        shipDestroyed: false,
        applied: absorbed + hullRemoved,
        shieldDamage: absorbed,
        zone,
        compType: chosen.comp.def.type,
        breachedArmor: breached
      };
    }
  }

  recomputeDerivedV4(ship);
  const core = ship.components.find((c) => c.def.type === 'core');
  const coreDead = core ? core.destroyed : true;
  const allDead = ship.components.every((c) => c.destroyed);
  if (coreDead || allDead) {
    ship.alive = false;
    // 核心/全组件摧毁时显式置 destroyed，避免死舰残留 retreating/disabled 等旧状态。
    ship.combatState = 'destroyed';
    // 死舰不得残留 escaped / retreating 的状态字段，保证状态机自洽（校验层据此拒绝冲突状态）。
    ship.escapedTick = undefined;
    ship.retreatStartedTick = undefined;
    ship.shield = 0;
    state.explosions.push({ shipId: ship.id, pos: { ...ship.pos }, tick: state.tick });
    if (result) result.shipDestroyed = true;
  }
  return result;
}

// ---------------- 模拟器 ----------------

export class BattleSimulatorV4 {
  private state: BattleState;
  private rng: PRNG;
  private shotId = 0;
  private auraAcc = new Map<number, number>();
  private auraShield = new Map<number, number>();
  private auraDirty = true;
  private retreatRules: RetreatRules = { ...DEFAULT_RETREAT_RULES };

  constructor(state: BattleState, rng: PRNG) {
    this.state = state;
    this.rng = rng;
    this.computeAuras();
    // 初始化各舰 combatState
    for (const s of state.ships) {
      if (isPresentOnBattlefield(s)) s.combatState = computeCombatState(s, false);
    }
  }

  /**
   * 只读地返回模拟器当前操作的 BattleState。
   * 该引用与调用方传入 createSimulator 的 state 为同一对象（构造时 this.state = state），
   * 因此模拟完成后可直接作为最终 BattleState 使用，无需通过 as unknown as 伪造或额外回读。
   */
  getState(): BattleState {
    return this.state;
  }

  getAuraStatus(id: number): { accuracy: number; shieldRegen: number } {
    return {
      accuracy: this.auraAcc.get(id) ?? 0,
      shieldRegen: this.auraShield.get(id) ?? 0
    };
  }

  dispose(): void {
    this.auraAcc.clear();
    this.auraShield.clear();
  }

  step(): BattleStepResult {
    const s = this.state;
    const events: BattleEvent[] = [];
    s.tick++;

    s.shots = s.shots.filter((sh) => s.tick - sh.tick <= 3);
    s.explosions = s.explosions.filter((e) => s.tick - e.tick <= 45);

    // 每 5 tick 或强制刷新光环缓存（光环无随机，不影响确定性）
    if (this.auraDirty || s.tick % 5 === 0) {
      this.computeAuras();
      this.auraDirty = false;
    }

    const centroid = this.computeCentroid();

    for (const ship of s.ships) {
      if (!isPresentOnBattlefield(ship)) continue;
      recomputeDerivedV4(ship);

      // 应用光环加成（派生之后叠加）
      const acc = this.auraAcc.get(ship.id) ?? 0;
      const shd = this.auraShield.get(ship.id) ?? 0;
      if (acc) ship.accuracy = clamp(ship.accuracy + acc, 0, 1);
      if (shd) ship.shieldRegen += shd;
      ship.shield = Math.min(ship.maxShield, ship.shield + ship.shieldRegen);

      const doc = s.teamDoctrine[ship.team];
      const teamLossRatio = this.teamLossRatio(ship.team);
      const hasClose = this.hasCloseEnemy(ship);

      // ---- 撤退决策（仅首次触发；已撤退或机动失效者不再重复决策，避免每 tick 重置起始 tick） ----
      if (isPresentOnBattlefield(ship) && !ship.mobilityDisabled && ship.retreatStartedTick === undefined) {
        const dec = shouldRetreat(ship, doc, teamLossRatio, this.retreatRules);
        if (dec.retreat) {
          ship.retreatStartedTick = s.tick;
          ship.retreatReason = dec.reason;
          if (ship.combatState !== 'disabled') ship.combatState = 'retreating';
          events.push({
            type: 'retreatStarted',
            tick: s.tick,
            shipId: ship.id,
            team: ship.team,
            reason: dec.reason
          });
        }
      }

      // ---- 目标选择（带缓存，每 5 tick 重选） ----
      const target = this.selectTarget(ship, doc, centroid, events);
      ship.targetId = target ? target.id : null;

      // 机动层面的"正在撤离"：已决定撤退且仍可机动、未脱战/未摧毁。
      // 注意：combatState 可能因武器/传感器全毁而被 computeCombatState 置为 'disabled'，
      // 但机动只要正常就仍应继续物理撤离（flee），故撤退机动不依赖 combatState 枚举值。
      const isRetreatingManeuver =
        ship.retreatStartedTick !== undefined &&
        !ship.mobilityDisabled &&
        ship.combatState !== 'escaped' &&
        ship.combatState !== 'destroyed';
      const escapeTargetX =
        ship.team === 'A'
          ? -SPAWN.x - ESCAPE_MARGIN - 6
          : SPAWN.x + ESCAPE_MARGIN + 6;

      // ---- 移动 ----
      if (isRetreatingManeuver) {
        // 撤退：无论是否有目标都朝本方出生边界外撤离（不被追击牵制）
        const steer = computeSteering({
          ship,
          target,
          doc,
          centroid: centroid[ship.team],
          separation: this.computeSeparation(ship),
          lateralSign: ship.id % 2 === 0 ? 1 : -1,
          retreating: true,
          escapeTargetX
        });
        if (steer.speedFactor > 0) {
          const fwd = scaleVec(steer.dir, ship.effectiveSpeed * steer.speedFactor);
          ship.pos.x += fwd.x;
          ship.pos.z += fwd.z;
          const desiredHeading = Math.atan2(-steer.dir.z, steer.dir.x);
          ship.heading = turnToward(ship.heading, desiredHeading, ship.effectiveTurnRate);
        }
      } else if (ship.combatState !== 'disabled' && target) {
        const sep = this.computeSeparation(ship);
        const steer = computeSteering({
          ship,
          target,
          doc,
          centroid: centroid[ship.team],
          separation: sep,
          lateralSign: ship.id % 2 === 0 ? 1 : -1,
          retreating: false,
          escapeTargetX
        });
        if (steer.speedFactor > 0) {
          const fwd = scaleVec(steer.dir, ship.effectiveSpeed * steer.speedFactor);
          ship.pos.x += fwd.x;
          ship.pos.z += fwd.z;
          const desiredHeading = Math.atan2(-steer.dir.z, steer.dir.x);
          ship.heading = turnToward(ship.heading, desiredHeading, ship.effectiveTurnRate);
        }
      } else if (ship.combatState !== 'disabled' && !target && centroid[ship.team]) {
        const toC = sub(centroid[ship.team]!, ship.pos);
        if (Math.hypot(toC.x, toC.z) > 3) {
          const dir = normXZ(toC);
          ship.pos.x += dir.x * ship.effectiveSpeed * 0.4;
          ship.pos.z += dir.z * ship.effectiveSpeed * 0.4;
        }
      }
      ship.pos.x = clamp(ship.pos.x, -ARENA.x, ARENA.x);
      ship.pos.y = clamp(ship.pos.y, -ARENA.y, ARENA.y);
      ship.pos.z = clamp(ship.pos.z, -ARENA.z, ARENA.z);

      // ---- 撤退成功判定（抵达本方出生边界外）【移动之后检查，确保跨线当 tick 即脱战】 ----
      if (isRetreatingManeuver) {
        const edge = ship.team === 'A' ? -SPAWN.x : SPAWN.x;
        const beyond = ship.team === 'A' ? ship.pos.x <= edge - ESCAPE_MARGIN : ship.pos.x >= edge + ESCAPE_MARGIN;
        if (beyond) {
          ship.escapedTick = s.tick;
          ship.combatState = 'escaped';
          // 脱离战场的舰船"存活"（只是离开战斗），alive 必须为 true，与状态机校验（alive !== destroyed）一致。
          ship.alive = true;
          events.push({
            type: 'shipEscaped',
            tick: s.tick,
            shipId: ship.id,
            team: ship.team,
            shipType: ship.type,
            variant: ship.variant,
            pos: { ...ship.pos }
          });
          this.markAuraDirty();
          continue;
        }
      }

      // ---- 开火 ----
      if (target) {
        const d = distance(ship.pos, target.pos);
        this.fireWeapons(ship, target, doc, d, events);
      }

      // ---- 航母无人机打击 ----
      this.maybeDroneStrike(ship, events);

      // ---- 战斗状态更新 ----
      const newState = computeCombatState(ship, hasClose);
      if (newState !== ship.combatState) {
        events.push({
          type: 'combatStateChanged',
          tick: s.tick,
          shipId: ship.id,
          team: ship.team,
          from: ship.combatState,
          to: newState
        });
        // 若因全引擎/全武器/全传感器摧毁而进入 disabled，发专项事件
        if (newState === 'disabled') {
          if (ship.mobilityDisabled)
            events.push({ type: 'mobilityDisabled', tick: s.tick, shipId: ship.id, team: ship.team });
          else if (ship.weaponsDisabled)
            events.push({ type: 'weaponsDisabled', tick: s.tick, shipId: ship.id, team: ship.team });
          else if (ship.sensorsDisabled)
            events.push({ type: 'sensorsDisabled', tick: s.tick, shipId: ship.id, team: ship.team });
        }
        ship.combatState = newState;
      }
    }

    // ---- 存活 / 可战斗统计与结束判定 ----
    let a = 0;
    let b = 0;
    let capA = 0;
    let capB = 0;
    for (const sh of s.ships) {
      if (isPresentOnBattlefield(sh)) {
        if (sh.team === 'A') a++;
        else b++;
      }
      if (isCombatCapable(sh)) {
        if (sh.team === 'A') capA++;
        else capB++;
      }
    }
    s.teamACount = a;
    s.teamBCount = b;

    const wasFinished = s.finished;
    if (capA === 0 || capB === 0 || s.tick >= s.maxTicks) {
      const res = decideVictory(s);
      s.finished = true;
      s.winner = res.winner;
      s.victoryReason = res.reason;
    }
    if (s.finished && !wasFinished) {
      events.push({ type: 'battleEnded', tick: s.tick, winner: s.winner });
    }

    return { events };
  }

  // ---------------- 伤害与开火 ----------------

  private dealDamage(
    attacker: Ship,
    target: Ship,
    dmg: number,
    weaponName: string,
    dmgType: DamageType,
    events: BattleEvent[]
  ): void {
    const s = this.state;
    const preShield = target.shield;
    const res = applyDamageV4(s, target, dmg, dmgType, attacker.pos, this.rng);
    const applied = res?.applied ?? 0;
    addDamage(s.stats, attacker.id, attacker.team, applied);

    events.push({
      type: 'hit',
      tick: s.tick,
      attackerId: attacker.id,
      targetId: target.id,
      attackerTeam: attacker.team,
      weaponName,
      damage: applied,
      shieldDamage: res?.shieldDamage ?? 0,
      hullDamage: applied - (res?.shieldDamage ?? 0),
      hitComponentIndex: res ? res.compIndex : -1,
      pos: { ...target.pos }
    });

    if (res) {
      const comp = target.components[res.compIndex];
      events.push({
        type: 'componentDamaged',
        tick: s.tick,
        shipId: target.id,
        compIndex: res.compIndex,
        oldHp: res.oldHp,
        newHp: comp.hp,
        hpRatio: res.hpRatio,
        destroyed: res.destroyed
      });
      if (res.breachedArmor) {
        events.push({
          type: 'armorBreached',
          tick: s.tick,
          shipId: target.id,
          team: target.team,
          zone: res.zone
        });
        this.markAuraDirty();
      }
      // 关键支援组件（护盾/传感器）被摧毁时立即刷新光环缓存，避免残留加成。
      if (res.destroyed && (comp.def.type === 'shield' || comp.def.type === 'sensor')) {
        this.markAuraDirty();
      }
      // 目标舰被摧毁（核心/全组件损毁）时，若其本身是光环源，光环应立即停止。
      if (res.shipDestroyed) {
        this.markAuraDirty();
      }
      if (res.shipDestroyed) {
        events.push({
          type: 'shipDestroyed',
          tick: s.tick,
          shipId: target.id,
          team: target.team,
          shipType: target.type,
          variant: target.variant,
          pos: { ...target.pos }
        });
        addKill(s.stats, attacker.id, attacker.team, target.type, target.team, target.variant);
        this.markAuraDirty();
      }
    }

    if (preShield > 0 && target.shield <= 0) {
      events.push({ type: 'shieldDown', tick: s.tick, shipId: target.id, team: target.team });
    }
  }

  private fireWeapons(ship: Ship, target: Ship, doc: DoctrineType, d: number, events: BattleEvent[]): void {
    const s = this.state;
    for (let i = 0; i < ship.components.length; i++) {
      const c = ship.components[i];
      if (!c.def.weapon || c.destroyed) continue;
      const w = c.def.weapon;
      const last = ship.lastFireTick.get(i) ?? -999999;
      const effCooldown = Math.max(1, Math.round(w.cooldownTicks / ship.weaponEfficiency));
      if (d > w.range) continue;
      if (s.tick - last < effCooldown) continue;
      if (!this.inFiringArc(ship, target, w)) continue;

      const effDamage = w.damage * ship.weaponEfficiency * (ship.variantMods.classDamageMul[target.type] ?? 1);
      let effAcc = ship.accuracy;
      effAcc += ship.variantMods.accuracyBonusVs[target.type] ?? 0;
      effAcc -= ship.variantMods.accuracyPenaltyVs[target.type] ?? 0;
      if (ship.variantMods.closeRangePenalty > 0 && d < w.range * 0.5) {
        effAcc -= ship.variantMods.closeRangePenalty;
      }
      effAcc = clamp(effAcc, 0, 1);
      const hit = this.rng.next() < effAcc;

      const start = add(ship.pos, scaleVec(rotateY(w.offset, ship.heading), ship.def.scale));
      const end = { ...target.pos };
      s.shots.push({
        id: this.shotId++,
        fromTeam: ship.team,
        fromShip: ship.id,
        toShip: target.id,
        start,
        end,
        tick: s.tick
      });

      if (w.role !== 'pd') {
        events.push({
          type: 'weaponFired',
          tick: s.tick,
          shipId: ship.id,
          targetId: target.id,
          attackerTeam: ship.team,
          start,
          end,
          weaponIndex: i,
          weaponName: w.name
        });
      }

      if (hit) {
        const dtype = weaponDamageType(w.role);
        if (w.role === 'pd') {
          events.push({
            type: 'pointDefenseFired',
            tick: s.tick,
            attackerId: ship.id,
            targetId: target.id,
            attackerTeam: ship.team,
            start,
            end,
            weaponName: w.name
          });
        }
        this.dealDamage(ship, target, effDamage, w.name, dtype, events);
      }

      ship.lastFireTick.set(i, s.tick);
    }
  }

  private maybeDroneStrike(ship: Ship, events: BattleEvent[]): void {
    const ds = ship.variantMods.droneStrike;
    if (!ds || !isPresentOnBattlefield(ship)) return;
    if (this.state.tick < ship.droneNextTick) return;
    ship.droneNextTick = this.state.tick + ds.intervalTicks;

    const enemies = this.state.ships
      .filter((o) => isTargetable(o) && o.team !== ship.team)
      .sort((p, q) => distance(ship.pos, p.pos) - distance(ship.pos, q.pos) || p.id - q.id);
    if (enemies.length === 0) return;

    const chosen = enemies.slice(0, Math.min(ds.maxTargets, enemies.length));
    const targetIds: number[] = [];
    for (const tgt of chosen) {
      const dmg = ds.damage * (0.85 + 0.3 * this.rng.next());
      targetIds.push(tgt.id);
      this.dealDamage(ship, tgt, dmg, 'DroneStrike', 'drone', events);
    }
    events.push({
      type: 'droneStrike',
      tick: this.state.tick,
      sourceShipId: ship.id,
      targetIds,
      damage: ds.damage,
      pos: { ...ship.pos }
    });
  }

  // ---------------- 光环（缓存，每 5 tick / 事件强制刷新） ----------------

  private markAuraDirty(): void {
    this.auraDirty = true;
  }

  private computeAuras(): void {
    this.auraAcc.clear();
    this.auraShield.clear();
    const s = this.state;
    const srcs = s.ships.filter((o) => isPresentOnBattlefield(o) && o.variantMods.supportAura).sort((a, b) => a.id - b.id);
    for (const src of srcs) {
      const aura = src.variantMods.supportAura!;
      // 门控：护盾光环需有效护盾组件；传感器光环需有效传感器
      if (aura.type === 'shield' && !hasIntact(src, 'shield')) continue;
      if (aura.type === 'sensor' && !hasIntact(src, 'sensor')) continue;
      const r2 = aura.radius * aura.radius;
      for (const tgt of s.ships) {
        if (!isPresentOnBattlefield(tgt) || tgt.team !== src.team) continue;
        if (aura.targets && !aura.targets.includes(tgt.type)) continue;
        if (dist2(tgt.pos, src.pos) > r2) continue;
        if (aura.type === 'sensor') {
          this.auraAcc.set(tgt.id, (this.auraAcc.get(tgt.id) ?? 0) + aura.value);
        } else {
          this.auraShield.set(tgt.id, (this.auraShield.get(tgt.id) ?? 0) + aura.value);
        }
      }
    }
    for (const [id, v] of this.auraAcc) this.auraAcc.set(id, Math.min(v, AURA_ACC_CAP));
    for (const [id, v] of this.auraShield) this.auraShield.set(id, Math.min(v, AURA_SHIELD_CAP));
  }

  // ---------------- 目标选择（缓存） ----------------

  private computeCentroid(): { A: Vec3 | null; B: Vec3 | null } {
    const acc: { A: Vec3; B: Vec3 } = { A: { x: 0, y: 0, z: 0 }, B: { x: 0, y: 0, z: 0 } };
    const cnt = { A: 0, B: 0 };
    for (const sh of this.state.ships) {
      if (!isPresentOnBattlefield(sh)) continue;
      acc[sh.team].x += sh.pos.x;
      acc[sh.team].y += sh.pos.y;
      acc[sh.team].z += sh.pos.z;
      cnt[sh.team]++;
    }
    return {
      A: cnt.A > 0 ? { x: acc.A.x / cnt.A, y: acc.A.y / cnt.A, z: acc.A.z / cnt.A } : null,
      B: cnt.B > 0 ? { x: acc.B.x / cnt.B, y: acc.B.y / cnt.B, z: acc.B.z / cnt.B } : null
    };
  }

  private targetInvalid(ship: Ship, t: Ship | null, doc: DoctrineType, d: number): boolean {
    if (!t || !isTargetable(t)) return true;
    if (t.combatState === 'escaped' || t.combatState === 'destroyed') return true;
    if (t.combatState === 'disabled' && doc !== 'aggressive') return true;
    if (d > (MAX_CHASE[doc] ?? 170)) return true;
    if (doc === 'screen') {
      // 离开保护半径则重新选择
      const anchor = this.anchorFor(ship);
      if (anchor) {
        const protR = 70;
        if (distance(t.pos, anchor.pos) > protR) return true;
      }
    }
    return false;
  }

  private anchorFor(ship: Ship): Ship | null {
    const s = this.state;
    let best: Ship | null = null;
    let bestD = Infinity;
    for (const o of s.ships) {
      if (o.team !== ship.team || !isPresentOnBattlefield(o) || !o.isAnchor) continue;
      const dd = dist2(o.pos, ship.pos);
      if (dd < bestD) {
        bestD = dd;
        best = o;
      }
    }
    return best;
  }

  private selectTarget(
    ship: Ship,
    doc: DoctrineType,
    centroid: { A: Vec3 | null; B: Vec3 | null },
    _events: BattleEvent[]
  ): Ship | null {
    const s = this.state;
    const enemies = s.ships.filter((o) => isTargetable(o) && o.team !== ship.team);

    // focusFire：团队集火目标（带失效检查）
    if (doc === 'focusFire') {
      const ftId = s.teamFocusTarget[ship.team];
      let ftShip: Ship | null = ftId != null ? enemies.find((e) => e.id === ftId) ?? null : null;
      const ftDist = ftShip ? distance(ship.pos, ftShip.pos) : Infinity;
      if (this.targetInvalid(ship, ftShip, doc, ftDist)) {
        ftShip = this.pickLowestHp(enemies);
        s.teamFocusTarget[ship.team] = ftShip ? ftShip.id : null;
      }
      return ftShip;
    }

    // 缓存：未到 5 tick 且目标仍有效且未到重选窗口
    const cachedId = ship.targetId;
    const cached = cachedId != null ? enemies.find((e) => e.id === cachedId) ?? null : null;
    const needEval = s.tick - ship.lastTargetEvaluationTick >= 5 || ship.lastTargetEvaluationTick === 0;
    if (!needEval && !this.targetInvalid(ship, cached, doc, cached ? distance(ship.pos, cached.pos) : Infinity)) {
      return cached;
    }

    // 完整重选
    let best: Ship | null = null;
    let bestScore = -Infinity;
    for (const e of enemies) {
      const sc = this.targetScoreV4(ship, e, doc, centroid[ship.team]);
      if (sc > bestScore) {
        bestScore = sc;
        best = e;
      }
    }
    ship.lastTargetEvaluationTick = s.tick;
    return best;
  }

  private pickLowestHp(enemies: Ship[]): Ship | null {
    let best: Ship | null = null;
    let bestR = Infinity;
    for (const e of enemies) {
      const r = hpRatio(e);
      if (r < bestR || (r === bestR && best && e.id < best.id)) {
        bestR = r;
        best = e;
      }
    }
    return best;
  }

  private targetScoreV4(ship: Ship, e: Ship, doc: DoctrineType, ownCenter: Vec3 | null): number {
    const d = distance(ship.pos, e.pos);
    const r = hpRatio(e);
    switch (doc) {
      case 'balanced':
        return -d + (1 - r) * 6;
      case 'aggressive':
        return -d * 0.5 + (1 - r) * 45;
      case 'kite':
        return -d;
      case 'defensive': {
        let sc = -d;
        if (ownCenter) sc -= 0.4 * distance(e.pos, ownCenter);
        return sc;
      }
      case 'antiCapital': {
        const tp = e.type === 'Cruiser' ? 2 : e.type === 'Frigate' ? 1 : 0;
        return tp * 1000 - d;
      }
      case 'screen': {
        if (ship.type === 'Fighter') return (e.type === 'Fighter' ? 1000 : 0) - d;
        if (ship.type === 'Cruiser') {
          const tp = e.type === 'Cruiser' ? 2 : e.type === 'Frigate' ? 1 : 0;
          return tp * 1000 - d;
        }
        if (ownCenter) return -distance(e.pos, ownCenter) - d * 0.2;
        return -d;
      }
      default:
        return -d;
    }
  }

  // ---------------- 分离力（防重叠） ----------------

  private computeSeparation(ship: Ship): Vec3 {
    const radius = SEP_RADIUS[ship.type] ?? 10;
    const r2 = radius * radius;
    let x = 0;
    let z = 0;
    let n = 0;
    for (const o of this.state.ships) {
      if (o === ship || !isPresentOnBattlefield(o) || o.team !== ship.team) continue;
      const dd = dist2(o.pos, ship.pos);
      if (dd > r2 || dd < 1e-6) continue;
      const dx = ship.pos.x - o.pos.x;
      const dz = ship.pos.z - o.pos.z;
      const inv = 1 / Math.sqrt(dd);
      const w = 1 - Math.sqrt(dd) / radius;
      x += dx * inv * w;
      z += dz * inv * w;
      n++;
    }
    if (n === 0) return { x: 0, y: 0, z: 0 };
    const l = Math.hypot(x, z) || 1;
    return { x: x / l, y: 0, z: z / l };
  }

  // ---------------- 辅助 ----------------

  private teamLossRatio(team: Team): number {
    const s = this.state;
    const all = s.ships.filter((o) => o.team === team);
    if (all.length === 0) return 0;
    const lost = all.filter((o) => isDestroyed(o)).length;
    return lost / all.length;
  }

  private hasCloseEnemy(ship: Ship): boolean {
    for (const o of this.state.ships) {
      if (o.team === ship.team || !isPresentOnBattlefield(o)) continue;
      if (dist2(o.pos, ship.pos) <= CLOSE_ENEMY_RADIUS * CLOSE_ENEMY_RADIUS) return true;
    }
    return false;
  }

  private inFiringArc(ship: Ship, target: Ship, w: WeaponSpec): boolean {
    const arc = w.arc ?? 'front';
    if (arc === 'turret') return true;
    const halfDeg = w.arcDegrees ?? (arc === 'front' ? 50 : arc === 'broadside' ? 100 : 50);
    const half = (halfDeg * Math.PI) / 180;
    const fx = Math.cos(ship.heading);
    const fz = -Math.sin(ship.heading);
    const rx = Math.sin(ship.heading);
    const rz = Math.cos(ship.heading);
    const dir = normXZ(sub(target.pos, ship.pos));
    const dotF = clamp(dir.x * fx + dir.z * fz, -1, 1);
    const angleF = Math.acos(dotF);
    if (arc === 'front') return angleF <= half;
    if (arc === 'rear') {
      const dotB = clamp(dir.x * -fx + dir.z * -fz, -1, 1);
      return Math.acos(dotB) <= half;
    }
    return Math.abs(angleF - Math.PI / 2) <= half;
  }
}
