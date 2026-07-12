// 命令行完整验收入口（无需浏览器）。
// 运行：npm run test:acceptance
// 执行全部验收套件（含舰队校验），任一失败时退出码非 0。
import { runAcceptanceTests } from '../src/sim/acceptanceTests';

const proc: any = (globalThis as any).process;

const acc = runAcceptanceTests();
console.log(acc.text);
if (!acc.passed) {
  console.log('\n❌ 存在失败的套件');
  proc.exit(1);
} else {
  console.log('\n✅ 全部套件通过');
  proc.exit(0);
}
