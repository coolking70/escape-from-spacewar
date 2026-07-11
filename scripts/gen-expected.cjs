// 生成完整的 GOLDEN_EXPECTED 块（CommonJS，require 编译产物 .tmp-test）。
const mod = require('../.tmp-test/src/sim/goldenReplayTests.js');
const { GOLDEN_CASES, fingerprintOf } = mod;
const fs = require('fs');
const lines = [];
lines.push('export const GOLDEN_EXPECTED: Record<string, string> = {');
for (const c of GOLDEN_CASES) {
  const fp = fingerprintOf(c.cfg, c.maxTicks);
  lines.push('  // ' + c.name);
  lines.push("  '" + c.name + "': " + JSON.stringify(fp) + ',');
}
lines.push('};');
fs.writeFileSync('/tmp/golden-expected.ts', lines.join('\n'));
console.log('written, lines=' + lines.length);
