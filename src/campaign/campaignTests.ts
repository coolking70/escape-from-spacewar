import { Case, runSuite, SuiteResult } from '../sim/testHarness';
import { createCampaign } from './campaignGenerator';
import { applyCampaignAction } from './campaignReducer';
import { decodeCampaign, encodeCampaign } from './campaignCode';
import { generateSector, isReachable } from './sector/sectorGenerator';
import { enemyBudgetFor, enemyFleetFor, deriveBattleSeed, prepareCampaignBattle, runCampaignBattle } from './fleet/battleAdapter';
import { validateFleet } from '../sim/fleetValidator';
import { clearCampaign, loadCampaign, saveCampaign } from './campaignPersistence';
import { hazardOutcome, resourceReward, signalOptions, signalTemplate } from './sector/sectorActions';
import { addThreat } from './sector/threatSystem';
import { createStarterFleet } from './fleet/persistentFleet';
import { importBattleResult } from './fleet/battleResultImporter';
import { visibleSectorGraph } from './sector/sectorVisibility';

function firstNeighbor(state: ReturnType<typeof createCampaign>) { return state.sector.nodes.find((n) => n.id === state.sector.currentNodeId)!.neighbors[0]; }
export function runCampaignTests(): SuiteResult {
  return runSuite('campaign', (add) => {
    const a = generateSector(42, 1), b = generateSector(42, 1), c = generateSector(43, 1);
    {
      const t = new Case('确定性星域生成与图约束'); const sig = (s: typeof a) => JSON.stringify(s.nodes.map((n) => [n.id, n.type, n.neighbors]));
      t.eq(sig(a), sig(b), '相同 seed 生成相同星域'); t.true_(sig(a) !== sig(c), '不同 seed 通常生成不同星域'); t.true_(a.nodes.length >= 20 && a.nodes.length <= 30, '节点数在 20~30'); t.eq(a.nodes.filter((n) => n.type === 'start').length, 1, '起点唯一'); t.eq(a.nodes.filter((n) => n.type === 'gate').length, 1, '星门唯一'); t.true_(isReachable(a, a.currentNodeId, a.nodes.find((n) => n.type === 'gate')!.id), '星门可达'); t.true_(a.nodes.every((n) => isReachable(a, a.currentNodeId, n.id)), '无孤立节点'); add(t);
    }
    {
      const t = new Case('移动、燃料与扫描'); let s = createCampaign(7); const nonNeighbor = s.sector.nodes.find((n) => ![s.sector.currentNodeId, ...s.sector.nodes.find((x) => x.id === s.sector.currentNodeId)!.neighbors].includes(n.id))!; t.eq(applyCampaignAction(s, { type: 'move', targetNodeId: nonNeighbor.id }).sector.currentNodeId, s.sector.currentNodeId, '只能移动相邻节点'); s.resources.fuel = 0; t.eq(applyCampaignAction(s, { type: 'move', targetNodeId: firstNeighbor(s) }).sector.currentNodeId, s.sector.currentNodeId, '燃料不足不能移动'); s = createCampaign(7); const scanned = applyCampaignAction(s, { type: 'scan' }); t.true_(scanned.sector.nodes.some((n) => n.visibility === 'scanned'), '扫描提升可见度'); add(t);
    }
    {
      const t = new Case('资源、威胁与敌军确定性'); let s = createCampaign(9); const resource = s.sector.nodes.find((n) => n.type === 'resource')!; const start = s.sector.nodes.find((n) => n.type === 'start')!; start.neighbors.push(resource.id); resource.neighbors.push(start.id); s = applyCampaignAction(s, { type: 'move', targetNodeId: resource.id }); const gathered = applyCampaignAction(s, { type: 'gather' }); const again = applyCampaignAction(gathered, { type: 'gather' }); t.true_(gathered.sector.threat.value > s.sector.threat.value, '采集提高威胁'); t.eq(JSON.stringify(resourceReward(s, resource.id)), JSON.stringify(resourceReward(s, resource.id)), '节点资源收益确定'); t.eq(again.resources.materials, gathered.resources.materials, '资源不能无限采集'); t.eq(addThreat({ value: 9, level: 1 }, 1).level, 2, '威胁等级效果确定'); const e1 = enemyFleetFor(100, 1, 2), e2 = enemyFleetFor(100, 1, 2); t.eq(JSON.stringify(e1), JSON.stringify(e2), '敌军生成确定'); t.true_(validateFleet(e1).valid, '敌军 FleetEntry 合法'); t.eq(deriveBattleSeed(1, 2, 'n', 3), deriveBattleSeed(1, 2, 'n', 3), '战斗 seed 稳定'); add(t);
    }
    {
      const t = new Case('星门、胜利与 Campaign Code'); let s = createCampaign(3); for (let sector = 1; sector <= 3; sector++) { const gate = s.sector.nodes.find((n) => n.type === 'gate')!; const current = s.sector.nodes.find((n) => n.id === s.sector.currentNodeId)!; current.neighbors.push(gate.id); gate.neighbors.push(current.id); s = applyCampaignAction(s, { type: 'move', targetNodeId: gate.id }); s = applyCampaignAction(s, { type: 'enterGate' }); } t.eq(s.status, 'victory', '第三星域撤离后胜利'); const roundTrip = decodeCampaign(encodeCampaign(createCampaign(99))); t.eq(roundTrip.campaignSeed, 99, 'Campaign Code 往返'); let wrong = false; try { decodeCampaign('eyJ0eXBlIjoic3BhY2V3YXItZmxlZXQifQ'); } catch (e) { wrong = String(e).includes('舰队方案码'); } t.true_(wrong, '错误 Code 类型明确拒绝'); add(t);
    }
    {
      const t = new Case('相同行动序列保持确定性'); const run = () => { let s = createCampaign(555); s = applyCampaignAction(s, { type: 'scan' }); s = applyCampaignAction(s, { type: 'wait' }); s = applyCampaignAction(s, { type: 'move', targetNodeId: firstNeighbor(s) }); return JSON.stringify(s); }; t.eq(run(), run(), '相同 seed 和行动序列结果一致'); add(t);
    }
    {
      const t = new Case('本地存档损坏安全报错'); const store = new Map<string, string>(); (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }; saveCampaign(createCampaign(15)); t.eq(loadCampaign()?.campaignSeed, 15, '本地存档可读取'); store.set('spacewar.campaign.current.v1', '{坏数据'); let threw = false; try { loadCampaign(); } catch { threw = true; } t.true_(threw, '损坏存档安全报错'); clearCampaign(); add(t);
    }
    {
      const t = new Case('战斗结果写回保持战役舰船语义'); const fleet = createStarterFleet(); const battle = { ships: [
        { id: 0, team: 'A', combatState: 'destroyed', components: [] },
        { id: 1, team: 'A', combatState: 'escaped', components: [{ hp: 3 }] },
        { id: 2, team: 'A', combatState: 'disabled', components: [{ hp: 2 }] }
      ] } as any; const next = importBattleResult(fleet, battle, [{ campaignShipId: 'cs-0', battleShipId: 0 }, { campaignShipId: 'cs-1', battleShipId: 1 }, { campaignShipId: 'cs-2', battleShipId: 2 }]); t.eq(next.ships.length, 2, 'destroyed 舰船移除'); t.true_(next.ships.some((s) => s.campaignShipId === 'cs-1' && s.escaped), 'escaped 舰船保留'); t.true_(next.ships.some((s) => s.campaignShipId === 'cs-2' && s.disabled), 'disabled 舰船保留并标记'); t.true_(next.ships.every((s) => s.campaignShipId.startsWith('cs-')), 'campaignShipId 战斗前后稳定'); add(t);
    }
    {
      const t = new Case('多舰同改型绑定与组件继承'); const fleet = createStarterFleet(); fleet.ships[1] = { ...fleet.ships[1], campaignShipId: 'cs-dup', variant: 'standard', componentHp: [1, 2, 3, 4] }; const enemy = enemyFleetFor(88, 1, 0); const context = prepareCampaignBattle(fleet, enemy, 88); t.eq(context.bindings.length, 3, '所有可参战舰船均有 binding'); t.eq(new Set(context.bindings.map((b) => b.campaignShipId)).size, 3, 'binding 不依赖同改型数组下标'); const bound = context.bindings.find((b) => b.campaignShipId === 'cs-dup')!; const ship = context.state.ships.find((s) => s.id === bound.battleShipId)!; t.eq(ship.components[0].hp, 1, '下一战继承上一战组件损伤'); const result = runCampaignBattle(fleet, enemy, 88); t.true_(result.state.finished, '无头战斗仅用于测试可正常结束'); add(t);
    }
    {
      const t = new Case('迷雾与终局拒绝行动'); const s = createCampaign(33); const graph = visibleSectorGraph(s.sector); t.true_(graph.edges.every(([a, b]) => s.sector.nodes.find((n) => n.id === a)!.visibility !== 'hidden' && s.sector.nodes.find((n) => n.id === b)!.visibility !== 'hidden'), '隐藏节点和边不会出现在可见图'); const ended = { ...s, status: 'victory' as const }; t.eq(applyCampaignAction(ended, { type: 'wait' }).turn, ended.turn, '胜利后行动被拒绝'); t.true_(enemyBudgetFor(3, 0) > enemyBudgetFor(2, 0), '高星域预算递增'); t.true_(enemyBudgetFor(2, 4) >= enemyBudgetFor(2, 0), '威胁不降低预算'); t.true_(enemyBudgetFor(2, 1, true) > enemyBudgetFor(2, 1), '星门守卫强于普通战斗'); add(t);
    }
    {
      const t = new Case('信号与危险模板完整且确定'); const names = new Set<string>(); const hazards = new Set<string>(); for (let seed = 0; seed < 300 && (names.size < 5 || hazards.size < 3); seed++) { const s = createCampaign(seed); const node = s.sector.nodes.find((n) => n.type === 'signal')!.id; const signal = signalTemplate(s, node); names.add(signal); t.eq(signalOptions(s, node).length, 2, `${signal} 有两个选项`); t.eq(JSON.stringify(signalOptions(s, node)), JSON.stringify(signalOptions(s, node)), '信号选项确定'); const hazard = hazardOutcome(s, node); hazards.add(hazard.name); t.eq(JSON.stringify(hazard), JSON.stringify(hazardOutcome(s, node)), `${hazard.name} 结算确定`); } t.eq(names.size, 5, '五个信号模板均可生成'); t.eq(hazards.size, 3, '三类 hazard 均可生成'); add(t);
    }
    {
      const t = new Case('深层损坏 Campaign Code 被拒绝'); const valid = createCampaign(66); const duplicate = JSON.parse(JSON.stringify(valid)); duplicate.fleet.ships.push({ ...duplicate.fleet.ships[0] }); const badEdge = JSON.parse(JSON.stringify(valid)); badEdge.sector.nodes[0].neighbors.push('missing-node'); const code = (state: unknown) => encodeCampaign(state as any); let duplicateRejected = false, edgeRejected = false; try { code(duplicate); } catch { duplicateRejected = true; } try { code(badEdge); } catch { edgeRejected = true; } t.true_(duplicateRejected, '重复 campaignShipId 被拒绝'); t.true_(edgeRejected, '非法节点连线被拒绝'); add(t);
    }
  });
}
