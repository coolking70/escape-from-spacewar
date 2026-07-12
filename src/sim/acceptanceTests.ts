// V0.5.2 验收测试总入口（纯 sim，无渲染 / DOM）。
// 依次执行：确定性自检、黄金回放、方向命中、装甲保护、武器效率、引擎效率、
// 战斗状态机、光环、replay 兼容、定向规则、100 艘压力测试，以及 core-v4 终态校验
// （舰数守恒、舰队价值守恒、状态机、点数判定、目标系统、CombatState 语义）。
// 返回结构化结果 { passed, suites: [{ name, passed, durationMs, messages }], text }。
// 浏览器中可用 window.runAcceptanceTests() 运行。

import { runDeterministicTest } from './deterministicTest';
import { runGoldenReplayTests } from './goldenReplayTests';
import {
  componentTargetingTests,
  armorProtectionTests,
  weaponEfficiencyTests,
  engineEfficiencyTests,
  combatStateTests,
  auraTests
} from './ruleUnitTests';
import { replayCompatibilityTests } from './replayCompatTests';
import { runDirectionalRuleTests } from './directionalRuleTests';
import { runSimulationStressTest } from './stressTest';
import {
  shipCountConservationTests,
  fleetValueConservationTests,
  stateMachineTests,
  pointsDecisionTests,
  targetValidationTests,
  combatStateValidationTests
} from './coreV4ValidationTests';
import { runFleetValidationTests } from './fleetValidationTests';
import { setupPanelTests } from '../ui/setupPanelTests';
import { SuiteResult } from './testHarness';

export interface AcceptanceSuiteResult {
  name: string;
  passed: boolean;
  durationMs: number;
  messages: string[];
}

export interface AcceptanceResult {
  passed: boolean;
  suites: AcceptanceSuiteResult[];
  text: string;
}

function wrapString(name: string, fn: () => string): AcceptanceSuiteResult {
  const t0 = Date.now();
  let out = '';
  let passed = false;
  try {
    out = fn();
    passed = !/FAILED/i.test(out) && !/FAIL /i.test(out) && !/✗/.test(out);
  } catch (e) {
    out = `运行异常: ${String(e)}`;
    passed = false;
  }
  const durationMs = Date.now() - t0;
  return {
    name,
    passed,
    durationMs,
    messages: out.split('\n').filter((l) => l.trim().length > 0)
  };
}

function wrapSuite(name: string, fn: () => SuiteResult): AcceptanceSuiteResult {
  const t0 = Date.now();
  let res: SuiteResult;
  try {
    res = fn();
  } catch (e) {
    res = {
      name,
      passed: false,
      durationMs: Date.now() - t0,
      messages: [`[FAIL] ${name}: 异常 ${String(e)}`]
    };
  }
  return { name: res.name, passed: res.passed, durationMs: res.durationMs, messages: res.messages };
}

export function runAcceptanceTests(): AcceptanceResult {
  const suites: AcceptanceSuiteResult[] = [];

  // 1. 确定性自检（含 v0.5 编解码、未知 ruleset 拒绝、错配拒绝、时间换算）
  suites.push(wrapString('deterministicTest', runDeterministicTest));

  // 2. 黄金回放（core-v4 唯一正式规则，8 组固定指纹）
  suites.push(wrapString('goldenReplayTests', runGoldenReplayTests));

  // 3~6. 规则单元（方向命中 / 装甲保护 / 武器效率 / 引擎效率）
  suites.push(wrapSuite('componentTargeting', componentTargetingTests));
  suites.push(wrapSuite('armorProtection', armorProtectionTests));
  suites.push(wrapSuite('weaponEfficiency', weaponEfficiencyTests));
  suites.push(wrapSuite('engineEfficiency', engineEfficiencyTests));

  // 7. 战斗状态机（优先级 / retreating 转 disabled|escaped|destroyed / 点数公式）
  suites.push(wrapSuite('combatState', combatStateTests));

  // 8. 光环（Scout/Support 源组件摧毁后停止、escaped/destroyed 不提供、叠加上限）
  suites.push(wrapSuite('aura', auraTests));

  // 9. replay 兼容（version→ruleset 映射、未知拒绝、错配拒绝、往返）
  suites.push(wrapSuite('replayCompatibility', replayCompatibilityTests));

  // 10. 定向规则（四个方位连续攻击的确定性 + 关键性质）
  suites.push(wrapSuite('directionalRule', runDirectionalRuleTests));

  // 11. 100 艘无渲染压力测试（确定性 + 不变量诊断）
  suites.push(wrapString('simulationStressTest', () => {
    const r = runSimulationStressTest();
    const head = r.notes.join('\n');
    return (r.passed ? '[PASS] ' : '[FAIL] ') + 'simulationStressTest\n' + head;
  }));

  // 12. 舰数守恒（7 状态计数之和 = 初始舰数，双方）
  suites.push(wrapSuite('shipCountConservation', shipCountConservationTests));

  // 13. 舰队价值守恒（destroyed+disabled+escaped+operational = 初始成本；决策价值口径一致）
  suites.push(wrapSuite('fleetValueConservation', fleetValueConservationTests));

  // 14. 状态机（终态与优先级：destroyed/escaped 为终态，disabled 优先于 retreating/critical）
  suites.push(wrapSuite('stateMachine', stateMachineTests));

  // 15. 点数判定（Escaped/Disabled 价值公式 + decideVictory 与 state 一致 + 超时/点数裁决胜方价值更高）
  suites.push(wrapSuite('pointsDecision', pointsDecisionTests));

  // 16. 目标系统（escaped/destroyed 不可锁定、disabled 仍可被攻击、终态一致）
  suites.push(wrapSuite('targetValidation', targetValidationTests));

  // 17. CombatState 语义一致性（helper 与 combatState 一致、escaped 必有 escapedTick、优先级单调）
  suites.push(wrapSuite('combatStateValidation', combatStateValidationTests));

  // 18. 舰队校验（非法组合拒绝、count 校验、normalizeFleet 合并）
  suites.push(wrapSuite('fleetValidation', runFleetValidationTests));

  // 19. 配置面板（新增编队项不重复、开始按钮与统一舰队校验一致）
  suites.push(wrapSuite('setupPanel', setupPanelTests));

  const allPassed = suites.every((s) => s.passed);
  const totalMs = suites.reduce((s, x) => s + x.durationMs, 0);

  const lines: string[] = [];
  lines.push('===== V0.5.2 验收测试 =====');
  lines.push(`总判定：${allPassed ? '全部通过 ✅' : '存在失败 ❌'}（${suites.filter((s) => s.passed).length}/${suites.length} 套件，总耗时 ${totalMs}ms，仅诊断用）`);
  lines.push('');
  for (const s of suites) {
    lines.push(`[${s.passed ? 'PASS' : 'FAIL'}] ${s.name}（${s.durationMs}ms）`);
    for (const m of s.messages.slice(0, 40)) lines.push('    ' + m);
    if (s.messages.length > 40) lines.push(`    ...（其余 ${s.messages.length - 40} 行省略）`);
  }
  lines.push('');
  lines.push('===== 结束 =====');

  return { passed: allPassed, suites, text: lines.join('\n') };
}
