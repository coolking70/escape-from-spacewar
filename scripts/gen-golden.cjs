// 一次性生成黄金基线指纹（CommonJS，require 编译产物 .tmp-test）。
// 仅输出候选值，不写入源码。开发者需人工核对规则后再将输出粘贴进 GOLDEN_EXPECTED。
const mod = require('../.tmp-test/src/sim/goldenReplayTests.js');
const { GOLDEN_CASES, fingerprintOf } = mod;

console.log('  // ===== 候选黄金值（人工核对后再内嵌；禁止 runGoldenReplayTests 自动写入） =====');
for (const c of GOLDEN_CASES) {
  const fp = fingerprintOf(c.cfg, c.maxTicks);
  console.log(`  '${c.name}': ${JSON.stringify(fp)},`);
}
