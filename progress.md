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

The V1.0-A fleet is still an abstract strategic placeholder, but now tracks:

- ship count
- disabled ships
- combat power
- strategic fuel
- cumulative ship losses

Strategic combat can permanently reduce enemy power, disable ships or destroy ships. A repair dock can restore disabled ships at a material and supply cost.

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
- New version: `1.0-alpha.2`.
- Deep validation covers graph references, enemy control, facilities, queues, crisis, gate state, fleet state and inherited assets.
- The earlier `1.0-alpha.1` permanent-universe experiment migrates by resetting into a new first strategic sector.
- The old Campaign Code and the new Sector Expedition Code remain separate.

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

The V1.0-A strategic suite covers:

- deterministic nine-system generation and connectivity
- gate, relic and hostile-system generation
- no-base opening and station occupation
- temporary construction and turn income
- local research and cross-sector reset
- crisis phase progression and timeout defeat
- enemy-power reduction and system clearing
- disabled-ship repair
- emergency extraction losses
- three-sector completion
- `1.0-alpha.2` code round-trip and invalid-state rejection

## Next milestone: V1.0-B/C

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
