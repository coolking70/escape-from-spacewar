# V1.0 Strategic Universe Vertical Slice

> ⚠️ 历史文档：本文件记录 V1.0-A 的初版设计（抽象舰队占位、`1.0-alpha.2` 存档）。
> V1.0-B 已将战略层接入真实逐舰持久舰队与 `core-v4` 实战，存档升级为 `1.0-alpha.3`，
> 抽象字段（`shipCount` / `disabledShips` / `combatPower`）已移除。
> V1.0-B.1 进一步将战略 / 战役敌军、战后剩余战力、存档迁移统一到 core-v4 舰船成本量纲，存档升级为 `1.0-alpha.4`。
> 当前实现与进度请以 `progress.md` 的「V1.0-B real persistent fleet and core-v4 strategic battle」一节为准。

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
