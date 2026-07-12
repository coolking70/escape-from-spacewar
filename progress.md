# Development Progress

## Current baseline

- `spacewar-core-v4` is frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- Campaign save format is `0.1`.
- V0.6 sector Roguelike vertical slice has passed final acceptance and is frozen.
- GitHub Actions uses Node.js 24.

## V0.6 completed scope

- Deterministic 20–30 node sector generation.
- Reachable hidden gate and three-sector victory flow.
- Fog of war with hidden, detected, scanned, and visited states.
- Movement, scanning, gathering, signal events, hazards, waiting, and gate extraction.
- Sector threat growth, patrol encounters, and high-threat gate guards.
- Campaign battle routing through the existing core-v4 Three.js battle UI.
- Stable `campaignShipId ↔ battleShipId` bindings.
- Persistent destroyed, escaped, disabled, and component HP results.
- Campaign Code and localStorage persistence with deep validation.
- Node campaign tests covering deterministic generation, actions, events, hazards, saves, bindings, damage inheritance, and defeat rules.

## Final verification

The complete acceptance matrix passed:

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:stress
npm run build:static
```

The standard CI workflow executes build, acceptance, campaign, stress, and static-build checks on push and pull request.

## V0.6 frozen limitations

- Campaign battles do not support seek, timeline replay, or Replay Code sharing because inherited component HP is not represented by Replay v0.5.
- There is no repair or salvage system.
- There is no cargo capacity or loot inventory.
- Only one player fleet and one placeholder commander are supported.
- No bases, technology tree, market, diplomacy, organization, succession, or commander progression are implemented.

## Next milestone: V0.7 persistent fleet and extraction loop

V0.7 should add:

1. Cargo capacity and deterministic loot.
2. Post-battle salvage choices.
3. Field repair using materials and turns.
4. Disabled-ship towing, dismantling, and abandonment.
5. Pre-battle deployment selection.
6. Extraction planning, overload handling, and visible jump risk factors.
7. Sector-end summary and cross-sector persistence of ships, damage, cargo, and history.

## Still out of scope for V0.7

- Full commander creation, traits, injuries, recruitment, and succession.
- Multiple player fleets.
- Base construction.
- Technology trees.
- Faction organizations, governments, diplomacy, and markets.
- Random equipment affixes or a complete equipment system.
- New core-v4 ship classes, variants, or balance changes.
