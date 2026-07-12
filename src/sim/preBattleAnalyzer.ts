// 战前分析：纯静态评分，完全基于舰队构成 + 改型静态定义（VARIANTS 的 cost / tags / bars）。
//
// 重要约束（来自验收要求）：
//   - 不预测固定 seed 下的确切胜负，只比较舰队构成。
//   - 不消耗 PRNG、不读取真实时间、不修改 BattleConfig / ReplayConfig。
//   - 不写入 replay code。分析结果只是 UI 展示用的派生数据。
//   - 算法简单、透明、可调：所有"分数"都是 (bars × 数量) 的加权和，便于人工核对。
//
// 输出在 setupPanel 中以两栏对比展示，并明确提示"不代表确定的战斗结果"。

import { TeamConfig, Team, ShipClass, ShipVariant } from './battleTypes';
import { VARIANTS, SHIP_CN, VARIANT_CN, getVariantDef } from './shipVariants';
import { assertValidFleet } from './fleetValidator';

export interface TeamAnalysis {
  team: Team;
  totalPoints: number;
  totalShips: number;
  byClass: Record<ShipClass, number>;
  variantCounts: { variant: ShipVariant; count: number }[];
  /** 0~1 的倾向（按数量加权平均） */
  tendency: {
    speed: number;
    range: number;
    firepower: number;
    defense: number;
    support: number;
  };
  /** 能力计数（具备该 tag 的舰船数量） */
  capability: {
    antiFighter: number;
    antiCapital: number;
    pointDefense: number;
    sensor: number;
    shield: number;
    drone: number;
  };
  strengths: string[];
  weaknesses: string[];
  formationDoctrineNote: string;
}

export interface PreBattleAnalysis {
  a: TeamAnalysis;
  b: TeamAnalysis;
  /** 始终展示的免责声明 */
  disclaimer: string;
  /** 双方对比得出的提示 */
  comparison: string[];
}

const DISCLAIMER = '战前分析只比较舰队构成，不代表确定的战斗结果。';

function hasTag(variant: ShipVariant, tag: string): boolean {
  return (VARIANTS[variant]?.tags ?? []).includes(tag);
}

/** 分析单支舰队（纯静态） */
function analyzeTeam(team: Team, cfg: TeamConfig): TeamAnalysis {
  const fleet = cfg.fleet;
  const totalShips = fleet.reduce((s, e) => s + Math.max(0, Math.floor(e.count || 0)), 0);
  const byClass: Record<ShipClass, number> = { Fighter: 0, Frigate: 0, Cruiser: 0 };
  const variantCounts: { variant: ShipVariant; count: number }[] = [];
  let totalPoints = 0;

  const cap = { antiFighter: 0, antiCapital: 0, pointDefense: 0, sensor: 0, shield: 0, drone: 0 };
  const tend = { speed: 0, range: 0, firepower: 0, defense: 0, support: 0 };

  for (const e of fleet) {
    const count = Math.max(0, Math.floor(e.count || 0));
    if (count <= 0) continue;
    const v = getVariantDef(e.variant);
    const cost = v.cost;
    totalPoints += cost * count;
    byClass[e.shipClass] += count;
    variantCounts.push({ variant: e.variant, count });

    tend.speed += v.bars.speed * count;
    tend.range += v.bars.range * count;
    tend.firepower += v.bars.firepower * count;
    tend.defense += v.bars.defense * count;
    tend.support += v.bars.support * count;

    if (hasTag(e.variant, 'anti-fighter') || hasTag(e.variant, 'pd') || hasTag(e.variant, 'screen'))
      cap.antiFighter += count;
    if (hasTag(e.variant, 'anti-capital') || hasTag(e.variant, 'capital')) cap.antiCapital += count;
    if (hasTag(e.variant, 'pd')) cap.pointDefense += count;
    if (hasTag(e.variant, 'sensor')) cap.sensor += count;
    if (hasTag(e.variant, 'shield')) cap.shield += count;
    if (hasTag(e.variant, 'drone')) cap.drone += count;
  }

  const safeDiv = (x: number) => (totalShips > 0 ? x / totalShips : 0);
  const tendency = {
    speed: Math.round(safeDiv(tend.speed) * 100) / 100,
    range: Math.round(safeDiv(tend.range) * 100) / 100,
    firepower: Math.round(safeDiv(tend.firepower) * 100) / 100,
    defense: Math.round(safeDiv(tend.defense) * 100) / 100,
    support: Math.round(safeDiv(tend.support) * 100) / 100
  };
  const capability = {
    antiFighter: cap.antiFighter,
    antiCapital: cap.antiCapital,
    pointDefense: cap.pointDefense,
    sensor: cap.sensor,
    shield: cap.shield,
    drone: cap.drone
  };

  // -------- 优势 / 风险文本（透明规则） --------
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  if (tendency.speed >= 0.6) strengths.push('机动性强，适合拉扯与拦截');
  if (tendency.range >= 0.7) strengths.push('远程火力突出，先行交火占优');
  if (tendency.firepower >= 0.7) strengths.push('火力（爆发/持续）强');
  if (tendency.defense >= 0.7) strengths.push('生存/耐久能力极强');
  if (tendency.support >= 0.4) strengths.push('具备支援体系（护盾/传感器/无人机）');
  if (capability.antiCapital > 0) strengths.push(`具备反大型舰手段（${capability.antiCapital} 艘）`);
  if (capability.pointDefense > 0) strengths.push(`具备点防御（护航舰 ${capability.pointDefense} 艘）`);

  if (capability.sensor === 0) weaknesses.push('缺乏 Scout，传感器损毁后命中率会明显下降');
  if (capability.antiFighter === 0) weaknesses.push('缺乏反小船手段，易被 Fighter 压制');
  if (capability.antiCapital === 0) weaknesses.push('缺乏反大型舰手段，面对 Cruiser 偏被动');
  if (capability.pointDefense === 0) weaknesses.push('无点防御，较难拦截敌方无人机/轰炸机');
  if (tendency.speed < 0.4) weaknesses.push('平均速度偏低，走位与追击受限');
  if (tendency.defense < 0.4) weaknesses.push('舰体偏脆，需要注意走位与集火');
  if (tendency.firepower < 0.4) weaknesses.push('火力偏弱，可能拖入消耗战');
  if ((cfg.doctrine === 'kite' || cfg.doctrine === 'aggressive') && tendency.speed < 0.45)
    weaknesses.push(`选择了${cfg.doctrine === 'kite' ? '拉扯' : '积极'}战术，但舰队平均速度低，可能无法维持理想距离`);

  if (strengths.length === 0) strengths.push('无明显突出优势（均衡或偏科不明显）');
  if (weaknesses.length === 0) weaknesses.push('无明显短板');

  // -------- 阵型 / 战术匹配 --------
  let formationDoctrineNote = '';
  const hasFortress = variantCounts.some((v) => v.variant === 'fortress');
  const hasSupport = variantCounts.some((v) => v.variant === 'support');
  const hasCarrier = variantCounts.some((v) => v.variant === 'carrier');
  const fighterRatio = totalShips > 0 ? byClass.Fighter / totalShips : 0;

  if (cfg.formation === 'wall' && cfg.doctrine === 'defensive' && (hasFortress || hasSupport)) {
    formationDoctrineNote = '防御墙阵型 + 防御战术，并配置堡垒/支援型，组合较合理。';
  } else if (cfg.formation === 'wedge' && cfg.doctrine === 'aggressive') {
    formationDoctrineNote = '楔形阵 + 积极战术，适合压上集火。';
  } else if (cfg.formation === 'swarm' && fighterRatio >= 0.6) {
    formationDoctrineNote = '蜂群阵 + 大量 Fighter，适合拦截与骚扰。';
  } else if (cfg.formation === 'wall' && cfg.doctrine === 'antiCapital') {
    formationDoctrineNote = '防御墙 + 反大舰战术，利于堡垒/战列发挥。';
  } else if (cfg.doctrine === 'kite' && tendency.speed < 0.45) {
    formationDoctrineNote = '拉扯战术但机动不足，阵型/战术与舰队速度不太匹配。';
  } else if (cfg.formation === 'line' && fighterRatio >= 0.6) {
    formationDoctrineNote = '横列阵 + 大量 Fighter，正面展开较常规。';
  } else {
    formationDoctrineNote = `阵型=${cfg.formation} · 战术=${cfg.doctrine}，属常规搭配。`;
  }
  if (hasCarrier) formationDoctrineNote += '（含航母，无人机打击需一定时间才能体现优势）';

  return {
    team,
    totalPoints,
    totalShips,
    byClass,
    variantCounts,
    tendency,
    capability,
    strengths,
    weaknesses,
    formationDoctrineNote
  };
}

/** 对比双方，产出几条提示（不预测胜负） */
function compare(a: TeamAnalysis, b: TeamAnalysis): string[] {
  const out: string[] = [];
  if (a.capability.antiCapital > 0 && b.byClass.Cruiser === 0 && a.byClass.Cruiser > 0)
    out.push('一方有反大型舰手段而另一方无大型舰，可能形成压制。');
  if (b.capability.antiCapital > 0 && a.byClass.Cruiser > 0)
    out.push('另一方具备反大型舰手段，己方 Cruiser 可能受到 Bomber / 反大舰战术克制。');
  if (a.capability.sensor === 0 && b.capability.sensor > 0)
    out.push('己方缺乏 Scout，对方传感器支援可能使命中率差距拉大。');
  if (a.totalPoints > b.totalPoints * 1.3)
    out.push('己方总点数明显高于对方，资源占优（但点数不等于必胜）。');
  if (a.totalShips > b.totalShips * 1.6)
    out.push('己方舰船数量占优，适合用数量消耗。');
  return out;
}

/** 主入口：分析双方舰队构成（纯静态，不依赖战斗结果） */
export function analyzePreBattle(teamA: TeamConfig, teamB: TeamConfig): PreBattleAnalysis {
  assertValidFleet(teamA.fleet);
  assertValidFleet(teamB.fleet);
  const a = analyzeTeam('A', teamA);
  const b = analyzeTeam('B', teamB);
  return {
    a,
    b,
    disclaimer: DISCLAIMER,
    comparison: compare(a, b)
  };
}

/** 便捷的变体展示名 */
export function variantLabel(v: ShipVariant): string {
  return VARIANT_CN[v] ?? v;
}
export function classLabel(c: ShipClass): string {
  return SHIP_CN[c] ?? c;
}
