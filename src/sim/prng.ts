// 确定性伪随机数生成器 (Deterministic PRNG)
//
// 战斗逻辑只能使用这里的 PRNG，绝不能用 Math.random / Date.now。
// mulberry32：32 位种子、速度快、序列完全由 seed 决定。

export interface PRNG {
  /** 返回 [0, 1) 的浮点数 */
  next(): number;
  /** 返回 [0, maxExclusive) 的整数 */
  int(maxExclusive: number): number;
  /** 返回 [min, max) 的浮点数 */
  range(min: number, max: number): number;
}

export function createPRNG(seed: number): PRNG {
  // 统一规范为无符号 32 位整数
  let a = seed >>> 0;

  function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    range: (min: number, max: number) => min + next() * (max - min)
  };
}
