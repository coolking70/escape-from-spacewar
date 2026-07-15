# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 through V0.9 are retained on `main` as the compatible seven-layer route campaign.
- Campaign Code remains `0.3`; Campaign Log remains `1.1`.
- V1.0 development is isolated in PR #9 and remains Draft.
- GitHub Actions uses Node.js 24.

## Frozen compatible campaign

### V0.7 and V0.7.1

- Weighted cargo, salvage, field repair, towing, dismantling, abandonment, deployment, extraction and sector summaries.
- Persistent ship identity and component damage across battles and sectors.
- Hull-aware encounter scaling, visible risk, deterministic evasion, manual and automatic retreat.
- Fleet recovery through rescued and disabled hulls.
- Seven-layer structured sector map and battle/map readability improvements.

### V0.8 and V0.8.1

- Commander creation, attributes, deterministic traits and four career domains.
- Health conditions, injuries, treatment and campaign-level effects.
- Deterministic recruitment, three-person reserve roster and succession.
- Recruitment cadence, treatment cost, trauma thresholds and narrow-screen UI playtest closeout.

### V0.9

- Organization archetypes, governments, values, stability and reputation.
- Research resources and six modular campaign technologies.
- Deterministic organization events and Campaign Code `0.3` migration.
- Current-format validation and imported-text rendering hardening.

This route campaign remains available as a compatibility mode. V1.0 does not continue expanding its abstract event-node map.

## V1.0-A unified strategic-sector refactor

### Direction correction

The discarded direction was:

```text
persistent galaxy map → select a system → launch a separate FTL-style local expedition
```

The implemented direction is:

```text
one sector is one complete fast SLG run
→ explore, gather, fight, occupy, build and research on the same map
→ find and calibrate the gate under an escalating crisis
→ extract assets into the next complete strategic sector
```

### Complete sector map

- Each sector deterministically generates nine connected star systems.
- Planets, moons, stations, asteroid fields, relic sites and one gate are persistent entities for the current run.
- The gate is placed in a graph-distant hostile system rather than a final route layer.
- At least two systems begin under enemy control with explicit local combat power.
- The player begins with a fleet and limited resources, but no free owned base.

### Temporary foothold and production

- A surveyed safe station can be occupied as the sector's forward base.
- Occupation costs minerals, energy and supplies and consumes strategic time.
- Stations have limited facility slots and a two-item construction queue.
- Temporary facilities provide energy, minerals, science, supplies, repair or defense.
- Facilities, construction queues and local stockpiles are abandoned when the fleet crosses the gate.
- Remaining mobile without a base is valid, but prevents sustained production, research and repair.

### Local research and permanent blueprints

Local research:

- route analysis
- rapid fabrication
- crisis forecasting
- gate theory

Local projects give fast sector-specific benefits and reset after extraction.

Relic sites can provide permanent blueprints:

- field logistics core
- hardened bulkheads
- compact foundry core

Recovered blueprints enter long-term inheritance only after a successful extraction.

### Crisis and enemy pressure

- Crisis phases are foothold, contest, collapse and evacuation.
- Pressure increases every strategic turn.
- The final extraction window is shorter in later sectors.
- Enemy control expands along actual routes at phase-dependent intervals.
- Enemy systems have persistent local power that must be reduced through strategic combat.
- Enemy expansion can raid the player's forward base; defense grids reduce losses.
- Missing the final window collapses the sector and ends the run.

### Fleet operations

V1.0-B replaces the abstract placeholder with a real per-ship persistent fleet (`PersistentShip[]`):

- each ship carries a stable `campaignShipId`, ship class, variant, `disabled` / `escaped` / `towed` flags and optional per-component `componentHp`;
- strategic fleet tallies (`strategicFleetCounts`) derive operational / disabled / escaped / total from the real ships;
- strategic combat power derives from the real fleet via `campaignFleetPower`;
- strategic fuel and cumulative cross-sector ship losses are retained.

Strategic combat is now a real `core-v4` battle: `engageEnemy` only locks a `PendingStrategicBattle` (enemy fleet generated from `StarSystem.enemyPower`, never compressed); the actual fight runs on the shared simulator / renderer / HUD; the finished `BattleState` is written back (`applyStrategicBattleResult`) so destroyed ships are deleted, disabled / escaped / operational ships keep their component HP, and enemy remaining power is recomputed solely from real Team B. A repair dock restores one specific disabled ship (`repairShip`) at a material and supply cost.

### Gate and extraction

- The gate must be located, surveyed and cleared of defenders.
- Calibration consumes energy, science, supplies and strategic turns.
- Stable extraction requires full calibration and carries more resources and disabled ships.
- Emergency extraction requires partial calibration but discards most resources and loses disabled ships.
- High-pressure emergency extraction can cause additional ship loss.
- The player can deliberately leave a ship as rearguard during emergency extraction.
- Extracted ships, permanent blueprints and limited compressed materials/supplies generate the next complete sector.
- The current vertical slice ends after extracting from the third sector.

### Persistence

- New code type: `spacewar-sector-expedition`.
- Current version: `1.0-alpha.5` (real per-ship fleet; enemy power uses the core-v4 ship-cost dimension). `1.0-alpha.2` (abstract fleet), `1.0-alpha.3` (old-dimension enemy power) and `1.0-alpha.4` (per-ship, old escaped semantics) are migrated deterministically in place.
- Deep validation covers graph references, enemy control, facilities, queues, crisis, gate state, fleet state (per-ship) and inherited assets.
- `1.0-alpha.2` abstract fleets migrate deterministically into real starter ships (abstract combat power converted to the core-v4 value, disabled flags preserved); `1.0-alpha.3` enemy power is rebuilt from the deterministic enemy fleet cost; `1.0-alpha.4` escaped semantics and missing `deployed` / `towed` fields are normalized (`escaped` → `false`, `deployed` → `true`, `towed` → `false`, `strategicFleetCounts.operational` asserted to equal `activeShips(...).length`); `1.0-alpha.1` resets into a fresh first strategic sector.
- The old Campaign Code and the new Sector Expedition Code remain separate.

## V1.0-B real persistent fleet and core-v4 strategic battle

V1.0-B removes the last abstract fields from the strategic layer and wires it to the frozen `core-v4` battle engine:

- `StrategicFleet` now holds `ships: PersistentShip[]` plus `formation` / `doctrine`; `shipCount` / `disabledShips` / `combatPower` are gone.
- `UniverseState` gains a serializable `PendingStrategicBattle` so an in-progress strategic fight survives reloads.
- Strategic enemy fleets are generated deterministically from `StarSystem.enemyPower` via `strategicEnemyFleetFor` — no campaign-style compression of strong enemies.
- `App` routes `BattleOrigin = 'strategy'` through the same `prepareStrategicBattle` / simulator / `ThreeScene` / HUD / binding path as the campaign, with HUD returning to the strategic map.
- Battle results write back idempotently: destroyed deleted, disabled / escaped kept with component HP, enemy power recomputed from real Team B, system cleared to `neutral` on zero, single-turn advance.
- Cross-sector extraction carries the real ships (disabled dropped on emergency), and `repairFleet` is replaced by per-ship `repairShip`.
- `StrategicUniversePanel` renders a per-ship roster with status, component integrity, key-component destruction warnings and per-ship repair buttons.

## V1.0-B.1 boundary fixes, power-unit unification and save upgrade

V1.0-B.1 closes the gaps left after the real-fleet wiring:

- **Power-unit unification (same core-v4 dimension):** `systemEnemyBudget(sectorIndex, gateGuard)` replaces the old `20 ~ 70` abstract numbers. Outpost factors `[0.55, 0.78, 0.85]` and gate-guard factors `[0.95, 1.2, 1.5]` scale the `strategicBaselineFleetPower()` baseline; the floor is `max(50, …)` so every enemy budget is at least one legal ship. Enemy generation, post-battle remaining power, migration and expansion all reuse the same `campaignFleetEntryCost` / `battleTeamRemainingPower` unit, so a generated enemy fleet's cost equals its budget (within one cheapest-ship tolerance).
- **Writeback bug fixed:** `applyStrategicBattleResult` previously mutated `system` resolved on the *original* `state`, while the returned value is a deep clone (`cloneState`). The post-battle `enemyPower` and `control` therefore never reached the serialized state — the enemy system kept its pre-battle power and the clear-to-neutral path was dead. It now writes to `target` resolved on the cloned `next`.
- **Strict writeback validation (no silent writes):** seed/ruleset mismatch, `systemId` ≠ fleet location, `control`/`enemyPower` inconsistency, `Team B` ≠ `pending.enemyFleet`, and `validatePersistentBattleBindings` (unique campaign/battle ids, no undeployed ship in combat, hull·variant match, one binding per participating ship) all throw. Post-battle power above pre-battle throws.
- **`escaped` normalization:** ships that left the battlefield are standardized to `escaped=false / deployed=true` (left the fight, not the fleet); undeployed ships are untouched.
- **Pending-battle UI + logic lock:** `StrategicUniversePanel` disables every action (travel, survey, extract, base, build, research, calibrate, next-turn) and shows a banner while a `pendingBattle` exists; the `can*` predicates gain the same `state.pendingBattle` guard as defense-in-depth. Loss preview now lists concrete ship IDs.
- **Save upgrade to `1.0-alpha.4`:** `decodeUniverse` / `loadUniverse` branch on `1.0-alpha.2` (abstract → per-ship via `legacyAbstractPowerToCoreBudget` + `recomputeEnemyPowers`) and `1.0-alpha.3` (`recomputeEnemyPowers` rebuilds enemy power in the core-v4 dimension). `validateUniverseState` enforces `version === 1.0-alpha.4`, enemy/control consistency and `fleet.ships.length >= 1`.

## V1.0-B.2 strategic battle-result closure, legacy-save compatibility and UI-lock hardening

V1.0-B.2 makes the strategic battle result a fully self-consistent, reload-safe state machine and tightens legacy-save migration and UI locking:

- **Deep `BattleState` validation (`validateFinishedStrategicBattle` / `validateBattleShipAgainstDefinition`):** a finished core-v4 `BattleState` is now rejected unless `version === 0.5`, `ruleset === spacewar-core-v4`, `seed` finite, `teamACount` / `teamBCount` match the ships actually present (`isPresentOnBattlefield`, the same predicate the simulator uses each tick), ship ids unique, every numeric field finite, and every ship's `def.type` / component count / type / `maxHp` / `hp` range / `core` integrity matches `getShipDef`. State-machine rules are enforced: `destroyed` requires `hp<=0`, `disabled` requires a critical-system disable flag, `escaped` requires `escapedTick`, operational states require positive core hp. `Team B` must equal `pending.enemyFleet`.
- **Low-residual enemy power normalization:** `normalizeStrategicEnemyPower` floors any residual below the cheapest legal ship cost to 0 and clears the system to `neutral`. The floor is a single authority — `minimumStrategicFleetCost()` (= lowest `VARIANTS` cost = 45, scout Fighter) — used by `systemEnemyBudget` and `strategicEnemyFleetFor` so no enemy fleet is ever below one legal ship. This fixes "heavily damaged but alive" enemy ships producing a sub-minimum residual that could not be saved, and prevents a low residual from inflating into a full ship next fight.
- **Legacy-save migration hardening:**
  - `1.0-alpha.4` → `1.0-alpha.5`: `escaped` normalized to `false`, missing `deployed` completed to `true`, missing `towed` completed to `false`, and `strategicFleetCounts.operational` is asserted to equal `activeShips(...).length` (escaped semantics unified); disabled ships are preserved.
  - `1.0-alpha.2` abstract power migrates monotonically: higher `combatPower` never yields lower migrated fleet power, and disabled key components are zeroed.
- **UI lock hardening:** `StrategicUniversePanel` emits a single `disabled` attribute with no duplicate `disableddisabled` token; the `can*` predicates and action handlers share the `state.pendingBattle` guard so a pending battle locks travel / survey / extract / base / build / research / calibrate / next-turn at both UI and logic layers.
- **Real-integration coverage:** the strategy suite now runs a full `prepareStrategicBattle` → `createSimulator` (run-to-finish) → `applyStrategicBattleResult` writeback and asserts the result is self-consistent and save-round-trippable, exercising the genuine closure end-to-end with no `as unknown as BattleState` fabrication.

The strategy suite grows from 35 to **55** cases covering low-residual writeback, escaped / migration, `BattleState` validation, UI lock, save round-trip, alpha.2 power monotonicity and real integration.

## V1.0-B.3 low-budget enemy generation closure, persistent battle-binding integrity and test authenticity

V1.0-B.3 closes the last correctness gaps in enemy-budget generation, persistent-battle binding and test honesty:

- **Enemy-budget generation closure:** `strategicEnemyFleetFor(0)` and any sub-`minimumStrategicFleetCost()` budget (45, scout Fighter) no longer fall back to a standard fighter; a sub-minimum budget normalizes to an **empty** enemy fleet (cost 0), while a budget exactly at the minimum yields a non-empty legal fleet. "Low budget inflated into a legal ship" is redefined as a defect and is rejected by tests.
- **alpha.4 sub-min-cost positive `enemyPower` migration fix:** a positive `enemyPower` that maps below one legal ship under alpha.4 is no longer revived into full ships on migration — it normalizes to `0` / `neutral`.
- **Binding validation integrity:** `validatePersistentBattleBindings` now also rejects **disabled** persistent ships in a binding, and guarantees the binding set equals the actual participating ship set (every present ship has exactly one binding, no orphan bindings).
- **Pending deployment participation:** Team A set validation now includes `pendingBattle.deployment` (selected ship ids), so a deployment-limited battle cannot bind ships that were not deployed.
- **`BattleState` consistency hardening:** `destroyed` is now inconsistent with any `escapedTick` / `retreatStartedTick` (the simulator clears them on death); `disabled` is validated against **real component damage** (`expectedDisableFlags`) rather than trusted boolean flags alone; alpha.5 validation rejects `escaped=true` persistent ships to keep fleet counts consistent.
- **alpha.2 power migration real calibration:** `migrateAlpha2Fleet` now compares against the real `campaignFleetPower` (binary-search calibration) instead of only monotonicity, so migrated power matches the core-v4 value within tolerance.
- **Real-DOM UI lock test:** the strategy suite uses jsdom `HTMLElement` / `HTMLButtonElement` instances to verify `button.disabled===true`, that clicking a disabled button does not fire its callback, and that "继续战斗" / 导出 / 返回 stay enabled.
- **Real-simulator integration test:** the integration case no longer hand-calls `syncBattleCounts` before writeback or fabricates a `BattleState` via `as unknown as`; it consumes the simulator's authoritative `getState()` output directly.

The strategy suite grows further to **57** cases covering low-budget enemy generation closure, alpha.4 sub-min migration, binding integrity (disabled + deployment + exact set), `BattleState` consistency (death / disable / escape), alpha.5 `escaped` rejection, alpha.2 real-power calibration and real-DOM UI-lock behavior.

## Verification matrix

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:strategy
npm run test:stress
npm run build:static
```

The V1.0-B.3 strategic suite (`runStrategicTests`, 57 cases, no `as unknown as` fabricated `BattleState`) covers:

- deterministic nine-system generation and connectivity
- gate, relic and hostile-system generation
- no-base opening and station occupation
- temporary construction and turn income
- local research and cross-sector reset
- crisis phase progression and timeout defeat
- **strategic enemy power shares the core-v4 ship-cost dimension** (budget ≥ cheapest legal ship; generated fleet cost == budget within tolerance)
- outpost / gate-guard budget factors across sectors (≈ 45–150% baseline)
- `validateUniverseState` rejects enemy-power / control mismatches
- `engageEnemy` only locks a `PendingStrategicBattle` and does not immediately reduce enemy power
- pending battle locks travel / advance-turn while allowing system selection
- **`can*` logic lock** (queue facility / research / engage / calibrate / extract all false under pending)
- single-ship high-pressure extraction loses at most `max(0, total-1)` (no empty fleet)
- `previewExtractLosses` returns concrete ship IDs and matches the actual extraction
- real `core-v4` writeback: destroyed deletion, enemy power recomputed from real Team B, escaped normalization, undeployed preserved
- `validatePersistentBattleBindings`: positive + duplicate-id / undeployed / hull-mismatch / non-1-binding negatives
- idempotent writeback, player-wipe → collapsed
- writeback rejection: seed/ruleset mismatch, Team B ≠ pending, post-battle power above pre-battle
- cross-sector real-fleet inheritance (ship IDs preserved)
- `1.0-alpha.2` → `1.0-alpha.4` migration (abstract power converted, disabled preserved)
- `1.0-alpha.3` → `1.0-alpha.4` migration (deterministic enemy-power rebuild)
- `1.0-alpha.4` code round-trip and corrupted-state rejection
- **V1.0-B.2 `BattleState` deep validation** (version / ruleset / seed / `teamACount`·`teamBCount` present-count match / unique ids / finite fields / per-ship def·component·state-machine consistency / `Team B` === pending)
- **low-residual enemy power normalization** (sub-minimum residual → 0 + `neutral`; `minimumStrategicFleetCost()` authority)
- **`1.0-alpha.4` → `1.0-alpha.5` migration** (escaped → `false`, missing `deployed`/`towed` completion, operational-count conservation, disabled preserved)
- **alpha.2 abstract power monotonic migration** (higher `combatPower` → no lower migrated power, disabled key components zeroed)
- **UI lock** (single `disabled` attribute, no `disableddisabled`; `can*` logic + UI lock under pending battle)
- **real-integration writeback** (full `prepareStrategicBattle` → `createSimulator` run-to-finish → `applyStrategicBattleResult`, self-consistent and save-round-trippable)
- **V1.0-B.3 low-budget enemy generation closure** (`strategicEnemyFleetFor(0)` / sub-min budgets → empty fleet, not a standard-fighter fallback; minimum budget → non-empty legal fleet; the "low budget inflated to a legal ship" case is rejected)
- **V1.0-B.3 alpha.4 sub-min `enemyPower` migration** (positive power below one legal ship normalizes to `0` / `neutral`, never revived into full ships)
- **V1.0-B.3 binding integrity** (disabled persistent ships rejected; binding set equals the exact participating ship set; pending `deployment` selection included in Team A validation)
- **V1.0-B.3 `BattleState` consistency** (`destroyed` clears `escapedTick` / `retreatStartedTick`; `disabled` validated against real component damage via `expectedDisableFlags`; alpha.5 rejects `escaped=true` persistent ships)
- **V1.0-B.3 alpha.2 real-power calibration** (binary-search against real `campaignFleetPower`, within `max(8, 5%)` tolerance)
- **V1.0-B.3 real-DOM UI lock** (superseded in B.4 by jsdom: `button.disabled===true`, clicking a disabled button does not fire its callback, "继续战斗" / 导出 / 返回 stay enabled, no `disableddisabled`)

## V1.0-B.4 state invariants and test authenticity

- Added the single strategic eligibility rule: `!ship.disabled && ship.deployed !== false`. It is shared by active ships, default deployment, deployment normalization, deployment fleets, pending-save validation and battle bindings.
- Pending deployments now reject empty, duplicate, missing, disabled and undeployed IDs; bindings must match the deployment / Team A set exactly.
- Deep battle validation checks component-derived combat states, and strategic persistent ships reject a destroyed core or mismatched `disabled` / critical-component damage.
- `escaped` now means structurally alive (`alive=true`) but absent from the battlefield. Only `destroyed` is structurally dead.
- alpha.2 migration preserves the frozen power formula, clamps impossible low targets to the nearest legal component state (each operational component at least 1 HP), and records the clamp. alpha.3/alpha.4 pending migration restores nonempty fleets to enemy control, or clears empty pending battles to neutral.
- Added jsdom (`HTMLElement` / native disabled click behavior) and removed FakeRoot/FakeNode UI testing. The strategic suite now has **59 cases**.

## Next milestone: V1.0-C

The next development slice should replace strategic placeholders with existing mature systems:

1. use the V0.7 persistent fleet and component HP model instead of abstract ship count/power;
2. launch core-v4 battles for strategic interceptions and hostile-system assaults;
3. connect V0.8 commanders, injuries, reserves and succession;
4. support multiple temporary outposts and abstract transport links;
5. simulate moving enemy fleets, sieges and a real gate-defense battle;
6. assign individual ships to cargo escort, early extraction and rearguard roles.

## Still out of scope for V1.0-A

- Multiple independently controlled player fleets.
- Population and worker micromanagement.
- Permanent colonies or a long-lived empire map.
- Full diplomacy, markets or trade simulation.
- Detailed ship production and equipment fitting.
- Real-time strategic movement.
