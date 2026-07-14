import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { generateUniverse } from './universeGenerator';
import { decodeUniverse, encodeUniverse, validateUniverseState } from './universePersistence';
import {
  FACILITY_DEFINITIONS,
  RESEARCH_DEFINITIONS,
  applyStrategicBattleResult,
  applyUniverseAction,
  canEngageEnemy,
  canRepairShip,
  crisisPhaseForTurn,
  previewExtractLosses,
  strategicFleetCounts,
  strategicFleetPower,
  travelFuelCost,
  universeTurnIncome
} from './universeRules';
import { campaignShipCost } from '../campaign/fleet/campaignPower';
import { getShipDef } from '../sim/shipVariants';
import { strategicEnemyFleetFor } from '../campaign/fleet/battleAdapter';
import type { PersistentBattleBinding } from '../campaign/fleet/battleAdapter';
import type { BattleState, CombatState } from '../sim/battleTypes';

function graphReachable(state: ReturnType<typeof generateUniverse>): boolean {
  const seen = new Set<string>([state.systems[0].id]);
  const queue = [state.systems[0].id];
  while (queue.length) {
    const id = queue.shift()!;
    const system = state.systems.find((candidate) => candidate.id === id)!;
    for (const neighbor of system.neighbors) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return seen.size === state.systems.length;
}

function establishStartingBase(state: ReturnType<typeof generateUniverse>) {
  const station = state.entities.find((entity) =>
    entity.systemId === state.fleet.systemId && entity.kind === 'station'
  )!;
  return applyUniverseAction(state, { type: 'establishBase', entityId: station.id });
}

function prepareGate(state: ReturnType<typeof generateUniverse>, calibration: number) {
  const next = JSON.parse(JSON.stringify(state)) as ReturnType<typeof generateUniverse>;
  const gate = next.entities.find((entity) => entity.id === next.extraction.gateEntityId)!;
  const system = next.systems.find((candidate) => candidate.id === gate.systemId)!;
  gate.discovered = true;
  gate.surveyed = true;
  next.extraction.discovered = true;
  next.extraction.calibration = calibration;
  next.fleet.systemId = system.id;
  next.selectedSystemId = system.id;
  system.discovered = true;
  system.control = 'neutral';
  system.enemyPower = 0;
  if (!next.faction.knownSystemIds.includes(system.id)) next.faction.knownSystemIds.push(system.id);
  next.faction.resources.supplies = 50;
  next.fleet.fuel = next.fleet.maxFuel;
  return next;
}

/** 与 universePersistence 保持一致的 base64url 编码，用于构造旧版 alpha.2 远征码。 */
function b64urlEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 用最小字段构造一个可被写回逻辑消费的战斗结果（写回辅助函数只读其中少数字段）。 */
function makeBattle(
  aShips: Array<{ id: number; combatState: CombatState; hp: number; maxHp: number }>,
  bShips: Array<{ id: number; combatState: CombatState; hp: number; maxHp: number }>
): BattleState {
  const ships = [
    ...aShips.map((s) => ({ id: s.id, team: 'A', type: 'Frigate', variant: 'standard', combatState: s.combatState, components: [{ hp: s.hp, maxHp: s.maxHp }] })),
    ...bShips.map((s) => ({ id: s.id, team: 'B', type: 'Cruiser', variant: 'standard', combatState: s.combatState, components: [{ hp: s.hp, maxHp: s.maxHp }] }))
  ];
  return {
    version: '0.5',
    seed: 1,
    tick: 100,
    maxTicks: 120,
    ships: ships as never,
    shots: [],
    explosions: [],
    finished: true,
    winner: 'A',
    teamACount: aShips.length,
    teamBCount: bShips.length,
    teamFocusTarget: { A: null, B: null },
    teamDoctrine: { A: 'balanced', B: 'balanced' },
    stats: {} as never
  } as unknown as BattleState;
}

/** 构造一个已锁定待处理战斗的状态，并返回玩家舰绑定与敌方舰战斗 id。 */
function lockPendingBattle(seed: number, enemyPower: number) {
  let state = generateUniverse(seed);
  const hostile = state.systems.find((s) => s.control === 'enemy')!;
  state.fleet.systemId = hostile.id;
  state.selectedSystemId = hostile.id;
  hostile.discovered = true;
  hostile.enemyPower = enemyPower;
  state = applyUniverseAction(state, { type: 'engageEnemy' });
  const ids = state.fleet.ships.map((s) => s.campaignShipId);
  const bindings: PersistentBattleBinding[] = ids.map((cid, i) => ({ campaignShipId: cid, battleShipId: i }));
  const enemyTotal = state.pendingBattle!.enemyFleet.reduce((sum, e) => sum + Math.max(0, Math.floor(e.count)), 0);
  const enemyIds = Array.from({ length: enemyTotal }, (_, i) => 100 + i);
  return { state, bindings, enemyIds, ids, hostileId: hostile.id };
}

export function runStrategicTests(): SuiteResult {
  return runSuite('strategic-sector-v1.0', (add) => {
    {
      const test = new Case('每个星域按 seed 生成完整战略结构');
      const first = generateUniverse(1001, '开拓局');
      const same = generateUniverse(1001, '开拓局');
      const different = generateUniverse(1002, '开拓局');
      const signature = (state: typeof first) => JSON.stringify({ systems: state.systems, entities: state.entities });
      test.eq(signature(first), signature(same), '相同 seed 生成相同星系、航线、实体和敌情');
      test.true_(signature(first) !== signature(different), '不同 seed 生成不同星域');
      test.eq(first.systems.length, 9, '单个星域包含九个战略星系');
      test.true_(graphReachable(first), '星域航线图整体连通');
      test.true_(first.entities.some((entity) => entity.kind === 'jumpGate'), '存在唯一撤离星门');
      test.true_(first.entities.some((entity) => entity.kind === 'relicSite'), '存在可带走蓝图的科研遗迹');
      test.true_(first.systems.filter((system) => system.control === 'enemy').length >= 2, '星域开局存在真实敌方控制区');
      test.eq(first.faction.baseEntityId, undefined, '开局没有免费永久基地');
      test.eq(first.crisis.phase, 'foothold', '开局处于立足窗口');
      test.true_(Array.isArray(first.fleet.ships) && first.fleet.ships.length > 0, '开局舰队为真实逐舰数组');
      add(test);
    }

    {
      const test = new Case('占领据点后可进行临时建设与回合生产');
      let state = establishStartingBase(generateUniverse(1003));
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(!!base && base.ownerId === state.faction.id, '已占领废弃空间站建立前进基地');
      const before = state.faction.resources.minerals;
      state = applyUniverseAction(state, { type: 'queueConstruction', facilityType: 'miningArray' });
      test.eq(state.faction.resources.minerals, before - FACILITY_DEFINITIONS.miningArray.cost.minerals!, '建设成本立即扣除');
      for (let turn = 0; turn < FACILITY_DEFINITIONS.miningArray.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      const completedBase = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      test.true_(completedBase.facilities?.some((facility) => facility.type === 'miningArray') ?? false, '临时采矿阵列按回合完成');
      test.eq(universeTurnIncome(state).minerals, 4, '设施开始提供本星域回合产出');
      add(test);
    }

    {
      const test = new Case('本地科研提供快速收益但穿越星门后重置');
      let state = establishStartingBase(generateUniverse(1004));
      state.faction.resources.science = 30;
      state = applyUniverseAction(state, { type: 'queueResearch', projectId: 'routeAnalysis' });
      for (let turn = 0; turn < RESEARCH_DEFINITIONS.routeAnalysis.turns; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.true_(state.faction.localResearch.includes('routeAnalysis'), '本地航路解析研究完成');
      test.eq(travelFuelCost(state), 1, '本星域航行燃料降低');
      const prepared = prepareGate(state, 100);
      const nextSector = applyUniverseAction(prepared, { type: 'extractSector', mode: 'stable' });
      test.eq(nextSector.sectorIndex, 2, '稳定撤离后生成下一完整战略星域');
      test.eq(nextSector.faction.localResearch.length, 0, '本地科研在跨星域后重置');
      test.eq(nextSector.faction.baseEntityId, undefined, '临时基地不会跨星域继承');
      test.eq(nextSector.faction.legacy.sectorsCleared, 1, '跨星域进度进入长期继承状态');
      add(test);
    }

    {
      const test = new Case('危机阶段随时间升级并最终摧毁未撤离舰队');
      let state = generateUniverse(1005);
      test.eq(crisisPhaseForTurn(Math.ceil(state.crisis.finalTurn * 0.4), state.crisis.finalTurn), 'contest', '中段进入争夺阶段');
      test.eq(crisisPhaseForTurn(Math.ceil(state.crisis.finalTurn * 0.7), state.crisis.finalTurn), 'collapse', '后段进入崩溃阶段');
      for (let turn = 0; turn <= state.crisis.finalTurn; turn++) {
        state = applyUniverseAction(state, { type: 'advanceTurn' });
      }
      test.eq(state.status, 'collapsed', '超过最终撤离窗口后战役失败');
      test.eq(state.crisis.phase, 'evacuation', '终局处于最终撤离阶段');
      add(test);
    }

    {
      const test = new Case('敌军是地图实体压力：engageEnemy 仅创建待处理战斗且不立即削减战力');
      let state = generateUniverse(1006);
      const hostile = state.systems.find((system) => system.control === 'enemy')!;
      state.fleet.systemId = hostile.id;
      state.selectedSystemId = hostile.id;
      hostile.discovered = true;
      hostile.enemyPower = 18;
      const before = hostile.enemyPower;
      state = applyUniverseAction(state, { type: 'engageEnemy' });
      const updated = state.systems.find((system) => system.id === hostile.id)!;
      test.eq(updated.enemyPower, before, 'engageEnemy 仅创建待处理战斗，不直接削减敌方战力');
      test.true_(!!state.pendingBattle, '攻击生成 PendingStrategicBattle');
      test.true_(!!state.pendingBattle && state.pendingBattle.enemyFleet.reduce((sum, e) => sum + e.count, 0) > 0, '待处理战斗按 StarSystem.enemyPower 预算确定性生成敌军');
      add(test);
    }

    {
      const test = new Case('待处理战斗锁定其他战略行动（travel/advanceTurn 被阻止，selectSystem 允许）');
      const { state } = lockPendingBattle(1017, 30);
      const turnBefore = state.turn;
      const advanced = applyUniverseAction(state, { type: 'advanceTurn' });
      test.eq(advanced.turn, turnBefore, '存在待处理战斗时推进回合被阻止');
      const selected = state.systems.find((s) => s.id !== state.selectedSystemId)!;
      const afterSelect = applyUniverseAction(state, { type: 'selectSystem', systemId: selected.id });
      test.eq(afterSelect.selectedSystemId, selected.id, '选择星系在待处理战斗时仍允许');
      test.true_(!!afterSelect.pendingBattle, '选择星系不会清除待处理战斗');
      add(test);
    }

    {
      const test = new Case('战略敌军舰队确定性生成（同 seed 一致 + 不压缩强敌）');
      const opts = { sectorIndex: 2, gateGuard: false, cruiserAllowed: true };
      const a = strategicEnemyFleetFor(777, 120, opts);
      const b = strategicEnemyFleetFor(777, 120, opts);
      test.eq(JSON.stringify(a), JSON.stringify(b), '相同 seed 与预算生成完全相同的敌军舰队');
      const weak = strategicEnemyFleetFor(1, 60, opts);
      const strong = strategicEnemyFleetFor(1, 320, opts);
      const weakTotal = weak.reduce((sum, e) => sum + e.count, 0);
      const strongTotal = strong.reduce((sum, e) => sum + e.count, 0);
      test.true_(strongTotal > weakTotal, '强敌生成更多舰船（不采用战役式压缩安全上限）');
      const weakPower = weak.reduce((sum, e) => sum + e.count * campaignShipCost(e.shipClass, e.variant), 0);
      test.true_(weakPower >= 50, '敌方强度由预算决定而非被低估');
      add(test);
    }

    {
      const test = new Case('维修坞能逐舰恢复失能舰并消耗本地资源');
      let state = establishStartingBase(generateUniverse(1007));
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      base.facilities!.push({ id: 'test-repair-dock', type: 'repairDock', level: 1 });
      const ship = state.fleet.ships[0];
      const def = getShipDef(ship.shipClass, ship.variant).def;
      const keyIdx = def.components.findIndex((c) => c.type === 'engine' || c.type === 'core' || c.type === 'weapon');
      ship.componentHp = def.components.map((c, i) => (i === keyIdx ? 0 : c.maxHp));
      ship.disabled = true;
      state.faction.resources.supplies = 20;
      state.faction.resources.minerals = 20;
      const cid = ship.campaignShipId;
      test.true_(canRepairShip(state, cid), '失能舰在拥有维修坞与资源时可维修');
      const suppliesBefore = state.faction.resources.supplies;
      const mineralsBefore = state.faction.resources.minerals;
      state = applyUniverseAction(state, { type: 'repairShip', campaignShipId: cid });
      test.true_(!state.fleet.ships.find((s) => s.campaignShipId === cid)!.disabled, '失能舰恢复战斗能力');
      test.true_(state.fleet.ships.find((s) => s.campaignShipId === cid)!.componentHp![keyIdx] > 0, '被摧毁的关键组件已恢复');
      test.true_(state.faction.resources.supplies < suppliesBefore, '维修消耗星域补给');
      test.true_(state.faction.resources.minerals < mineralsBefore, '维修消耗星域矿物');
      add(test);
    }

    {
      const test = new Case('canRepairShip 仅在拥有 repairDock 且资源充足且舰船失能时为真');
      let state = establishStartingBase(generateUniverse(1012));
      const base = state.entities.find((entity) => entity.id === state.faction.baseEntityId)!;
      const cid = state.fleet.ships[0].campaignShipId;
      test.true_(!canRepairShip(state, cid), '无 repairDock 时不可维修');
      base.facilities!.push({ id: 'rd', type: 'repairDock', level: 1 });
      const ship = state.fleet.ships[0];
      ship.disabled = true;
      ship.componentHp = getShipDef(ship.shipClass, ship.variant).def.components.map((c, i) => (i === 0 ? 0 : c.maxHp));
      state.faction.resources.supplies = 20;
      state.faction.resources.minerals = 20;
      test.true_(canRepairShip(state, cid), '拥有 repairDock、资源充足且舰船失能时可维修');
      state.faction.resources.supplies = 0;
      test.true_(!canRepairShip(state, cid), '补给不足时不可维修');
      state.faction.resources.supplies = 20;
      ship.disabled = false;
      test.true_(!canRepairShip(state, cid), '舰船未失能时不可维修');
      add(test);
    }

    {
      const test = new Case('紧急撤离会确定性损失舰船并携带压缩资源进入下一星域');
      let state = prepareGate(generateUniverse(1008), 40);
      state.crisis.pressure = 85;
      state.faction.resources.minerals = 80;
      const beforeCount = state.fleet.ships.length;
      const next = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency' });
      test.eq(next.sectorIndex, 2, '部分校准允许紧急穿越星门');
      test.true_(next.fleet.ships.length < beforeCount, '高压无断后撤离造成舰船损失');
      test.true_(next.faction.resources.minerals < 80, '只能携带少量压缩资源进入下一星域');
      test.true_(next.faction.legacy.shipsLost > 0, '永久记录跨域舰船损失');
      add(test);
    }

    {
      const test = new Case('紧急撤离丢弃失能舰（真实逐舰）');
      let state = prepareGate(generateUniverse(1013), 100);
      const ship = state.fleet.ships[0];
      const def = getShipDef(ship.shipClass, ship.variant).def;
      ship.componentHp = def.components.map((c, i) => (i === 0 ? 0 : c.maxHp));
      ship.disabled = true;
      const before = state.fleet.ships.length;
      const next = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency' });
      test.true_(next.fleet.ships.length < before, '紧急撤离丢弃失能舰');
      test.true_(next.fleet.ships.every((s) => !s.disabled), '撤离后舰队不再含失能舰');
      add(test);
    }

    {
      const test = new Case('稳定撤离零损失且携带较多资产');
      let state = prepareGate(generateUniverse(1014), 100);
      const before = state.fleet.ships.length;
      const next = applyUniverseAction(state, { type: 'extractSector', mode: 'stable' });
      test.eq(next.fleet.ships.length, before, '稳定撤离不损失舰船');
      test.true_(next.fleet.ships.every((s) => !s.disabled), '稳定撤离保留失能舰');
      add(test);
    }

    {
      const test = new Case('断后紧急撤离确定性强牺牲一艘断后舰');
      let state = prepareGate(generateUniverse(1015), 100);
      state.crisis.pressure = 30;
      const before = state.fleet.ships.length;
      const plain = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency' });
      const rear = applyUniverseAction(state, { type: 'extractSector', mode: 'emergency', rearguardShips: 1 });
      test.eq(plain.fleet.ships.length, before, '低危机无断后紧急撤离不额外损失舰船');
      test.eq(rear.fleet.ships.length, before - 1, '留下 1 艘断后舰确定性牺牲该舰');
      add(test);
    }

    {
      const test = new Case('previewExtractLosses 与实际撤离损失一致（确定性）');
      let state = prepareGate(generateUniverse(1016), 100);
      state.crisis.pressure = 85;
      const scenarios: Array<['stable' | 'emergency', number]> = [
        ['stable', 0],
        ['emergency', 0],
        ['emergency', 1]
      ];
      for (const [mode, rear] of scenarios) {
        const predicted = previewExtractLosses(state, mode, rear).length;
        const next = applyUniverseAction(state, { type: 'extractSector', mode, rearguardShips: rear });
        const actual = state.fleet.ships.length - next.fleet.ships.length;
        test.eq(actual, predicted, `模式 ${mode} 断后 ${rear} 的预测损失与实际一致`);
      }
      add(test);
    }

    {
      const test = new Case('连续三次撤离形成完整搜打撤 SLG 战役');
      let state = generateUniverse(1009);
      for (let sector = 1; sector <= 3; sector++) {
        state = prepareGate(state, 100);
        state = applyUniverseAction(state, { type: 'extractSector', mode: 'stable' });
        if (sector < 3) {
          test.eq(state.sectorIndex, sector + 1, `第 ${sector} 次撤离进入下一星域`);
          test.eq(state.status, 'active', '中途继续远征');
        }
      }
      test.eq(state.status, 'victory', '穿越第三星域后完成远征');
      test.eq(state.faction.legacy.sectorsCleared, 3, '长期状态记录三个已清理星域');
      add(test);
    }

    {
      const test = new Case('星域远征码完整往返并拒绝损坏状态（alpha.3）');
      const state = generateUniverse(1010);
      const decoded = decodeUniverse(encodeUniverse(state));
      test.eq(JSON.stringify(decoded), JSON.stringify(state), 'alpha.3 星域远征状态完整往返');
      test.true_(validateUniverseState(decoded), '往返状态通过深层校验');
      const invalidGate = JSON.parse(JSON.stringify(state));
      invalidGate.extraction.gateEntityId = 'missing-gate';
      test.true_(!validateUniverseState(invalidGate), '不存在的星门引用被拒绝');
      const duplicateBlueprint = JSON.parse(JSON.stringify(state));
      duplicateBlueprint.faction.legacy.blueprints = ['fieldLogistics', 'fieldLogistics'];
      test.true_(!validateUniverseState(duplicateBlueprint), '重复永久蓝图被拒绝');
      add(test);
    }

    {
      const test = new Case('旧版 alpha.2 抽象舰队迁移为 alpha.3 逐舰舰队并保留失能舰');
      const base = generateUniverse(1011);
      const alpha2 = JSON.parse(JSON.stringify(base));
      alpha2.version = '1.0-alpha.2';
      alpha2.fleet = {
        id: base.fleet.id,
        name: base.fleet.name,
        systemId: base.fleet.systemId,
        fuel: base.fleet.fuel,
        maxFuel: base.fleet.maxFuel,
        shipCount: 3,
        disabledShips: 1,
        combatPower: 30
      };
      const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state: alpha2 });
      const migrated = decodeUniverse(code);
      test.eq(migrated.version, '1.0-alpha.3', 'alpha.2 迁移为 alpha.3');
      test.eq(migrated.fleet.ships.length, 3, '迁移生成 3 艘逐舰');
      test.eq(migrated.fleet.ships.filter((s) => s.disabled).length, 1, '迁移保留 1 艘失能舰');
      test.true_(validateUniverseState(migrated), '迁移后状态通过深层校验');
      add(test);
    }

    {
      const test = new Case('迁移后状态移除抽象字段且为真实逐舰结构');
      const base = generateUniverse(1018);
      const alpha2 = JSON.parse(JSON.stringify(base));
      alpha2.version = '1.0-alpha.2';
      alpha2.fleet = { id: base.fleet.id, name: base.fleet.name, systemId: base.fleet.systemId, fuel: base.fleet.fuel, maxFuel: base.fleet.maxFuel, shipCount: 4, disabledShips: 0, combatPower: 40 };
      const code = b64urlEncode({ type: 'spacewar-sector-expedition', v: '1.0-alpha.2', state: alpha2 });
      const migrated = decodeUniverse(code);
      const fleetRecord = migrated.fleet as unknown as Record<string, unknown>;
      test.true_(fleetRecord.shipCount === undefined && fleetRecord.disabledShips === undefined && fleetRecord.combatPower === undefined, '迁移后不再含抽象 shipCount/disabledShips/combatPower');
      test.true_(Array.isArray(migrated.fleet.ships) && migrated.fleet.ships.every((s) => typeof s.campaignShipId === 'string'), '迁移后为真实逐舰 PersistentShip 数组');
      add(test);
    }

    {
      const test = new Case('真实逐舰战斗结果写回：destroyed 删除、敌方剩余战力由 Team B 重算、清零→neutral、单回合推进');
      const { state, bindings, enemyIds, ids, hostileId } = lockPendingBattle(1020, 30);
      const battle = makeBattle(
        ids.map((_cid, i) => ({ id: i, combatState: (i === 0 ? 'destroyed' : 'operational') as CombatState, hp: 10, maxHp: 10 })),
        enemyIds.map((eid, i) => ({ id: eid, combatState: (i === 0 ? 'operational' : 'destroyed') as CombatState, hp: 20, maxHp: 20 }))
      );
      const turnBefore = state.turn;
      const after = applyStrategicBattleResult(state, battle, bindings);
      test.true_(after !== state, '写回产生新状态');
      test.eq(after.pendingBattle, undefined, '写回后清除 pending');
      test.eq(after.fleet.ships.length, ids.length - 1, '被摧毁玩家舰从舰队中删除');
      const sys = after.systems.find((s) => s.id === hostileId)!;
      test.eq(sys.enemyPower, campaignShipCost('Cruiser', 'standard'), '敌方剩余战力由真实 Team B（满血巡洋舰）重算');
      test.eq(sys.control, 'enemy', '仍有敌方存活则星系保持敌方控制');
      test.eq(after.faction.legacy.shipsLost, 1, '永久记录 1 艘跨域损毁');
      test.eq(after.turn, turnBefore + 1, '写回仅推进一个战略回合');
      add(test);
    }

    {
      const test = new Case('战斗结果写回幂等（无 pending 时返回原状态不变）');
      const { state, bindings, enemyIds, ids } = lockPendingBattle(1021, 30);
      const battle = makeBattle(
        ids.map((_cid, i) => ({ id: i, combatState: 'operational' as CombatState, hp: 10, maxHp: 10 })),
        enemyIds.map((eid) => ({ id: eid, combatState: 'destroyed' as CombatState, hp: 0, maxHp: 20 }))
      );
      const after = applyStrategicBattleResult(state, battle, bindings);
      const again = applyStrategicBattleResult(after, battle, bindings);
      test.eq(again, after, '无 pending 时重复写回返回同一状态（幂等）');
      add(test);
    }

    {
      const test = new Case('玩家全灭→远征崩溃（无可用作战舰）');
      const { state, bindings, enemyIds, ids } = lockPendingBattle(1022, 30);
      const battle = makeBattle(
        ids.map((_cid, i) => ({ id: i, combatState: 'destroyed' as CombatState, hp: 0, maxHp: 10 })),
        enemyIds.map((eid) => ({ id: eid, combatState: 'destroyed' as CombatState, hp: 0, maxHp: 20 }))
      );
      const after = applyStrategicBattleResult(state, battle, bindings);
      test.eq(after.status, 'collapsed', '玩家舰全灭后远征崩溃');
      add(test);
    }

    {
      const test = new Case('跨星域继承真实舰队（舰船 ID 持续保留）');
      let state = generateUniverse(1023);
      const idsBefore = state.fleet.ships.map((s) => s.campaignShipId).sort();
      const prepared = prepareGate(state, 100);
      const next = applyUniverseAction(prepared, { type: 'extractSector', mode: 'stable' });
      const idsAfter = next.fleet.ships.map((s) => s.campaignShipId).sort();
      test.eq(JSON.stringify(idsAfter), JSON.stringify(idsBefore), '撤离后真实舰船 ID 完整继承到下一星域');
      test.true_(next.fleet.ships.every((s) => Array.isArray(s.componentHp) || s.componentHp === undefined), '继承舰队仍为逐舰结构');
      test.true_(strategicFleetPower(next) > 0, '继承后真实舰队仍有战力');
      add(test);
    }
  });
}
