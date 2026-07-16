import { runCampaignTests } from './campaign/campaignTests';
import { ReplayConfig } from './sim/battleTypes';
import { runBalance, BalanceRunConfig } from './sim/balanceRunner';
import {
  combatStateValidationTests,
  fleetValueConservationTests,
  pointsDecisionTests,
  shipCountConservationTests,
  stateMachineTests,
  targetValidationTests
} from './sim/coreV4ValidationTests';
import { runDeterministicTest, runBalanceTest } from './sim/deterministicTest';
import { runDirectionalRuleTests } from './sim/directionalRuleTests';
import { generateGoldenReplayValues, runGoldenReplayTests } from './sim/goldenReplayTests';
import { replayCompatibilityTests } from './sim/replayCompatTests';
import {
  armorProtectionTests,
  auraTests,
  combatStateTests,
  componentTargetingTests,
  engineEfficiencyTests,
  weaponEfficiencyTests
} from './sim/ruleUnitTests';
import { runSimulationStressTest } from './sim/stressTest';
import { runAcceptanceTests } from './sim/acceptanceTests';

declare global {
  interface Window {
    runDeterministicTest: () => string;
    runGoldenReplayTests: () => string;
    runGoldenReplayValues: () => string;
    runDirectionalRuleTests: () => unknown;
    componentTargetingTests: () => unknown;
    armorProtectionTests: () => unknown;
    weaponEfficiencyTests: () => unknown;
    engineEfficiencyTests: () => unknown;
    combatStateTests: () => unknown;
    auraTests: () => unknown;
    replayCompatibilityTests: () => unknown;
    runSimulationStressTest: (seed?: number, maxTicks?: number) => unknown;
    runAcceptanceTests: () => unknown;
    shipCountConservationTests: () => unknown;
    fleetValueConservationTests: () => unknown;
    stateMachineTests: () => unknown;
    pointsDecisionTests: () => unknown;
    targetValidationTests: () => unknown;
    combatStateValidationTests: () => unknown;
    runBalanceTest: (cfg?: ReplayConfig, count?: number) => string;
    runBalance: (cfg: BalanceRunConfig) => unknown;
    runCampaignTests: () => unknown;
  }
}

const debugWindow = window;
debugWindow.runDeterministicTest = runDeterministicTest;
debugWindow.runGoldenReplayTests = runGoldenReplayTests;
debugWindow.runGoldenReplayValues = generateGoldenReplayValues;
debugWindow.runDirectionalRuleTests = runDirectionalRuleTests;
debugWindow.componentTargetingTests = componentTargetingTests;
debugWindow.armorProtectionTests = armorProtectionTests;
debugWindow.weaponEfficiencyTests = weaponEfficiencyTests;
debugWindow.engineEfficiencyTests = engineEfficiencyTests;
debugWindow.combatStateTests = combatStateTests;
debugWindow.auraTests = auraTests;
debugWindow.replayCompatibilityTests = replayCompatibilityTests;
debugWindow.runSimulationStressTest = runSimulationStressTest;
debugWindow.runAcceptanceTests = runAcceptanceTests;
debugWindow.shipCountConservationTests = shipCountConservationTests;
debugWindow.fleetValueConservationTests = fleetValueConservationTests;
debugWindow.stateMachineTests = stateMachineTests;
debugWindow.pointsDecisionTests = pointsDecisionTests;
debugWindow.targetValidationTests = targetValidationTests;
debugWindow.combatStateValidationTests = combatStateValidationTests;
debugWindow.runBalanceTest = runBalanceTest;
debugWindow.runBalance = runBalance;
debugWindow.runCampaignTests = runCampaignTests;
