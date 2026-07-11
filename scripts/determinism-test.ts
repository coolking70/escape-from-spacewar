// 确定性自检的 headless 入口：用 Node 直接运行（无需浏览器）。
// 运行：npm run test:det
// 浏览器中也可用：window.runDeterministicTest() / window.runGoldenReplayTests() / window.runAcceptanceTests()
import { runDeterministicTest } from '../src/sim/deterministicTest';
import { runGoldenReplayTests } from '../src/sim/goldenReplayTests';
import { runAcceptanceTests } from '../src/sim/acceptanceTests';

const proc: any = (globalThis as any).process;

let failed = false;

const det = runDeterministicTest();
console.log('[SpaceWar] ' + det);
if (!det.startsWith('Deterministic test passed')) failed = true;

const gold = runGoldenReplayTests();
console.log('[SpaceWar] ' + gold);
if (gold.includes('FAILED')) failed = true;

const acc = runAcceptanceTests();
console.log(acc.text);
if (!acc.passed) failed = true;

if (failed) {
  proc.exit(1);
} else {
  proc.exit(0);
}
