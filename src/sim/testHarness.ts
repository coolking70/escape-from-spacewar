// 轻量单元测试框架（纯 sim，无 DOM / 渲染）。
// 仅提供断言与套件计时；断言失败不影响其它套件，结果由 runAcceptanceTests 汇总。

export interface TestResult {
  name: string;
  passed: boolean;
  failures: string[];
  notes: string[];
}

export interface SuiteResult {
  name: string;
  passed: boolean;
  durationMs: number;
  messages: string[];
}

/** 单个用例收集器 */
export class Case {
  private failures: string[] = [];
  private notes: string[] = [];
  constructor(public readonly name: string) {}

  ok(cond: boolean, msg: string): void {
    if (cond) this.notes.push(`  ✓ ${msg}`);
    else this.failures.push(`  ✗ ${msg}`);
  }
  eq<T>(actual: T, expected: T, msg: string): void {
    if (actual === expected) this.notes.push(`  ✓ ${msg}`);
    else this.failures.push(`  ✗ ${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`);
  }
  /** 浮点近似（明确精度） */
  approx(actual: number, expected: number, eps: number, msg: string): void {
    const d = Math.abs(actual - expected);
    if (d <= eps) this.notes.push(`  ✓ ${msg}`);
    else this.failures.push(`  ✗ ${msg}（期望≈${expected}±${eps}，实际 ${actual}）`);
  }
  /** 明确精度比较：a 与 b 在小数点后 p 位一致 */
  close(a: number, b: number, digits: number, msg: string): void {
    const f = (x: number) => Math.round(x * 10 ** digits) / 10 ** digits;
    this.eq(f(a), f(b), `${msg}（${digits} 位精度：${f(a)} vs ${f(b)}）`);
  }
  true_(cond: boolean, msg: string): void {
    this.ok(!!cond, msg);
  }
  fail(msg: string): void {
    this.failures.push(`  ✗ ${msg}`);
  }
  get result(): TestResult {
    return {
      name: this.name,
      passed: this.failures.length === 0,
      failures: this.failures,
      notes: this.notes
    };
  }
}

/** 计时并运行一组用例，返回结构化结果 */
export function runSuite(name: string, fn: (add: (c: Case) => void) => void): SuiteResult {
  const start = Date.now();
  const cases: Case[] = [];
  const add = (c: Case) => cases.push(c);
  try {
    fn(add);
  } catch (e) {
    const crash = new Case(name + ' (异常)');
    crash.fail(`运行异常: ${String(e)}`);
    cases.push(crash);
  }
  const durationMs = Date.now() - start;
  const failures = cases.flatMap((c) => c.result.failures);
  const notes = cases.flatMap((c) => c.result.notes);
  const passed = cases.every((c) => c.result.passed);
  const messages = [...notes, ...failures];
  if (failures.length) messages.unshift(`[FAIL] ${name}: ${failures.length} 项失败`);
  else messages.unshift(`[PASS] ${name}: 全部通过（${cases.length} 项）`);
  return { name, passed, durationMs, messages };
}
