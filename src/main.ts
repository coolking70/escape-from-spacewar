import './style.css';
import { App } from './App';
import { runDeterministicTest, runBalanceTest } from './sim/deterministicTest';
import { runGoldenReplayTests, generateGoldenReplayValues } from './sim/goldenReplayTests';
import {
  componentTargetingTests,
  armorProtectionTests,
  weaponEfficiencyTests,
  engineEfficiencyTests,
  combatStateTests,
  auraTests
} from './sim/ruleUnitTests';
import { replayCompatibilityTests } from './sim/replayCompatTests';
import { runDirectionalRuleTests } from './sim/directionalRuleTests';
import { runSimulationStressTest } from './sim/stressTest';
import { runAcceptanceTests } from './sim/acceptanceTests';
import {
  shipCountConservationTests,
  fleetValueConservationTests,
  stateMachineTests,
  pointsDecisionTests,
  targetValidationTests,
  combatStateValidationTests
} from './sim/coreV4ValidationTests';
import { runBalance, BalanceRunConfig } from './sim/balanceRunner';
import { ReplayConfig } from './sim/battleTypes';
import { runCampaignTests } from './campaign/campaignTests';

// 暴露确定性自检 / 黄金录像回归 / 规则单元 / 压力测试 / 验收总入口到全局，便于在浏览器控制台执行：
//   runDeterministicTest()           // 旧格式兼容 + 同 seed 复现 + 倍速/seek 无关 + 大规模确定性 + 时间换算
//   runGoldenReplayTests()           // 黄金录像指纹比对（core-v4 唯一正式规则，8 组）；缺失基线即判失败
//   runGoldenReplayValues()          // 只输出候选黄金值，绝不写入源码（需人工核对后再更新 GOLDEN_EXPECTED）
//   runDirectionalRuleTests()        // 定向规则测试（四个方位连续攻击的确定性 + 关键性质）
//   componentTargetingTests()/armorProtectionTests()/weaponEfficiencyTests()/engineEfficiencyTests()/combatStateTests()/auraTests()
//   replayCompatibilityTests()       // version→ruleset 映射 + 未知/错配拒绝
//   runSimulationStressTest()        // 100 艘无渲染压测（确定性 + 不变量诊断）
//   runAcceptanceTests()             // 依次运行上述全部套件（含 core-v4 终态校验）并返回结构化结果
//   shipCountConservationTests()/fleetValueConservationTests()/stateMachineTests()/pointsDecisionTests()/targetValidationTests()/combatStateValidationTests()
//   runBalanceTest() / runBalance(cfg)  // 平衡实验室
(window as unknown as { runDeterministicTest: () => string }).runDeterministicTest =
  runDeterministicTest;
(window as unknown as { runGoldenReplayTests: () => string }).runGoldenReplayTests =
  runGoldenReplayTests;
(window as unknown as { runGoldenReplayValues: () => string }).runGoldenReplayValues =
  generateGoldenReplayValues;
(window as unknown as { runDirectionalRuleTests: () => unknown }).runDirectionalRuleTests =
  runDirectionalRuleTests;
(window as unknown as { componentTargetingTests: () => unknown }).componentTargetingTests =
  componentTargetingTests;
(window as unknown as { armorProtectionTests: () => unknown }).armorProtectionTests =
  armorProtectionTests;
(window as unknown as { weaponEfficiencyTests: () => unknown }).weaponEfficiencyTests =
  weaponEfficiencyTests;
(window as unknown as { engineEfficiencyTests: () => unknown }).engineEfficiencyTests =
  engineEfficiencyTests;
(window as unknown as { combatStateTests: () => unknown }).combatStateTests =
  combatStateTests;
(window as unknown as { auraTests: () => unknown }).auraTests = auraTests;
(window as unknown as { replayCompatibilityTests: () => unknown }).replayCompatibilityTests =
  replayCompatibilityTests;
(window as unknown as { runSimulationStressTest: (seed?: number, maxTicks?: number) => unknown }).runSimulationStressTest =
  runSimulationStressTest;
(window as unknown as { runAcceptanceTests: () => unknown }).runAcceptanceTests =
  runAcceptanceTests;
(window as unknown as { shipCountConservationTests: () => unknown }).shipCountConservationTests =
  shipCountConservationTests;
(window as unknown as { fleetValueConservationTests: () => unknown }).fleetValueConservationTests =
  fleetValueConservationTests;
(window as unknown as { stateMachineTests: () => unknown }).stateMachineTests = stateMachineTests;
(window as unknown as { pointsDecisionTests: () => unknown }).pointsDecisionTests = pointsDecisionTests;
(window as unknown as { targetValidationTests: () => unknown }).targetValidationTests =
  targetValidationTests;
(window as unknown as { combatStateValidationTests: () => unknown }).combatStateValidationTests =
  combatStateValidationTests;
(window as unknown as { runBalanceTest: (cfg?: ReplayConfig, count?: number) => string }).runBalanceTest =
  runBalanceTest;
(window as unknown as { runBalance: (cfg: BalanceRunConfig) => unknown }).runBalance = runBalance;
(window as unknown as { runCampaignTests: () => unknown }).runCampaignTests = runCampaignTests;

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');
const app = new App(root);
app.start();
(window as unknown as { render_game_to_text: () => string; advanceTime: (ms: number) => void }).render_game_to_text = () => JSON.stringify(app.campaignDebugState());
(window as unknown as { advanceTime: (ms: number) => void }).advanceTime = () => {};
