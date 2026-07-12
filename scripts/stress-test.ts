// 压力测试命令行入口（无需浏览器）。
// 运行：npm run test:stress
// 执行 50v50 压力测试（含 Carrier），验证确定性、舰数守恒、无异常。
import { runSimulationStressTest } from '../src/sim/stressTest';

const proc: any = (globalThis as any).process;

console.log('[SpaceWar] 开始压力测试（50v50，含 Carrier）...\n');
const result = runSimulationStressTest();

console.log(`完成: ${result.completed ? '是' : '否'}`);
console.log(`Tick: ${result.tick}`);
console.log(`耗时: ${result.durationMs}ms`);
console.log(`胜者: ${result.winner ?? '无'}`);
console.log(`结束原因: ${result.victoryReason}`);
console.log(`摘要哈希: ${result.summaryHash}`);
console.log(`哈希稳定: ${result.hashStable ? '是' : '否'}`);
console.log(`诊断: ${JSON.stringify(result.diagnostics)}`);
console.log('');
for (const note of result.notes) console.log('  ' + note);

console.log(`\n结果: ${result.passed ? '✅ 通过' : '❌ 失败'}`);
proc.exit(result.passed ? 0 : 1);
