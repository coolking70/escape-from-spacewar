// 深拷贝工具：保证 FleetPreset / ReplayConfig / TeamConfig / 改型解析结果等纯数据对象
// 在 UI 编辑、载入、导入导出、checkpoint 恢复时不被共享引用污染。
//
// 优先使用浏览器原生 structuredClone（深拷贝、不修改原型链、可处理嵌套对象/数组/Map）。
// 对不支持 structuredClone 的旧环境回退到手写 JSON 克隆（覆盖本项目使用的纯数据结构）。

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 某些类型（函数、DOM、Symbol）无法结构化克隆 → 回退
    }
  }
  return jsonClone(value);
}

/** JSON 回退克隆：仅适用于纯可序列化数据 */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 深拷贝一条编队项 */
export function cloneFleetEntry(e: {
  shipClass: string;
  variant: string;
  count: number;
}): { shipClass: string; variant: string; count: number } {
  return { shipClass: e.shipClass, variant: e.variant, count: e.count };
}

/**
 * 深拷贝一组 FleetEntry[]（用于从内置预设/用户方案载入到 A/B 后互不干扰）。
 */
export function cloneFleet(
  fleet: { shipClass: string; variant: string; count: number }[]
): { shipClass: string; variant: string; count: number }[] {
  return fleet.map(cloneFleetEntry);
}

/**
 * 深拷贝一个 TeamConfig（fleet + formation + doctrine）。
 */
export function cloneTeamConfig(team: {
  fleet: { shipClass: string; variant: string; count: number }[];
  formation: string;
  doctrine: string;
}): {
  fleet: { shipClass: string; variant: string; count: number }[];
  formation: string;
  doctrine: string;
} {
  return {
    fleet: cloneFleet(team.fleet),
    formation: team.formation,
    doctrine: team.doctrine
  };
}

/**
 * 深拷贝一个 ReplayConfig（载入/导入/开始战斗后，修改设置缓存不污染运行中的 BattleState）。
 */
export function cloneReplayConfig<T extends object>(cfg: T): T {
  return deepClone(cfg);
}
