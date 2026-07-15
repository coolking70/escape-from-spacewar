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
> 当前实现与进度请以 `progress.md` 的 V1.0-C.1 小节为准。

## Purpose

This milestone begins the transition from an FTL-style route campaign to a persistent strategic universe without deleting the existing campaign. The two modes remain separate while the strategic data model stabilizes.

## Implemented loop

1. Generate a deterministic connected universe of seven star systems.
2. Discover systems through strategic fleet travel.
3. Reveal persistent planets, moons, stations, asteroid fields, and jump infrastructure.
4. Survey entities for information and science.
5. Extract finite asteroid resources that remain depleted in the save.
6. Produce minerals, energy, and science from an owned orbital base.
7. Queue facilities with material costs and construction time.
8. Queue research with science costs and research time.
9. Unlock strategic effects such as lower travel fuel and shipyard construction.
10. Export, import, save, and resume the full universe state.

## Persistent entities

The strategic map stores entities independently from UI nodes. Each entity has a stable id, system membership, orbit, discovery and survey state, optional ownership, habitability, deposits, facilities, and construction state.

The first vertical slice includes:

- planets
- moons
- orbital stations
- asteroid fields
- jump gates

## Base construction

The player begins with one owned orbital station. It contains persistent facilities and a construction queue.

Available facilities:

- orbital solar array
- automated mining array
- orbital research laboratory
- light orbital shipyard

The shipyard is currently an infrastructure milestone. Ship production is deliberately deferred until the strategic fleet model supports multiple fleets and persistent ship assignments.

## Research

Research is time-based rather than an instant module unlock.

Initial projects:

- Stellar Cartography: reduces strategic travel fuel.
- Automated Industry: increases facility output.
- Orbital Engineering: unlocks the light shipyard.

## Relationship with the existing campaign

The existing V0.6–V0.9 campaign remains available as an FTL-style expedition mode. It is not yet embedded inside the strategic universe.

The intended future relationship is:

- strategic universe: systems, ownership, bases, economy, construction, fleet locations
- local expedition: hazards, battles, salvage, commander events, and deep exploration inside a selected system
- expedition results: write discoveries, damage, resources, and control changes back into the persistent universe

## Explicit limitations

This vertical slice does not yet include:

- multiple player fleets
- colony establishment
- multiple owned bases
- ship production
- AI factions or territorial simulation
- diplomacy and markets
- population and workforce
- local expedition launch from a strategic entity
- strategic combat interception

These are follow-up slices, not hidden features of the current implementation.
