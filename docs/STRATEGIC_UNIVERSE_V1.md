# V1.0 Strategic Universe Vertical Slice

> ⚠️ 历史文档：本文件记录 V1.0-A 的初版设计（抽象舰队占位、`1.0-alpha.2` 存档）。
> V1.0-B 已将战略层接入真实逐舰持久舰队与 `core-v4` 实战，存档升级为 `1.0-alpha.3`，
> 抽象字段（`shipCount` / `disabledShips` / `combatPower`）已移除。
> V1.0-B.1 进一步将战略 / 战役敌军、战后剩余战力、存档迁移统一到 core-v4 舰船成本量纲，存档升级为 `1.0-alpha.4`。
> V1.0-B.2 将战略战斗结果闭环为完全自洽、可重载的状态机（深度 `BattleState` 校验、低残余敌战力归一化、`1.0-alpha.4`→`1.0-alpha.5` 迁移硬化、UI 锁定加固），存档升级为 `1.0-alpha.5`，策略测试套件扩展至 55 例（含真实集成写回）。
> V1.0-B.3 进一步闭合低预算敌军生成（子最低成本归一化为空舰队，不再回退标准战斗机）、持久战斗绑定完整性（失能舰/部署/精确集合）、`BattleState` 一致性（死亡清 tick、失能按真实组件损毁、alpha.5 拒绝 `escaped`），并将 UI 锁定升级为真实 DOM 行为测试、集成测试直接消费模拟器权威 `getState()`；策略测试套件扩展至 57 例。
> V1.0-B.4 固化 `isStrategicShipEligible`、严格 pending deployment/binding 集合、同源组件—`combatState` 校验与 alpha.2 极低战力钳制；escaped 最终定义为结构存活但已离场。真实 DOM 测试改用 jsdom，存档版本保持 `1.0-alpha.5`，策略测试套件扩展至 59 例。
> V1.0-B.5 将“当前可参战”与“可重新选择部署”分离，统一组件失能、敌袭、维修和写回状态，并使战斗入口严格拒绝空、重复、不存在或不合资格的显式部署；真实 pending/UI 测试夹具可保存，策略测试套件扩展至 64 例。
> V1.0-C.1 首个切片将 V0.8 同源指挥官档案加入战略状态、UI 与跨星域继承，Sector Expedition Code 升级为 `1.0-alpha.6`，并显式迁移 alpha.5。现任指挥官可用性与 `pendingSuccession` 必须双向一致；继任期间保存、编码、战略判定、reducer 与 UI 共用行动锁。策略测试套件扩展至 66 例。
> V1.0-C.2 完成可玩指挥官闭环：每星域确定性招募、真实战斗伤病与经验、基地治疗、候补任命和无继任者崩溃结局；Sector Expedition Code 升级为 `1.0-alpha.7`，策略测试套件扩展至 69 例。
> V1.0-C.3 完成多据点与抽象运输网络：唯一主基地、次级补给前哨、独立建造、已知航路运输阻断，以及防御网和舰队驻防共同影响的敌袭；Sector Expedition Code 升级为 `1.0-alpha.8`，策略测试套件扩展至 73 例。
> V1.0-C.4 完成持久移动敌军、据点围攻与真实星门防御战：特遣舰队按回合确定性移动，围攻与据点失守保持网络不变量，驻军/特遣舰队/星门拦截统一复用 core-v4 与 Three.js 战斗闭环；Sector Expedition Code 升级为 `1.0-alpha.9`，策略测试套件扩展至 78 例。
> V1.0-C.5 完成三星域发布闭环与压力校准：星门只保留校准触发的唯一强制防御战，移动敌军随星域增长且受继承舰队战力上限约束，普通扩张不再隔空伤害据点；三个星域共享 17 回合行动预算。81 项策略用例、65-seed 正式矩阵、额外 1000-seed 探针与真实 Chromium 三星域流程均通过。
> V1.0-D.1 完成唯一主基地轻型船坞与确定性舰船生产：生产仅使用既有 core-v4 舰体/改型和价值，排产分配稳定舰船 ID，交付舰以完整合法组件加入唯一战略舰队；Sector Expedition Code 升级为 `1.0-alpha.10`，策略测试套件扩展至 85 例。
> V1.0-D.2 完成逐舰撤离清单：稳定/紧急撤离以 `campaignShipId` 精确覆盖舰队，拖曳、断后、放弃、携带资源和风险由同一纯计划预览并结算；Sector Expedition Code 升级为 `1.0-alpha.11`，策略测试套件扩展至 88 例。
> V1.0-D.3 统一三个永久蓝图的战略效果和跨域激活边界，并以 `maxFuel` 派生不变量、正式 reducer 扣费及真实 Chromium 取得/激活流程闭合；Sector Expedition Code 升级为 `1.0-alpha.12`，策略测试套件扩展至 91 例。
> V1.0-D.4 在冻结 core-v4 的边界内完成以 `campaignShipId` 绑定的逐舰战略模块槽、正式资源扣费、跨域继承和损失清理；Sector Expedition Code 升级为 `1.0-alpha.13`，策略测试套件扩展至 95 例。
> V1.0-E.1 在不升级存档结构的前提下完成无副作用迁移探测、上一合法状态备份、损坏主槽恢复，以及招募/真实战斗刷新恢复闭环；策略测试套件扩展至 97 例。
> V1.0-E.2 在不升级存档结构的前提下补齐锁定原因、危险操作确认、重渲染焦点恢复、可访问语义与战略日志导出；jsdom 和真实 Chromium 均验证取消/确认不会错派 action，策略测试套件扩展至 100 例。
> 当前实现与进度请以 `progress.md` 的 V1.0-E.2 小节为准。

## Purpose

This milestone begins the transition from an FTL-style route campaign to a persistent strategic universe without deleting the existing campaign. The two modes remain separate while the strategic data model stabilizes.

## Implemented loop

1. Generate a deterministic connected sector of nine star systems.
2. Discover systems through strategic fleet travel.
3. Reveal persistent planets, moons, stations, asteroid fields, and jump infrastructure.
4. Survey entities for information and science.
5. Extract finite asteroid resources that remain depleted in the save.
6. Produce minerals, energy, and science from an owned orbital base.
7. Queue facilities with material costs and construction time.
8. Queue research with science costs and research time.
9. Recruit, treat and replace a persistent commander.
10. Defend a main base and secondary outposts against persistent moving task forces and sieges.
11. Trigger the single mandatory gate-defense battle through the existing core-v4 / Three.js flow.
12. Build a light shipyard at the main base and produce existing legal core-v4 hull/variant combinations.
13. Assign every persistent ship an explicit extraction role and preview exact costs, survivors and losses.
14. Export, import, save, resume and complete three consecutive sectors with persistent ship identity and component damage.

## Persistent entities

The strategic map stores entities independently from UI nodes. Each entity has a stable id, system membership, orbit, discovery and survey state, optional ownership, habitability, deposits, facilities, and construction state.

The first vertical slice includes:

- planets
- moons
- orbital stations
- asteroid fields
- jump gates

## Base construction

The player begins beside a surveyed but unowned orbital station. Establishing it as the main forward base costs resources and one strategic turn. Additional surveyed stations can become secondary outposts linked to the main base through discovered routes.

Available facilities:

- orbital solar array
- automated mining array
- orbital research laboratory
- supply works
- field repair dock
- local defense grid
- light orbital shipyard (main base only)

The light shipyard supports a two-order deterministic queue. Resources are paid when an order is queued; production pauses while the sole fleet is away from the main base or the base is under siege. Delivery creates a full-component persistent ship with an ID allocated at queue time. No multiple-fleet assignment or fitting system is implied.

## Research

Research is time-based rather than an instant module unlock.

Current local projects:

- Stellar Cartography: reduces strategic travel fuel.
- Rapid Fabrication: reduces construction time.
- Crisis Forecasting: reduces pressure growth.
- Gate Theory: increases calibration progress.

## Relationship with the existing campaign

The existing V0.6–V0.9 campaign remains available as an FTL-style expedition mode. It is not yet embedded inside the strategic universe.

The current relationship is:

- strategic universe: systems, ownership, bases, economy, construction, fleet locations
- strategic universe: systems, ownership, bases, economy, construction, fleet location, moving enemies and extraction
- core-v4 battle: the shared real-time encounter used by garrisons, task forces and gate defense
- battle results: deterministic bindings write persistent ship identity, component damage, destruction and commander consequences back into the strategic save

## Explicit limitations after V1.0-D.4

The release-candidate slice does not include:

- multiple player fleets
- permanent colonies or a long-lived empire map
- combat-affecting equipment or a module technology tree (D.4 fittings are strategic-only)
- diplomacy and markets
- population and workforce
- real-time strategic movement

These are follow-up slices, not hidden features of the current implementation.
