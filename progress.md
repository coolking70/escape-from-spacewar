# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 sector Roguelike vertical slice is frozen.
- V0.7 campaign save format remains `0.2`; older `0.1` and earlier `0.2` states migrate in place.
- V0.7.1 playability and readability fixes are merged into `main`.
- GitHub Actions uses Node.js 24.

## V0.7 completed scope

- Capacity-limited weighted cargo, salvage, field repair, towing, dismantling, and abandonment.
- Persistent ship identity, component HP, disabled/towing state, cargo, and history.
- Pre-battle deployment with stable `campaignShipId ↔ battleShipId` bindings.
- Extraction preparation, normal/emergency jumps, jettison, deterministic jump damage, and sector summaries.
- Terminal campaign result flow and structured campaign log export.

## V0.7.1 playability pass

### A. Difficulty and encounter survival

- Campaign power uses hull-aware standard costs: Fighter 50, Frigate 150, Cruiser 360.
- Persistent ship power is reduced by component damage and disabled status.
- Normal encounters scale to the currently deployed operational fleet instead of a fixed sector-only budget.
- The pre-battle panel shows player power, estimated enemy power, ratio, and danger class.
- Deterministic evasion exposes both the calculated chance and stable result.
- A pending encounter can be abandoned before battle by spending fuel and returning to its origin node.
- Campaign battles expose a manual full-fleet retreat command.
- Automatic retreat checks run after fixed simulation ticks rather than render frames.
- Retreat preserves component damage, grants no salvage, and leaves the encounter unresolved.

### B. Fleet recovery economy

- Disabled enemy ships can occasionally appear as a post-battle recovery choice.
- A recovered hull joins at low component integrity in disabled/towed state.
- Rescue signals provide a damaged friendly Fighter as an early recovery path.
- Sectors generated for a fleet with one or fewer operational ships guarantee a recovery opportunity.
- Field repair can reactivate disabled ships once core, engine, and weapon systems are operational.

### C. Structured sector map and readability

- Sectors use seven left-to-right route layers, multiple forks, regional themes, and deterministic shortcuts.
- The first sector guarantees early resources, a rescue signal, and no forced battle nodes in its first two layers.
- Nodes, connectors, traveled routes, battle ships, and the space background have stronger visual separation.

## V0.8 commander career system

### Creation and profile

- New campaigns provide commander name and starting-focus controls.
- Starting focuses are balanced, tactician, quartermaster, scout, and survivor.
- Commanders have command, tactics, logistics, and resolve attributes.
- Every commander receives two unique deterministic traits; a focused profile guarantees one related trait.
- Profiles are deterministic for the same campaign seed, commander id, and creation choices.

### Career progression

- Domain experience is split into combat, exploration, logistics, and survival.
- Exploration, signals, gathering, battle results, repair, evasion, hazards, and extraction contribute to relevant domains.
- Experience is reconstructed from persisted campaign history, making save synchronization idempotent.
- Total experience raises commander level at stable thresholds.

### Health and campaign effects

- Fatigue, shaken, wounded, and scarred conditions have severity and duration.
- Wounds, burns, fractures, trauma, and fatal injuries are persistable records.
- Fatigue and logistical aptitude affect turn-based supply consumption.
- Attributes, traits, conditions, and injuries affect deterministic pre-battle evasion chance.
- Battle losses, failed evasion, hazards, and emergency extraction can create negative conditions or trauma.
- Treatment consumes one turn and two additional supplies, reducing the most serious treatable condition or injury.
- A severity-three nonfatal injury incapacitates the active commander.

### Recruitment and succession

- Eligible signal resolutions can produce two deterministic recruitment candidates.
- Recruitment costs supplies and adds one candidate to a reserve roster capped at three.
- Recruitment offers and reserve rosters are blocking decisions and persist in Campaign Code.
- A dead or incapacitated active commander triggers a succession choice when an available reserve exists.
- An available reserve can be appointed as active commander; a living incapacitated predecessor moves into reserve.
- With no usable successor, commander death ends the campaign; an incapacitated living commander may still be treated.
- Total fleet destruction records a fatal commander injury with cause `舰队全歼`.

### Save compatibility and validation

- Campaign Code remains `0.2` during this additive milestone.
- V0.6/V0.7 and earlier V0.8-compatible saves receive complete commander profiles, empty reserve rosters, and succession defaults.
- Additive migrations are written back even when the numeric save version does not change.
- Deep validation covers attributes, traits, domains, conditions, injuries, unique commander ids, roster size, recruitment candidates, and valid succession states.

### UI

- The campaign menu includes commander creation controls.
- The campaign HUD and commander card show level, attributes, traits, domain experience, conditions, and injuries.
- Recruitment, treatment, reserve roster, and successor appointment are playable through the sector screen.

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

`npm run test:campaign` runs frozen V0.6 regressions, V0.7 persistence/extraction tests, V0.7.1 playability tests, and the V0.8 commander suite.

## Remaining manual review items

- Test commander creation and roster panels on narrow mobile layouts.
- Confirm that recruitment frequency feels useful without making succession trivial.
- Review treatment cost and negative-condition durations over a full three-sector campaign.
- Encounter power remains an advisory heuristic rather than a guaranteed win probability.

## Next milestone after V0.8

V0.9 should focus on organizations, government/faction identity, and a modular technology framework without adding multiple player fleets or changing frozen core-v4 battle defaults.

## Still out of scope

- Multiple player fleets and bases.
- Full faction diplomacy and markets.
- Succession politics beyond the local active/reserve commander handoff.
- Random equipment affixes or a complete equipment system.
- New core-v4 ship classes, variants, or default replay balance changes.
