# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 sector Roguelike vertical slice is frozen.
- V0.7 campaign save format remains `0.2`; older `0.1` and earlier `0.2` states migrate in place.
- GitHub Actions uses Node.js 24.

## V0.7 completed scope

- Capacity-limited weighted cargo, salvage, field repair, towing, dismantling, and abandonment.
- Persistent ship identity, component HP, disabled/towing state, cargo, and history.
- Pre-battle deployment with stable `campaignShipId ↔ battleShipId` bindings.
- Extraction preparation, normal/emergency jumps, jettison, deterministic jump damage, and sector summaries.
- Terminal campaign result flow and structured campaign log export.

## V0.7.1 playability pass

### A. Difficulty and encounter survival

- Campaign power now uses hull-aware standard costs: Fighter 50, Frigate 150, Cruiser 360.
- Persistent ship power is reduced by component damage and disabled status.
- Normal encounters scale to the currently deployed operational fleet instead of a fixed sector-only budget.
- The pre-battle panel shows player power, estimated enemy power, ratio, and danger class.
- Deterministic evasion exposes both the calculated chance and stable result.
- A pending encounter can be abandoned before battle by spending fuel and returning to its origin node.
- Campaign battles expose a manual full-fleet retreat command.
- Automatic retreat policies include never, 25% losses, 50% losses, last ship, and critical flagship damage.
- Automatic retreat checks run after fixed simulation ticks rather than render frames.
- Retreat preserves component damage, grants no salvage, and leaves the encounter unresolved.
- First-sector patrol battles do not trigger in the protected early layers.

### B. Fleet recovery economy

- Disabled enemy ships can occasionally appear as a post-battle recovery choice.
- A recovered hull joins at low component integrity in disabled/towed state.
- Rescue signals provide a damaged friendly Fighter as an early recovery path.
- Sectors generated for a fleet with one or fewer operational ships guarantee a recovery opportunity.
- Field repair can reactivate disabled ships once core, engine, and weapon systems are operational.

### C. Structured sector map

- Sectors use seven left-to-right route layers rather than a numbered snake chain.
- Every sector contains multiple route forks, local cluster links, and a deterministic shortcut.
- Regions are themed as safe routes, salvage belts, military zones, nebulae, and gate approaches.
- Region themes influence node-type distribution.
- The first sector guarantees an early resource node, a rescue signal, and no battle nodes in the first two route layers.
- The UI distinguishes node types, regions, connectors, and traveled routes.

### D. Battle and map readability

- The battle canvas uses a brighter, more saturated, higher-contrast presentation preset.
- The battle container adds subtle blue/red spatial background separation.
- Sector nodes use icons, stronger borders, region colors, tooltips, and hover/current highlights.
- The map uses layered stars and colored route lines while preserving fog-of-war visibility rules.

## Save migration and validation

- Existing `0.2` saves receive inferred node `depth` and `region` metadata.
- Pending battles receive a default retreat policy when absent.
- Validation covers region/depth, rescue features, encounter origins, retreat policies, and optional recoverable hulls.
- Sector-summary cargo usage now uses weighted cargo load rather than item count.

## Verification matrix

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:stress
npm run build:static
```

`npm run test:campaign` runs the frozen V0.6 regression suite, V0.7 persistence/extraction tests, the V0.7.1 playability suite, and the V0.8 commander suite while V0.8 is under development.

## Remaining V0.7.1 review items

- Manual browser testing should confirm the CSS readability preset on both bright and dark displays.
- Encounter power is an advisory heuristic and must not be presented as a guaranteed win probability.
- Recovered and rescued hulls use intentionally simplified low-integrity rules; a full ship market remains out of scope.

## V0.8 commander career system

### V0.8-A foundation completed on development branch

- Deterministic commander profiles provide command, tactics, logistics, and resolve attributes.
- Every new commander receives two unique deterministic traits.
- Domain experience is split into combat, exploration, logistics, and survival.
- Negative conditions and injury records have stable saveable data contracts.
- Legacy V0.6/V0.7 commander records are normalized when loaded or saved without changing Campaign Code `0.2` yet.
- The campaign HUD shows commander level, attributes, and traits.
- Explicit domain-experience progression and fatal-injury helpers are covered by a dedicated V0.8 test suite.

### V0.8-B next implementation slice

- Add a commander creation screen with name and controlled starting choices.
- Wire exploration, battle, repair, retreat, and extraction events into domain experience.
- Apply injuries and negative conditions to campaign decisions rather than only storing them.
- Add deterministic recruitment and a reserve commander roster while retaining one active player fleet.
- Define active-commander replacement rules after death or incapacitation.

## Still out of scope

- Multiple player fleets and bases.
- Technology trees.
- Faction organizations, governments, diplomacy, and markets.
- Succession and legacy politics.
- Random equipment affixes or a complete equipment system.
- New core-v4 ship classes, variants, or default replay balance changes.
