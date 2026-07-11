// 将 /tmp/golden-expected.ts 的 GOLDEN_EXPECTED 块插入 goldenReplayTests.ts，替换原占位块。
const fs = require('fs');
const target = '/Users/coolking70/WorkBuddy/spacewar/src/sim/goldenReplayTests.ts';
const src = '/tmp/golden-expected.ts';

const expectedBlock = fs.readFileSync(src, 'utf8').trim();
let content = fs.readFileSync(target, 'utf8');

const re = /export const GOLDEN_EXPECTED: Record<string, string> = \{[\s\S]*?\n\};/;
if (!re.test(content)) {
  console.error('未找到 GOLDEN_EXPECTED 块');
  process.exit(1);
}
content = content.replace(re, expectedBlock);
fs.writeFileSync(target, content);
console.log('已替换 GOLDEN_EXPECTED 块');
