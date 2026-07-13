import './style.css';
import './v071.css';
import './v081.css';
import './v09.css';
import './v10.css';
import { App } from './App';
import { installCampaignRuntimeControls } from './campaign/fleet/campaignRuntimeControls';
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

(window as unknown as { runDeterministicTest: () => string }).runDeterministicTest = runDeterministicTest;
(window as unknown as { runGoldenReplayTests: () => string }).runGoldenReplayTests = runGoldenReplayTests;
(window as unknown as { runGoldenReplayValues: () => string }).runGoldenReplayValues = generateGoldenReplayValues;
(window as unknown as { runDirectionalRuleTests: () => unknown }).runDirectionalRuleTests = runDirectionalRuleTests;
(window as unknown as { componentTargetingTests: () => unknown }).componentTargetingTests = componentTargetingTests;
(window as unknown as { armorProtectionTests: () => unknown }).armorProtectionTests = armorProtectionTests;
(window as unknown as { weaponEfficiencyTests: () => unknown }).weaponEfficiencyTests = weaponEfficiencyTests;
(window as unknown as { engineEfficiencyTests: () => unknown }).engineEfficiencyTests = engineEfficiencyTests;
(window as unknown as { combatStateTests: () => unknown }).combatStateTests = combatStateTests;
(window as unknown as { auraTests: () => unknown }).auraTests = auraTests;
(window as unknown as { replayCompatibilityTests: () => unknown }).replayCompatibilityTests = replayCompatibilityTests;
(window as unknown as { runSimulationStressTest: (seed?: number, maxTicks?: number) => unknown }).runSimulationStressTest = runSimulationStressTest;
(window as unknown as { runAcceptanceTests: () => unknown }).runAcceptanceTests = runAcceptanceTests;
(window as unknown as { shipCountConservationTests: () => unknown }).shipCountConservationTests = shipCountConservationTests;
(window as unknown as { fleetValueConservationTests: () => unknown }).fleetValueConservationTests = fleetValueConservationTests;
(window as unknown as { stateMachineTests: () => unknown }).stateMachineTests = stateMachineTests;
(window as unknown as { pointsDecisionTests: () => unknown }).pointsDecisionTests = pointsDecisionTests;
(window as unknown as { targetValidationTests: () => unknown }).targetValidationTests = targetValidationTests;
(window as unknown as { combatStateValidationTests: () => unknown }).combatStateValidationTests = combatStateValidationTests;
(window as unknown as { runBalanceTest: (cfg?: ReplayConfig, count?: number) => string }).runBalanceTest = runBalanceTest;
(window as unknown as { runBalance: (cfg: BalanceRunConfig) => unknown }).runBalance = runBalance;
(window as unknown as { runCampaignTests: () => unknown }).runCampaignTests = runCampaignTests;

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 容器');
const app = new App(root);
app.start();
installCampaignRuntimeControls(app);
(window as unknown as { render_game_to_text: () => string; advanceTime: (ms: number) => void }).render_game_to_text = () => JSON.stringify(app.campaignDebugState());
(window as unknown as { advanceTime: (ms: number) => void }).advanceTime = () => {};
