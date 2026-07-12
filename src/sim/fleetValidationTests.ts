// 舰队校验测试套件：验证 validateFleetEntry / validateFleet / assertValidFleetEntry
// 确保非法 shipClass+variant 组合被正确拒绝，不静默回退。

import { runSuite, Case } from './testHarness';
import {
  validateFleetEntry,
  validateFleet,
  assertValidFleetEntry,
  assertValidFleet,
  normalizeFleet,
  parseFleet,
  MAX_FLEET_SHIPS
} from './fleetValidator';
import { FleetEntry } from './battleTypes';

export function runFleetValidationTests() {
  return runSuite('fleetValidation', (add) => {
    // 1. 合法组合应通过
    const legalCombos: FleetEntry[] = [
      { shipClass: 'Fighter', variant: 'standard', count: 5 },
      { shipClass: 'Fighter', variant: 'interceptor', count: 3 },
      { shipClass: 'Fighter', variant: 'bomber', count: 2 },
      { shipClass: 'Fighter', variant: 'scout', count: 1 },
      { shipClass: 'Frigate', variant: 'standard', count: 2 },
      { shipClass: 'Frigate', variant: 'escort', count: 1 },
      { shipClass: 'Frigate', variant: 'artillery', count: 1 },
      { shipClass: 'Frigate', variant: 'support', count: 1 },
      { shipClass: 'Cruiser', variant: 'standard', count: 1 },
      { shipClass: 'Cruiser', variant: 'battleship', count: 1 },
      { shipClass: 'Cruiser', variant: 'carrier', count: 1 },
      { shipClass: 'Cruiser', variant: 'fortress', count: 1 }
    ];
    for (const e of legalCombos) {
      const c = new Case(`合法 ${e.shipClass}+${e.variant}`);
      const r = validateFleetEntry(e);
      c.true_(r.valid, `应通过: ${r.errors.join(';')}`);
      add(c);
    }

    // 2. 非法组合应被拒绝
    const illegalCombos: FleetEntry[] = [
      { shipClass: 'Fighter', variant: 'escort', count: 1 },
      { shipClass: 'Fighter', variant: 'carrier', count: 1 },
      { shipClass: 'Frigate', variant: 'interceptor', count: 1 },
      { shipClass: 'Frigate', variant: 'carrier', count: 1 },
      { shipClass: 'Cruiser', variant: 'interceptor', count: 1 },
      { shipClass: 'Cruiser', variant: 'bomber', count: 1 }
    ];
    for (const e of illegalCombos) {
      const c = new Case(`非法 ${e.shipClass}+${e.variant}`);
      const r = validateFleetEntry(e);
      c.true_(!r.valid, `应拒绝: ${e.shipClass}+${e.variant}`);
      c.true_(r.errors.some((msg) => msg.includes('非法')), `错误信息应含"非法": ${r.errors.join(';')}`);
      add(c);
    }

    // 3. 未知舰种
    {
      const c = new Case('未知舰种');
      const r = validateFleetEntry({ shipClass: 'Destroyer' as any, variant: 'standard', count: 1 });
      c.true_(!r.valid, '应拒绝未知舰种');
      add(c);
    }

    // 4. count 校验
    {
      const c = new Case('count=0 拒绝');
      c.true_(!validateFleetEntry({ shipClass: 'Fighter', variant: 'standard', count: 0 }).valid, 'count=0 应拒绝');
      add(c);
    }
    {
      const c = new Case('count=负数 拒绝');
      c.true_(!validateFleetEntry({ shipClass: 'Fighter', variant: 'standard', count: -5 }).valid, 'count<0 应拒绝');
      add(c);
    }
    {
      const c = new Case('count=NaN 拒绝');
      c.true_(!validateFleetEntry({ shipClass: 'Fighter', variant: 'standard', count: NaN }).valid, 'NaN 应拒绝');
      add(c);
    }

    // 5. 空舰队
    {
      const c = new Case('空舰队拒绝');
      c.true_(!validateFleet([]).valid, '空舰队应拒绝');
      add(c);
    }

    // 6. 重复条目
    {
      const c = new Case('重复条目报告');
      const r = validateFleet([
        { shipClass: 'Fighter', variant: 'standard', count: 3 },
        { shipClass: 'Fighter', variant: 'standard', count: 2 }
      ]);
      c.true_(r.errors.some((e) => e.includes('重复')), `应报告重复: ${r.errors.join(';')}`);
      add(c);
    }

    // 7. 总数超限
    {
      const c = new Case('总数超限拒绝');
      const r = validateFleet([{ shipClass: 'Fighter', variant: 'standard', count: MAX_FLEET_SHIPS + 1 }]);
      c.true_(!r.valid, '应拒绝超过上限');
      c.true_(r.errors.some((e) => e.includes('超过上限')), `应报告超限: ${r.errors.join(';')}`);
      add(c);
    }

    // 8. assertValidFleetEntry 抛错
    {
      const c = new Case('assertValidFleetEntry 抛错');
      let threw = false;
      try { assertValidFleetEntry({ shipClass: 'Frigate', variant: 'carrier', count: 1 }); } catch { threw = true; }
      c.true_(threw, '应抛错');
      add(c);
    }

    // 9. assertValidFleet 合法通过
    {
      const c = new Case('assertValidFleet 合法通过');
      let threw = false;
      try {
        assertValidFleet([
          { shipClass: 'Fighter', variant: 'standard', count: 3 },
          { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
        ]);
      } catch { threw = true; }
      c.true_(!threw, '合法舰队不应抛错');
      add(c);
    }

    // 10. normalizeFleet 合并重复
    {
      const c = new Case('normalizeFleet 合并重复');
      const result = normalizeFleet([
        { shipClass: 'Fighter', variant: 'standard', count: 3 },
        { shipClass: 'Fighter', variant: 'standard', count: 2 },
        { shipClass: 'Cruiser', variant: 'carrier', count: 1 }
      ]);
      c.eq(result.length, 2, '应合并为 2 条');
      c.eq(result[0].count, 5, 'Fighter count 应为 5');
      add(c);
    }

    // 11. normalizeFleet 非法组合抛错
    {
      const c = new Case('normalizeFleet 非法抛错');
      let threw = false;
      try { normalizeFleet([{ shipClass: 'Frigate', variant: 'carrier', count: 1 }]); } catch { threw = true; }
      c.true_(threw, '应抛错');
      add(c);
    }

    // 12. 外部输入严格解析：不转换字符串数量，也不回退非法改型
    {
      const c = new Case('parseFleet 严格拒绝外部非法输入');
      let badVariant = false;
      let stringCount = false;
      try { parseFleet([{ shipClass: 'Frigate', variant: 'carrier', count: 1 }]); } catch { badVariant = true; }
      try { parseFleet([{ shipClass: 'Fighter', variant: 'standard', count: '1' }]); } catch { stringCount = true; }
      c.true_(badVariant, '非法改型组合应抛错');
      c.true_(stringCount, '字符串数量应抛错，不自动转换');
      add(c);
    }
  });
}
