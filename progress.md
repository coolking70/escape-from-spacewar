# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 sector Roguelike vertical slice is frozen.
- V0.7 campaign save format is `0.2`; local and exported V0.6 `0.1` states migrate in place.
- GitHub Actions uses Node.js 24.

## V0.7A completed scope

- Capacity-limited cargo with supply crates, fuel cells, repair parts, and relics.
- Deterministic post-battle salvage generation from campaign seed, sector, node, battle index, and BattleState.
- Quick salvage, thorough salvage, and immediate-departure choices with visible turn and threat costs.
- Cargo overflow handling with accepted and rejected loot reporting.
- Consumable supply and fuel cargo.
- Field repair that consumes repair parts and repairs the largest eligible component deficit.
- Disabled-ship towing, dismantling, and permanent abandonment.
- Towed disabled ships increase movement fuel cost.
- Untowed disabled ships block gate extraction until the player resolves them.
- Fleet damage, cargo, disabled state, towing state, and history persist across sectors.
- Campaign UI for cargo, salvage, repair, towing, dismantling, and abandonment.
- Dedicated V0.7 Node tests in addition to the frozen V0.6 campaign regression suite.

## Verification

The V0.7A branch passes:

```bash
npm ci
npm run build
npm test
npm run test:campaign
npm run test:stress
npm run build:static
```

`npm run test:campaign` now runs both the frozen V0.6 campaign suite and the V0.7 persistent-fleet suite.

## V0.7B remaining scope

1. Pre-battle deployment selection inside the single persistent fleet.
2. Visible extraction planning and jump-risk factors.
3. Overload resolution before extraction.
4. Expanded sector-end summary and statistics.
5. Final V0.7 balance pass and end-to-end extraction scenario.

## Still out of scope for V0.7

- Full commander creation, traits, injuries, recruitment, and succession.
- Multiple player fleets.
- Base construction.
- Technology trees.
- Faction organizations, governments, diplomacy, and markets.
- Random equipment affixes or a complete equipment system.
- New core-v4 ship classes, variants, or balance changes.
