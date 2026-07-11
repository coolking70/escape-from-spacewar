// 战斗视图筛选偏好：纯 UI 状态，绝对不允许进入 replay 代码（不影响战斗结果）。
// 默认全部关闭，用户可在战斗中随时切换并自动持久化到 localStorage。

export interface ViewFilters {
  /** 舰船标签（id + 改型） */
  labels: boolean;
  /** 组件受损标记（摧毁的组件上显示红色线框标记） */
  componentDamage: boolean;
  /** 支援光环范围（线框球，按光环类型着色） */
  auraRanges: boolean;
  /** 武器射程（仅选中舰船时显示其最大射程线框球） */
  weaponRanges: boolean;
  /** 目标连线（存活舰船 -> 当前目标） */
  targetLines: boolean;
  /** 仅显示选中目标（隐藏其余舰船网格） */
  selectedOnly: boolean;
}

export const DEFAULT_VIEW_FILTERS: ViewFilters = {
  labels: false,
  componentDamage: false,
  auraRanges: false,
  weaponRanges: false,
  targetLines: false,
  selectedOnly: false
};

export const VIEW_PREFS_KEY = 'spacewar:viewPrefs';

export function loadViewPrefs(): ViewFilters {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (!raw) return { ...DEFAULT_VIEW_FILTERS };
    const obj = JSON.parse(raw);
    const out: ViewFilters = { ...DEFAULT_VIEW_FILTERS };
    (Object.keys(DEFAULT_VIEW_FILTERS) as (keyof ViewFilters)[]).forEach((k) => {
      if (typeof obj[k] === 'boolean') out[k] = obj[k];
    });
    return out;
  } catch {
    return { ...DEFAULT_VIEW_FILTERS };
  }
}

export function saveViewPrefs(f: ViewFilters): void {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(f));
  } catch {
    /* 存储不可用时静默忽略 */
  }
}
