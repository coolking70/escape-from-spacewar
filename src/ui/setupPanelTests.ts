import { FleetEntry } from '../sim/battleTypes';
import { validateFleet } from '../sim/fleetValidator';
import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { findFirstUnusedFleetEntry, getSetupStartState } from './setupPanel';

const DEFAULT_FLEET: FleetEntry[] = [
  { shipClass: 'Fighter', variant: 'standard', count: 3 },
  { shipClass: 'Frigate', variant: 'standard', count: 1 }
];

export function setupPanelTests(): SuiteResult {
  return runSuite('setupPanel', (add) => {
    {
      const c = new Case('添加编队项避开默认组合');
      const next = findFirstUnusedFleetEntry(DEFAULT_FLEET);
      const fleet = [...DEFAULT_FLEET, next!];
      c.eq(next?.shipClass, 'Fighter', '默认舰队后的首项仍为 Fighter');
      c.eq(next?.variant, 'interceptor', '默认舰队后的首项为 interceptor');
      c.true_(validateFleet(fleet).valid, '添加后不存在重复条目');
      add(c);
    }

    {
      const c = new Case('添加编队项按稳定顺序遍历');
      const fleet: FleetEntry[] = [];
      const sequence: string[] = [];
      for (;;) {
        const next = findFirstUnusedFleetEntry(fleet);
        if (!next) break;
        sequence.push(`${next.shipClass}:${next.variant}`);
        fleet.push(next);
      }
      c.eq(sequence.join(','), [
        'Fighter:standard', 'Fighter:interceptor', 'Fighter:bomber', 'Fighter:scout',
        'Frigate:standard', 'Frigate:escort', 'Frigate:artillery', 'Frigate:support',
        'Cruiser:standard', 'Cruiser:battleship', 'Cruiser:carrier', 'Cruiser:fortress'
      ].join(','), '按舰种和改型稳定顺序添加');
      c.eq(fleet.length, 12, '共遍历 12 种合法组合');
      c.true_(validateFleet(fleet).valid, '完整组合舰队合法');
      add(c);
    }

    {
      const c = new Case('12 种组合均已使用时不再添加');
      const fleet: FleetEntry[] = [];
      for (;;) {
        const next = findFirstUnusedFleetEntry(fleet);
        if (!next) break;
        fleet.push(next);
      }
      c.eq(findFirstUnusedFleetEntry(fleet), null, '全部组合用尽时返回 null');
      add(c);
    }

    {
      const c = new Case('重复配置禁用开始战斗');
      const duplicate = [...DEFAULT_FLEET, { shipClass: 'Fighter' as const, variant: 'standard' as const, count: 1 }];
      const state = getSetupStartState(duplicate, DEFAULT_FLEET, false, 1000);
      c.true_(!state.canStart, '开始按钮应禁用');
      c.true_(state.message.includes('重复条目'), '提示应说明重复条目');
      add(c);
    }

    {
      const c = new Case('合法配置允许开始战斗');
      const state = getSetupStartState(DEFAULT_FLEET, DEFAULT_FLEET, false, 1000);
      c.true_(state.canStart, '开始按钮应可用');
      c.true_(state.message.includes('配置有效'), '提示应说明配置有效');
      add(c);
    }
  });
}
