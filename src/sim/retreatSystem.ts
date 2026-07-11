// core-v4 撤退决策（纯函数，不消耗 PRNG）。
// 仅负责"是否应当撤退"，具体移动与脱离边界由 movementSystem / 模拟器处理。

import { Ship, DoctrineType } from './battleTypes';
import { hpRatio } from './componentTargeting';

export interface RetreatRules {
  enabled: boolean;
  /** 核心 HP 比例低于此值即触发（默认 0.2） */
  criticalCoreRatio: number;
  /** 总 HP 比例低于此值即触发（默认 0.18） */
  totalHpRatio: number;
  /** 本方损失比例超过此值且自身已 damaged 时触发（默认 0.7） */
  teamLossRatio: number;
  allowDefensiveRetreat: boolean;
  allowKiteRetreat: boolean;
  allowAggressiveRetreat: boolean;
}

export const DEFAULT_RETREAT_RULES: RetreatRules = {
  enabled: true,
  criticalCoreRatio: 0.2,
  totalHpRatio: 0.18,
  teamLossRatio: 0.7,
  allowDefensiveRetreat: true,
  allowKiteRetreat: true,
  allowAggressiveRetreat: false
};

export interface RetreatDecision {
  retreat: boolean;
  reason: string;
}

/** 战术是否允许该舰撤退（aggressive 默认不易撤退） */
function doctrineAllows(doc: DoctrineType, rules: RetreatRules): boolean {
  switch (doc) {
    case 'defensive':
      return rules.allowDefensiveRetreat;
    case 'kite':
      return rules.allowKiteRetreat;
    case 'aggressive':
      return rules.allowAggressiveRetreat;
    default:
      // balanced / focusFire / antiCapital / screen 允许
      return true;
  }
}

/** 判定某舰是否应当开始撤退。
 * @param teamLossRatio 本方已被摧毁的舰船比例（0~1） */
export function shouldRetreat(
  ship: Ship,
  doc: DoctrineType,
  teamLossRatio: number,
  rules: RetreatRules
): RetreatDecision {
  if (!rules.enabled) return { retreat: false, reason: '' };
  if (ship.combatState === 'escaped' || ship.combatState === 'destroyed') {
    return { retreat: false, reason: '' };
  }
  if (!doctrineAllows(doc, rules)) return { retreat: false, reason: '' };

  const core = ship.components.find((c) => c.def.type === 'core');
  const coreRatio = core ? core.hp / core.maxHp : 1;
  const total = hpRatio(ship);
  const variant = ship.variant;

  // 支援 / 侦察 / 航母更倾向提前保全
  const earlyPreserver = variant === 'support' || variant === 'scout' || variant === 'carrier';
  if (earlyPreserver && (coreRatio <= 0.45 || total <= 0.45)) {
    return { retreat: true, reason: '支援舰保全' };
  }

  // 核心严重受损
  if (coreRatio <= rules.criticalCoreRatio) {
    return { retreat: true, reason: '核心严重受损' };
  }
  // 总 HP 过低
  if (total <= rules.totalHpRatio) {
    return { retreat: true, reason: '舰体濒临损毁' };
  }
  // 全部武器摧毁 → 无法作战
  if (ship.weaponsDisabled) {
    return { retreat: true, reason: '武器系统失效' };
  }
  // 全部传感器摧毁
  if (ship.sensorsDisabled) {
    return { retreat: true, reason: '传感器失效' };
  }
  // 本方重大损失且自身已受损
  if (teamLossRatio >= rules.teamLossRatio && total <= 0.5) {
    return { retreat: true, reason: '本方重大损失' };
  }
  return { retreat: false, reason: '' };
}
