// 战斗系统的全部类型定义。
// 该文件只描述数据结构，不包含任何逻辑。

export type Team = 'A' | 'B';

/** 基础舰体类别（三种舰体；改型在此基础上派生） */
export type ShipClass = 'Fighter' | 'Frigate' | 'Cruiser';
/** 兼容别名：ShipTypeName 与 ShipClass 等价。 */
export type ShipTypeName = ShipClass;

/** 舰船改型（在基础舰体之上叠加属性/武器/支援差异） */
export type ShipVariant =
  | 'standard'
  | 'interceptor'
  | 'bomber'
  | 'scout'
  | 'escort'
  | 'artillery'
  | 'support'
  | 'battleship'
  | 'carrier'
  | 'fortress';

export type ComponentTypeName =
  | 'core'
  | 'engine'
  | 'weapon'
  | 'sensor'
  | 'shield'
  | 'armor';

/** 命中方向（core-v4 组件命中模型用；首版只区分前/左/右/后，top/bottom 暂不细分） */
export type HitZone = 'front' | 'left' | 'right' | 'rear';

/** 伤害类型（core-v4 用于装甲抗性与特殊必中标记） */
export type DamageType = 'laser' | 'cannon' | 'kinetic' | 'heavy' | 'drone' | 'pointDefense';

/** 舰船战斗状态。 */
export type CombatState =
  | 'normal'
  | 'damaged'
  | 'critical'
  | 'disabled'
  | 'retreating'
  | 'escaped'
  | 'destroyed';

/** 战斗结束原因（core-v4 新增；旧规则无此字段） */
export type VictoryReason =
  | 'annihilation'
  | 'combatDisabled'
  | 'retreat'
  | 'timeout'
  | 'pointsDecision'
  | 'draw';

/** 阵型：决定初始生成位置 */
export type FormationType = 'line' | 'wedge' | 'wall' | 'swarm' | 'random';

/** 战术倾向：决定目标选择、理想交火距离、集火等行为（必须确定性） */
export type DoctrineType =
  | 'balanced' // 均衡（默认）
  | 'aggressive' // 积极压上、集火残血
  | 'defensive' // 保持距离、保护重型舰
  | 'kite' // 拉扯、保持最大射程
  | 'focusFire' // 集火同一目标
  | 'antiCapital' // 优先大型舰
  | 'screen'; // 小船拦截敌方 Fighter

/** 武器开火弧：简化版 firingArc（不做复杂炮塔旋转） */
export type FiringArc = 'front' | 'broadside' | 'turret' | 'rear';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WeaponSpec {
  name: string;
  range: number;
  damage: number;
  /** 冷却时间（tick 数） */
  cooldownTicks: number;
  /** 相对于飞船本地坐标的炮口偏移（用于绘制激光起点） */
  offset: Vec3;
  /** 开火弧类型；省略时视为 front */
  arc?: FiringArc;
  /** 开火弧半角（度）；省略时按 arc 给默认值 */
  arcDegrees?: number;
  /** 激光视觉粗细（覆盖按舰种默认） */
  visualSize?: number;
  /** 武器角色：laser 细束 / cannon 粗束 / pd 点防御 */
  role?: 'laser' | 'cannon' | 'pd';
}

export type ShapeHint = 'box' | 'cylinder' | 'cone' | 'sphere';

export interface ComponentDef {
  type: ComponentTypeName;
  name: string;
  maxHp: number;
  /** 飞船本地坐标系下的位置偏移 */
  offset: Vec3;
  /** 渲染尺寸 */
  size: Vec3;
  shape: ShapeHint;
  /** 若该组件是武器，则带武器参数 */
  weapon?: WeaponSpec;
  /** core-v4：组件更易被哪个方向攻击命中的方位（省略表示全向等权） */
  hitZones?: HitZone[];
  /** core-v4：命中权重倍率（默认 1；核心应较低，外部装甲较高） */
  hitWeight?: number;
  /** core-v4：当这些方位的装甲被摧毁后才暴露（用于 armorBreached 判定） */
  exposedWhen?: HitZone[];
  /** core-v4：该组件保护的核心/内部组件类型（护盾/装甲保护核心） */
  protects?: ComponentTypeName[];
}

export interface ShipDef {
  type: ShipClass;
  /** 每 tick 的最大移动速度（单位） */
  maxSpeed: number;
  /** 每 tick 最大转向角（弧度） */
  turnRate: number;
  /** 基础索敌/感知范围 */
  baseRange: number;
  /** 整体缩放（渲染用，不改变逻辑） */
  scale: number;
  components: ComponentDef[];
}

// ---------------- 改型修正（纯数据，sim 层解析后驱动战斗，不影响渲染） ----------------

/** 由 ShipVariant 解析出的、sim 层需要的所有修正项（确定性，由 seed 无关的固定表解析） */
export interface VariantMods {
  maxSpeedMul: number;
  turnRateMul: number;
  baseRangeMul: number;
  coreHpMul: number;
  shieldMul: number;
  armorHpMul: number;
  sensorHpMul: number;
  weaponDamageMul: number;
  weaponCooldownMul: number;
  /** 对不同舰体类别的伤害加成（乘数），如 Bomber 对 Cruiser 有加成 */
  classDamageMul: Partial<Record<ShipClass, number>>;
  /** 对特定舰体类别的命中率加成（加性，如 Escort 对 Fighter） */
  accuracyBonusVs: Partial<Record<ShipClass, number>>;
  /** 对特定舰体类别的命中率惩罚（加性，如 Bomber 对 Fighter） */
  accuracyPenaltyVs: Partial<Record<ShipClass, number>>;
  /** 近距离命中率惩罚（当目标距离 < 0.5 × 武器射程时生效），如 Artillery */
  closeRangePenalty: number;
  /** 是否具备点防御（短射程快速武器，对 Fighter/Bomber 命中更高） */
  pointDefense: boolean;
  /** 支援光环：传感器（提升友军命中）或护盾（提升友军护盾恢复） */
  supportAura?: {
    type: 'sensor' | 'shield';
    radius: number;
    value: number;
    targets?: ShipClass[];
  };
  /** 航母无人机打击：每隔固定 tick 对若干目标造成稳定伤害（必须来自 sim 层） */
  droneStrike?: {
    intervalTicks: number;
    damage: number;
    maxTargets: number;
  };
}

/** 单条舰队编队项。 */
export interface FleetEntry {
  shipClass: ShipClass;
  variant: ShipVariant;
  count: number;
}

/** 舰队预算配置 */
export interface BudgetConfig {
  /** limited=受限, unlimited=无限(测试), legacy=旧录像默认(等同于无限) */
  mode: 'limited' | 'unlimited' | 'legacy';
  limit: number;
}

// ---------------- 运行时状态 ----------------

export interface ShipComponent {
  id: number;
  def: ComponentDef;
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

export interface Ship {
  id: number;
  team: Team;
  type: ShipClass;
  /** 改型（影响属性/武器/支援） */
  variant: ShipVariant;
  /** 由改型解析出的 sim 修正项（来自 seed 无关固定表，保证确定性） */
  variantMods: VariantMods;
  def: ShipDef;
  pos: Vec3;
  /** 朝向角（弧度），绕 Y 轴；前向向量 = (cos, 0, -sin) */
  heading: number;
  alive: boolean;
  components: ShipComponent[];
  targetId: number | null;
  shield: number;
  maxShield: number;
  /** 每 tick 护盾恢复量 */
  shieldRegen: number;
  /** 武器组件下标 -> 上次开火 tick */
  lastFireTick: Map<number, number>;
  // 由 damageModel 派生
  effectiveSpeed: number;
  /** 每 tick 最大转向角（引擎损伤时按 engineRatio 下降，全毁为 0） */
  effectiveTurnRate: number;
  effectiveRange: number;
  accuracy: number;
  /** 航母无人机打击的下一次触发 tick（无 droneStrike 时为 0） */
  droneNextTick: number;
  // ---- core-v4 战斗状态机 ----
  /** 当前战斗状态（normal/damaged/critical/disabled/retreating/escaped/destroyed） */
  combatState: CombatState;
  /** 推进系统是否失效（全部引擎摧毁） */
  mobilityDisabled: boolean;
  /** 武器系统是否全部失效（全部武器摧毁） */
  weaponsDisabled: boolean;
  /** 传感器是否全部失效（全部传感器摧毁） */
  sensorsDisabled: boolean;
  /** 撤退原因（retreating 时非空） */
  retreatReason?: string;
  /** 开始撤退的 tick */
  retreatStartedTick?: number;
  /** 成功脱离战场的 tick（escaped 时） */
  escapedTick?: number;
  /** 目标锁定到期 tick（core-v4 目标缓存用） */
  targetLockUntilTick: number;
  /** 上次完整重选目标的 tick */
  lastTargetEvaluationTick: number;
  /** 引擎综合完好率 = 存活引擎 HP 和 / 引擎最大 HP 和（0~1） */
  engineRatio: number;
  /** 武器综合效率 = 0.4 + 0.6 × 武器 HP 率均值（0.4~1） */
  weaponEfficiency: number;
  /** 传感器综合完好率（0~1） */
  sensorRatio: number;
  /** 当前已暴露（对应方位装甲被摧毁）的方位集合 */
  exposedZones: HitZone[];
  /** 是否作为 defensive/screen 的锚点（供 anchorForce 使用） */
  isAnchor: boolean;
}

export interface Shot {
  id: number;
  fromTeam: Team;
  fromShip: number;
  toShip: number;
  start: Vec3;
  end: Vec3;
  tick: number;
}

export interface Explosion {
  shipId: number;
  pos: Vec3;
  tick: number;
}

// ---------------- 统计 ----------------

export interface ShipStats {
  /** 该舰累计造成的伤害 */
  damageDealt: number;
  /** 该舰累计击毁数 */
  kills: number;
  /** 该舰舰体类别（用于按改型聚合） */
  shipClass: ShipClass;
  /** 该舰改型 */
  variant: ShipVariant;
}

export interface TeamStats {
  totalDamage: number;
  kills: number;
  /** 已损失的各改型数量，key = `${shipClass}:${variant}` */
  losses: Record<string, number>;
}

export interface BattleStats {
  /** 按 ship.id 记录的单舰统计 */
  ships: Record<number, ShipStats>;
  /** 双方团队统计 */
  team: { A: TeamStats; B: TeamStats };
  /** 初始双方编队（用于损失率等展示） */
  startCounts: { A: FleetEntry[]; B: FleetEntry[] };
}

// ---------------- 视觉事件（仅记录模拟结果，渲染层消费，绝不反向影响模拟） ----------------

export type BattleEventType =
  | 'weaponFired'
  | 'hit'
  | 'shipDestroyed'
  | 'componentDamaged'
  | 'shieldDown'
  | 'battleEnded'
  | 'auraApplied'
  | 'droneStrike'
  | 'pointDefenseFired'
  | 'supportEffect'
  // ---- core-v4 新增事件（仅记录 sim 结果，渲染层消费，不回写 sim） ----
  | 'combatStateChanged'
  | 'retreatStarted'
  | 'shipEscaped'
  | 'shipDisabled'
  | 'armorBreached'
  | 'mobilityDisabled'
  | 'weaponsDisabled'
  | 'sensorsDisabled';

export interface WeaponFiredEvent {
  type: 'weaponFired';
  tick: number;
  shipId: number;
  targetId: number;
  attackerTeam: Team;
  /** 开火武器组件在 ship.components 中的下标 */
  weaponIndex: number;
  weaponName: string;
  /** 炮口世界坐标（已含 scale） */
  start: Vec3;
  /** 目标世界坐标 */
  end: Vec3;
}

export interface HitEvent {
  type: 'hit';
  tick: number;
  attackerId: number;
  targetId: number;
  attackerTeam: Team;
  weaponName: string;
  /** 本次命中总伤害（护盾+船体） */
  damage: number;
  /** 其中扣自护盾的部分 */
  shieldDamage: number;
  /** 其中扣自船体的部分 */
  hullDamage: number;
  /** 被命中的组件下标（未破盾时为 -1） */
  hitComponentIndex: number;
  /** 命中点的世界坐标（目标中心） */
  pos: Vec3;
}

export interface ComponentDamagedEvent {
  type: 'componentDamaged';
  tick: number;
  shipId: number;
  /** 受损组件在 ship.components 中的下标 */
  compIndex: number;
  oldHp: number;
  newHp: number;
  /** 受损后 HP 比例 0~1 */
  hpRatio: number;
  /** 该组件是否被摧毁 */
  destroyed: boolean;
}

export interface ShipDestroyedEvent {
  type: 'shipDestroyed';
  tick: number;
  shipId: number;
  team: Team;
  shipType: ShipClass;
  variant: ShipVariant;
  pos: Vec3;
}

export interface ShieldDownEvent {
  type: 'shieldDown';
  tick: number;
  shipId: number;
  team: Team;
}

export interface BattleEndedEvent {
  type: 'battleEnded';
  tick: number;
  winner: Team | null;
}

/** 支援光环（Scout 传感器 / Support 护盾）作用于某个友军 */
export interface AuraAppliedEvent {
  type: 'auraApplied';
  tick: number;
  sourceShipId: number;
  targetShipId: number;
  auraType: 'sensor' | 'shield';
  /** 该次光环提供的加成数值（命中加成或护盾恢复加成） */
  value: number;
}

/** 航母无人机打击（sim 层周期性产生） */
export interface DroneStrikeEvent {
  type: 'droneStrike';
  tick: number;
  sourceShipId: number;
  targetIds: number[];
  damage: number;
  pos: Vec3;
}

/** 点防御开火（Escort 短射程快速武器） */
export interface PointDefenseFiredEvent {
  type: 'pointDefenseFired';
  tick: number;
  attackerId: number;
  targetId: number;
  attackerTeam: Team;
  weaponName: string;
  start: Vec3;
  end: Vec3;
}

/** 支援效果（护盾/传感器）的周期性汇报事件（用于战斗日志与统计） */
export interface SupportEffectEvent {
  type: 'supportEffect';
  tick: number;
  sourceShipId: number;
  targetShipId: number;
  effectType: 'sensor' | 'shield';
  value: number;
}

/** core-v4：舰船战斗状态变化（normal/damaged/critical/disabled/retreating/escaped/destroyed） */
export interface CombatStateChangedEvent {
  type: 'combatStateChanged';
  tick: number;
  shipId: number;
  team: Team;
  from: CombatState;
  to: CombatState;
}

/** core-v4：舰船开始撤退 */
export interface RetreatStartedEvent {
  type: 'retreatStarted';
  tick: number;
  shipId: number;
  team: Team;
  reason: string;
}

/** core-v4：舰船成功脱离战场（不触发爆炸） */
export interface ShipEscapedEvent {
  type: 'shipEscaped';
  tick: number;
  shipId: number;
  team: Team;
  shipType: ShipClass;
  variant: ShipVariant;
  pos: Vec3;
}

/** core-v4：舰船失去战斗能力（disabled，非 destroyed） */
export interface ShipDisabledEvent {
  type: 'shipDisabled';
  tick: number;
  shipId: number;
  team: Team;
  reason: string;
}

/** core-v4：某方位装甲被击穿（暴露内部组件） */
export interface ArmorBreachedEvent {
  type: 'armorBreached';
  tick: number;
  shipId: number;
  team: Team;
  zone: HitZone;
}

/** core-v4：推进系统全部失效（全部引擎摧毁） */
export interface MobilityDisabledEvent {
  type: 'mobilityDisabled';
  tick: number;
  shipId: number;
  team: Team;
}

/** core-v4：武器系统全部失效（全部武器摧毁） */
export interface WeaponsDisabledEvent {
  type: 'weaponsDisabled';
  tick: number;
  shipId: number;
  team: Team;
}

/** core-v4：传感器全部失效（全部传感器摧毁） */
export interface SensorsDisabledEvent {
  type: 'sensorsDisabled';
  tick: number;
  shipId: number;
  team: Team;
}

export type BattleEvent =
  | WeaponFiredEvent
  | HitEvent
  | ComponentDamagedEvent
  | ShipDestroyedEvent
  | ShieldDownEvent
  | BattleEndedEvent
  | AuraAppliedEvent
  | DroneStrikeEvent
  | PointDefenseFiredEvent
  | SupportEffectEvent
  | CombatStateChangedEvent
  | RetreatStartedEvent
  | ShipEscapedEvent
  | ShipDisabledEvent
  | ArmorBreachedEvent
  | MobilityDisabledEvent
  | WeaponsDisabledEvent
  | SensorsDisabledEvent;

/** 单次 step() 推进的结果，包含本 tick 产生的视觉事件 */
export interface BattleStepResult {
  events: BattleEvent[];
}

/** core-v4 运行时累计。 */
export interface V4Runtime {
  /** 各方位命中次数（用于统计） */
  hitFront: number;
  hitLeft: number;
  hitRight: number;
  hitRear: number;
  /** 各类组件累计承伤 */
  armorDamage: number;
  coreDamage: number;
  engineDamage: number;
  weaponDamage: number;
  sensorDamage: number;
  shieldDamage: number;
}

export interface BattleState {
  version: string;
  /** 规则集标识。 */
  ruleset?: string;
  seed: number;
  tick: number;
  maxTicks: number;
  ships: Ship[];
  shots: Shot[];
  explosions: Explosion[];
  finished: boolean;
  /** 胜利方；平局或超时无胜者时为 null */
  winner: Team | null;
  /** core-v4：战斗结束原因（旧规则恒为 undefined） */
  victoryReason?: VictoryReason;
  /** core-v4：运行时累计（旧规则恒为 undefined） */
  v4?: V4Runtime;
  teamACount: number;
  teamBCount: number;
  /** 双方当前集火目标（focusFire 等使用，纯确定性） */
  teamFocusTarget: { A: number | null; B: number | null };
  /** 双方战术（运行时用于 AI 决策，来自 ReplayConfig，纯确定性） */
  teamDoctrine: { A: DoctrineType; B: DoctrineType };
  /** 战斗统计 */
  stats: BattleStats;
}

/** 单一方配置：编队项、阵型与战术。 */
export interface TeamConfig {
  fleet: FleetEntry[];
  formation: FormationType;
  doctrine: DoctrineType;
}

export interface ReplayConfig {
  /** 模拟版本号，用于复现校验 */
  v: string;
  /** 规则集标识；导入时默认 spacewar-core-v4 */
  ruleset?: string;
  seed: number;
  /** 舰队预算（旧录像缺省时按 legacy/unlimited 处理） */
  budget?: BudgetConfig;
  teamA: TeamConfig;
  teamB: TeamConfig;
}
