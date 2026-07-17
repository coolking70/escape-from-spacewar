Original prompt: Continue V1.0-C in the current repository, beginning with strategic-screen browser regression coverage and then commander integration.

# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 through V0.9 are retained on `main` as the compatible seven-layer route campaign.
- Campaign Code remains `0.3`; Campaign Log remains `1.1`.
- V1.0 development is isolated in PR #9 and remains Draft.
- GitHub Actions uses Node.js 24.
- The strategic-sector screen owns a viewport-bounded vertical scroll area, so map, management, fleet and log sections remain reachable without enabling global page scrolling.

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
- Current version: `1.0-alpha.10` (C.5 three-sector release loop plus main-base light shipyard and deterministic ship production). `1.0-alpha.2` through `1.0-alpha.9` are migrated deterministically in place.
- Deep validation covers graph references, enemy control, mobile fleets, sieges, facilities, queues, crisis, gate-defense state, fleet state (per-ship) and inherited assets.
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

- Added the strategic current-participation rule `!ship.disabled && !ship.escaped && ship.deployed !== false` for active ships, default deployment, battle fleets, pending-save validation and battle bindings. B.5 subsequently separated UI re-selection eligibility (`!disabled && !escaped`) so an undeployed ship can be selected again without weakening battle-entry validation.
- Pending deployments now reject empty, duplicate, missing, disabled and undeployed IDs; bindings must match the deployment / Team A set exactly.
- Deep battle validation checks component-derived combat states, and strategic persistent ships reject a destroyed core or mismatched `disabled` / critical-component damage.
- `escaped` now means structurally alive (`alive=true`) but absent from the battlefield. Only `destroyed` is structurally dead.
- alpha.2 migration preserves the frozen power formula, clamps impossible low targets to the nearest legal component state (each operational component at least 1 HP), and records the clamp. alpha.3/alpha.4 pending migration restores nonempty fleets to enemy control, or clears empty pending battles to neutral.
- Added jsdom (`HTMLElement` / native disabled click behavior) and removed FakeRoot/FakeNode UI testing. The strategic suite now has **59 cases**.

## V1.0-B.5 strategic fleet state and persistence closure

- Persistent ship state is now derived through one shared component rule: a ship is operational only when it is not disabled, not escaped and not explicitly undeployed; a ship remains eligible for re-selection when it is merely undeployed.
- Component disable flags reuse core-v4’s all-components-per-system rule. Enemy raids now destroy a complete real critical system; repair and battle writeback recompute `disabled` from component HP before a state can be saved.
- Alpha.2 accepts zero combat power, remains deterministic at extreme values, and normalizes legacy disabled ships by destroying an entire critical system rather than one arbitrary component.
- Pending UI tests originate from real `engageEnemy` states and the fixture itself passes `validateUniverseState`. jsdom verifies every strategic action button is enabled and dispatches the correct action in its own legal context; under pending it verifies native disabled-click behavior for the buttons that can actually render, while the reducer rejects the complete action set and continue battle, system selection, export and exit stay enabled.
- Battle-state mismatch coverage now constructs a genuinely weapon-disabled ship (all weapon components at 0 while engines remain intact), instead of relying on the engine-first generic disabled helper. The helper itself now destroys a complete component system, matching core-v4 for multi-component hulls.
- Repair intentionally follows the frozen core-v4 rule: mobility is disabled only while **all** engine components are destroyed, so repairing either one of two engines immediately restores mobility; the second repair improves integrity but is not required to clear `disabled`.
- `deploymentFleet` / `prepareStrategicBattle` now strictly reject an explicit empty deployment, duplicate or missing IDs, and disabled, escaped or undeployed ships. Tolerant normalization remains confined to UI editing and can no longer silently turn malformed battle input into the default fleet.
- `npm run test:strategy` passes with 64 strategic cases after these invariant and test-authenticity corrections.
- Full local verification passed: `npm run build`, `npm test`, `npm run test:det`, `npm run test:campaign`, `npm run test:strategy`, `npm run test:stress`, `npm run build:static` and `git diff --check`. The develop-web-game Playwright client also entered a fresh strategic expedition, produced a correct strategic-map screenshot/state (`turn=0`, matching selected/fleet system), and reported no console-error artifact.

## Next milestone: V1.0-C

The next development slice should extend the now-real persistent fleet and core-v4 strategic battle foundation:

1. connect V0.8 commanders, injuries, reserves and succession;
2. support multiple temporary outposts and abstract transport links;
3. simulate moving enemy fleets, sieges and a real gate-defense battle;
4. assign individual ships to cargo escort, early extraction and rearguard roles.

### V1.0-C.0 browser regression baseline

- Added a real Chromium regression that starts the Vite application, enters a fresh strategic expedition, scrolls the viewport-bounded strategic container with a mouse wheel and verifies that the lower management area becomes visible without console errors.
- CI installs Playwright Chromium and runs `npm run test:browser`; jsdom remains responsible for reducer/button behavior while Chromium owns layout and scrolling assertions.
- Local Chromium verification passed at a 1280×720 viewport (`clientHeight=720`, `scrollHeight=1583`, final `scrollTop=863`). The standard develop-web-game client also entered a fresh expedition, produced matching strategic text state and a clean strategic-map screenshot.

### V1.0-C.1 commander integration — first slice

- Sector Expedition Code advances to `1.0-alpha.6`. New strategic expeditions deterministically create the existing V0.8 `CampaignCommander`; alpha.5 saves receive the same profile through an explicit migration.
- Commander, reserve roster and succession flag are part of `UniverseState`, deep validation reuses the campaign commander validator, and the complete profile survives code round trips and sector extraction.
- The strategic management area displays the commander level, attributes, traits, duty state and reserve count. Recruitment, battle consequences, treatment and succession actions remain the next sub-slice.
- Browser inspection confirmed the commander card is readable beside the base card, lower management content remains reachable, and `render_game_to_text` now exposes commander identity, level, life state, reserve count and succession status.
- Commander availability and succession now form a strict active-state invariant: an available incumbent cannot leave `pendingSuccession` set, while an unavailable incumbent requires both `pendingSuccession` and an available reserve. Ended expeditions cannot retain a succession prompt.
- `validateUniverseState`, Sector Expedition Code, strategic `can*` predicates, the reducer and the real DOM share the same command lock. During succession only system selection, export and exit remain available; turn advancement and every state-changing strategic action are blocked.
- The strategy suite now has **66 cases**, including invalid commander/succession combinations, legal succession save/code round trips, reducer lock coverage and jsdom native disabled-click behavior.
- Full closure verification passed: `npm ci`, build, core tests, deterministic tests, campaign tests, 66-case strategy tests, stress, static build, `git diff --check` and real Chromium browser regression. The standard web-game client entered a fresh strategic expedition with matching commander text state, a clean screenshot and no console-error artifact.
- Commander UI duty text now reuses the authoritative availability rule and renders localized conditions/injuries, so a severity-3 injury cannot be shown as “available” while strategic actions are locked. Alpha.3/alpha.4 migration logs report the actual current target version instead of stale alpha.5 text; both paths have regression assertions.

### V1.0-C.2 playable commander loop

- Sector Expedition Code advances to `1.0-alpha.7`; alpha.6 saves migrate deterministically with no pending offer and a fresh per-sector recruitment opportunity.
- A forward base offers one deterministic recruitment decision per sector: exactly two candidates, an authoritative supply cost and a shared three-person reserve cap. Accept and decline both consume the opportunity; crossing the gate resets it.
- Real strategic battle results now award commander experience and apply the existing V0.8 battle injury rules from actual fleet losses. A severe injury or death enters succession when an available reserve exists; otherwise the expedition ends as a valid `collapsed` state instead of becoming unsaveable.
- Treatment is available only at the forward base, costs two supplies and one strategic turn. Appointment swaps an available reserve into command while preserving an incapacitated living incumbent in the reserve roster.
- Pending recruitment and succession use explicit reducer/UI action locks. Deep persistence validation rejects malformed offers, duplicate identities, invalid costs, conflicting pending states and reserve overflow.
- The strategy suite now has **69 cases**. Real Chromium additionally performs the playable `establish base → open recruitment → choose candidate → reserve roster` flow and checks candidate count, action locking, resources, debug state, UI text and console errors.
- Full closure verification passed after a clean install: production build, acceptance, deterministic, campaign, 69-case strategy, stress, standard Chromium, production-chunk Chromium, single-file static Chromium, static build, npm audit and `git diff --check`.

### V1.0-C.3 multiple outposts and transport network

- Sector Expedition Code advances to `1.0-alpha.8`; alpha.7 saves preserve their original forward base as the unique main base and receive an empty transport-link collection.
- Player-owned station entities are the authoritative outpost set. `baseEntityId` identifies exactly one main base; every secondary outpost must have exactly one validated link to it.
- Transport paths are deterministic shortest paths over already discovered systems only. Their status is derived from current control rather than saved: enemy power on any path system blocks secondary production delivery, and clearing the route restores it without rewriting the link.
- Every outpost retains its own facility slots and two-item construction queue. All queues advance independently; main-base output enters storage locally while only active links deliver secondary output.
- Enemy expansion can raid any adjacent owned outpost. The shared deterministic resolver accounts for local defense grids and whether the fleet is physically present, applies real supply loss and component-backed fleet disablement, and produces a save-valid result.
- The strategic map renders active transport paths as green dashed lines and blocked paths as red dashed lines without exposing hidden systems. The management UI lists the main base, every secondary outpost, route, blocker, local/delivered output, facilities and queues.
- Strategy coverage is now **73 cases**, including deterministic establishment, parallel construction, route blocking, deep malformed-link rejection, real DOM target-specific construction and raid resolution. Chromium performs `main base → recruit → travel two hops → survey station → establish outpost → queue local construction` through visible controls and checks debug state and console errors.

### V1.0-C.4 moving enemy fleets, sieges and gate defense

- Sector Expedition Code advances to `1.0-alpha.9`; alpha.8 saves preserve their complete outpost network, receive no surprise mobile enemies and map old extraction progress to a consistent gate-defense state.
- Every new sector starts with one persistent raider task force. Raiders move at most one graph edge per strategic turn along a stable shortest path to the nearest player station; only discovered positions render, so hidden fleets do not leak through the map DOM.
- Mobile fleets share the existing core-v4 cost scale and the same pending battle / deployment / Three.js / binding / writeback path as fixed garrisons. `PendingStrategicBattle.source` and `taskForceId` make the writeback target explicit.
- Raiders on transport paths block secondary delivery. Reaching a station starts a persistent two-turn siege; each local defense grid extends the response window by one turn up to four. A returning player fleet pauses the countdown and exposes the real battle action.
- A lost secondary outpost removes its facilities, queue and exact transport link. Losing the unique main base ends the expedition as a valid, exportable `collapsed` state.
- Crossing the emergency calibration threshold automatically creates a mandatory gate-defense task force and launches the existing battle screen through normal App flow. A player victory means the interceptor was destroyed, disabled or forced away and unlocks extraction.
- Deep validation rejects duplicate/missing task forces, malformed siege references, bad locations/power, contradictory gate-defense state and pending source mismatches. Strategy coverage is now **78 cases**.
- Chromium now performs `main base → recruit → travel → survey → establish outpost → local construction → enemy siege → return to base → existing Three.js defense battle`; screenshots and debug text agree and the console remains clean.
- Full closure verification passed after a clean install: production build, 19-suite acceptance, deterministic/golden replay, campaign, 78-case strategy, development Chromium, production-chunk Chromium, single-file static Chromium, 50v50 stress, static build, npm audit and `git diff --check`.

### V1.0-C.5 three-sector release closeout

- The pre-fix executable baseline completed **0/20** sampled three-sector runs: a fixed 95%-baseline gate garrison plus a second interceptor duplicated the mandatory encounter; abstract territorial expansion could remotely drain a station in addition to mobile sieges; inherited fleets then faced fixed higher-sector mobile budgets they could not recover from.
- Gate systems now begin neutral and are excluded from ordinary expansion. Calibration creates the one authoritative mandatory `gateDefense` battle; ordinary territorial expansion cannot bypass persistent task forces to directly damage an owned station.
- Raider and gate-defense targets rise by sector (`100/110/120` and `115/125/140`) while being capped at 55% and 65% of current operational fleet value. This is strategic encounter pacing only: core-v4 costs, ship values, AI and golden replays are unchanged.
- All sectors use a 17-turn action window. Pressure still starts and grows faster in later sectors, and Crisis Forecasting reduces the shared pure growth function.
- Added `runStrategicThreeSectorPlaythrough()`: a release verifier that uses only public strategic actions, official Sector Expedition Code round trips, `prepareStrategicBattle`, the real simulator and binding-based writeback. It establishes a base, queues route research, makes recruitment decisions, defeats each raider, travels only through revealed next hops, surveys/calibrates each gate and completes three emergency extractions.
- Strategy coverage is now **81 cases**. The committed matrix runs 65 seeds through three sectors and validates every victory code; an additional 1000-seed probe completed 1000/1000 with no failure. Canonical seed 2036 performs six real battles and produces byte-identical actions, metrics and final code on repeat.
- Chromium performs the same visible three-sector flow through real buttons, renders three raider and three gate battles in the existing Three.js UI, writes every result back, reaches the third-sector victory panel, keeps export/exit available and reports no console error. Screenshots were visually inspected; the standard develop-web-game client independently confirmed the initial strategic layout and text state.
- Defeat settlement text now uses the actual final strategic log reason instead of always claiming a missed deadline. `render_game_to_text` exposes sector/status/window/fleet/extraction fields needed to compare UI and runtime state without exposing hidden map topology.
- Independent release verification passed after a clean `npm ci`: production build, 19/19 acceptance suites, deterministic and golden replays, campaign coverage, 81-case strategy coverage, development Chromium, production-chunk Chromium, single-file static Chromium, deterministic 50v50 stress, static build, zero npm audit findings and `git diff --check`. Every browser target completed all six mandatory battles and reached the third-sector victory settlement without console errors.

V1.0-C feature scope is now closed. Next action: commit/push and PR release-candidate acceptance. Deferred unless separately approved: multiple player fleets, real-time strategic movement, ship production/fitting, diplomacy, markets and population simulation.

## Still out of scope for V1.0-C

- Multiple independently controlled player fleets.
- Population and worker micromanagement.
- Permanent colonies or a long-lived empire map.
- Full diplomacy, markets or trade simulation.
- Detailed ship production and equipment fitting.
- Real-time strategic movement.

## Build security and rendering-load closeout

- Upgraded the build toolchain from Vite 5 to Vite 7.3.6; the resolved esbuild is 0.28.1 and `npm audit --audit-level=moderate` reports zero vulnerabilities.
- Upgraded the real-DOM test environment to jsdom 29.1.1 / `@types/jsdom` 28.0.3, removing the deprecated `whatwg-encoding` transitive dependency and its clean-install warning.
- The development server now listens on `127.0.0.1` by default instead of exposing source modules to the LAN.
- Browser-only debug/test globals moved to a DEV-only dynamic module and are absent from production/static output.
- Ship preview and battle Three.js renderers now load only when opened. The standard production entry fell from about 903 kB to 354 kB; the shared renderer chunk is about 492 kB and the default 500 kB warning is clean.
- The static builder intentionally recombines dynamic modules into one file, uses an inline balance Worker and fails if CSS/JS inlining is incomplete or any literal external `assets/` reference remains.
- Chromium regression now covers strategic scrolling, eager-free setup, on-demand ship preview, on-demand battle rendering and console errors. The same regression passed against the generated single-file static site with zero external asset requests.
- Full verification passed after a clean install: build, acceptance, deterministic, campaign, 66-case strategy, Chromium browser, stress, static build, npm audit and `git diff --check`.

### V1.0-D.1 main-base ship production vertical slice

- Sector Expedition Code advances to `1.0-alpha.10`. Alpha.9 saves retain their complete C.5 state and receive an empty production queue on every station; all older supported migrations flow through the same addition.
- The unique main base can build one light orbital shipyard. It exposes all existing 3 hulls × 4 legal variants, with mineral/energy/supply costs and build time derived from unchanged core-v4 strategic ship values.
- Production pays resources at queue time, allocates the stable ID `${seed}-s${sector}-t${turn}-q${queueIndex}`, and supports at most two orders. The first order advances once per safe strategic turn; leaving the main base or entering a siege pauses it without losing progress.
- Delivery creates a persistent ship with full component HP from the authoritative ship definition, legal operational flags and the queued ID, then appends it to the sole strategic fleet. The same ship participates in the existing binding-based core-v4 battle path and keeps its ID across extraction.
- Deep persistence validation rejects malformed orders, illegal hull/variant pairs, duplicate order or campaign IDs, fleet-ID collisions, secondary-outpost production, production without exactly one built shipyard, non-station queues and over-capacity queues.
- Strategy coverage is now **85 cases**, including all 12 cost/time mappings, alpha.9 migration, deterministic queue IDs, exact deductions, pause/resume, completion, component legality, battle binding, extraction inheritance, reducer locks and jsdom production controls.
- Real Chromium completes `establish base → build shipyard → enemy interruption/real Three.js defense → queue fighter → resume and deliver` through visible controls, validates resource deductions/debug state and reports no console errors. The standard develop-web-game client independently confirmed a clean initial strategic screen and matching text state.
- D.1 intentionally does not add multiple fleets, fitting/modules, repairs beyond the existing dock, new hulls/variants, markets, diplomacy or a base-upgrade tree. Core-v4 combat rules, costs, values, AI and golden replays remain unchanged.
