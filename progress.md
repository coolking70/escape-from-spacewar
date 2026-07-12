# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 sector Roguelike vertical slice is frozen.
- V0.7 campaign save format is `0.2`; local and exported V0.6 `0.1` states migrate in place.
- GitHub Actions uses Node.js 24.

## V0.7 completed scope

### Persistent fleet and cargo

- Capacity-limited cargo with supply crates, fuel cells, repair parts, and relics.
- Deterministic post-battle salvage with quick, thorough, and leave choices.
- Cargo overflow reporting and manual jettison actions.
- Field repair using repair parts, turns, and threat.
- Disabled-ship towing, dismantling, and permanent abandonment.
- Towing increases movement and jump fuel costs.
- Ships, component HP, cargo, disabled/towing state, and history persist across sectors.

### Pre-battle deployment

- Every pending campaign battle exposes an eligible-ship deployment list.
- At least one active ship must remain selected.
- Unselected ships remain with the persistent fleet but do not enter core-v4.
- Actual `campaignShipId ↔ battleShipId` binding count matches the selected deployment.
- Deployment eligibility resets after battle without changing ship identity or damage.

### Extraction planning

- Gate UI shows jump fuel, safe cargo capacity, current load, risk score, risk class, and all contributing factors.
- Jump preparation consumes a turn and lowers the visible risk score.
- Untowed disabled ships block extraction.
- Normal extraction rejects unsafe overload.
- Cargo can be jettisoned manually to restore safe load.
- Emergency extraction deterministically auto-jettisons excess cargo and applies visible-risk-derived component damage.
- Jump effects are derived from campaign seed, sector, turn, ship ID, and stable labels.

### Sector summary

- The previous sector summary records turns, explored nodes, fleet condition, cargo, threat, extraction mode, risk, jettisoned cargo, and jump-damaged ships.
- Summary and extraction state are included in Campaign Code deep validation.

## Verification

The final V0.7 verification matrix is:

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:stress
npm run build:static
```

`npm run test:campaign` runs both the frozen V0.6 regression suite and V0.7 cargo, salvage, repair, towing, deployment, extraction, migration, determinism, and summary tests.

## Frozen V0.7 limitations

- Campaign battles still do not support seek, timeline replay, or Replay Code sharing because inherited component HP is outside Replay v0.5.
- Deployment only selects participants inside one persistent fleet; it does not create multiple independent fleets.
- Emergency jump damage is deterministic and simplified; there is no crew injury or permanent component replacement system.
- Cargo contains fixed item categories without equipment affixes.

## Next milestone: V0.8 commanders

V0.8 should focus on commander creation, attributes, traits, domain experience, injuries, negative conditions, recruitment, and death rules without changing core-v4 battle balance.

## Still out of scope

- Multiple player fleets and bases.
- Technology trees.
- Faction organizations, governments, diplomacy, and markets.
- Succession and legacy politics.
- Random equipment affixes or a complete equipment system.
- New core-v4 ship classes, variants, or balance changes.
