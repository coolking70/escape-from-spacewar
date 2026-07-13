# Development Progress

## Current baseline

- `spacewar-core-v4` remains frozen.
- Replay format remains `v0.5` with ruleset `spacewar-core-v4`.
- V0.6 through V0.8.1 campaign milestones are frozen on `main`.
- V0.9 upgrades Campaign Code from `0.2` to `0.3` while retaining `0.1` and `0.2` migration.
- Campaign Log format is `1.1`.
- GitHub Actions uses Node.js 24.

## Frozen campaign foundation

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
- Recruitment cadence, treatment cost, trauma thresholds and narrow-screen UI completed through playtest closeout.

## V0.9 organization and modular technology

### A. Organization identity

- Four archetypes: expedition, military, commerce and exile.
- Five governments: military council, captains assembly, corporate board, technocracy and emergency directorate.
- Two distinct values selected from order, freedom, survival, expansion, knowledge, profit and unity.
- Stable organization id and default values derived from campaign seed and creation choices.
- Organization stability plus civilian, military and frontier reputation.

### B. Government and archetype effects

- Expedition organizations reduce scan pressure and begin with deep sensors.
- Military organizations and military councils improve tactical research.
- Commerce organizations and corporate boards improve material gathering.
- Exile organizations reduce treatment and emergency logistics costs.
- Technocracy improves action-derived research.
- Emergency directorate further reduces emergency refuel cost.
- Values unlock organization-event options and modify research, logistics or survival decisions.

### C. Research and modular technology

Research resources:

- navigation
- engineering
- tactical
- social

Research is earned from scanning, gathering, signals, battle, salvage, repair, treatment and extraction.

Technology modules:

- jump calibration
- modular cargo
- field repair protocol
- deep sensor array
- retreat coordination
- trauma care

Each organization begins with one archetype technology installed and has two technology slots. Technology must be unlocked with research resources before installation. Installed modules affect campaign calculations only.

### D. Campaign integration

- Organization creation is part of the new-campaign menu.
- Organization identity, stability and government appear in the campaign HUD.
- A full organization and technology card supports unlock, install and uninstall actions.
- Modular cargo adjusts live cargo capacity and cannot be removed while the resulting capacity would be exceeded.
- Deep sensors affect scan threat and evasion.
- Jump calibration affects extraction fuel.
- Repair and trauma technologies affect field operations.
- Retreat coordination affects evasion and post-battle stability.
- Structured Campaign Log exports include organization, research and technology state.

### E. Organization events

- Entering a new sector creates one deterministic organization event.
- Events currently cover rescue allocation, route security and relic disposition.
- Options can require organization values.
- Effects can modify stability, reputation, research, supplies, fuel, materials and threat.
- A pending organization event blocks normal sector actions until resolved.
- Stability reaching zero ends the campaign in defeat.

## Save migration and validation

- Campaign Code version is `0.3`.
- `0.1` and `0.2` saves receive a deterministic default expedition organization.
- Migration adds organization identity, reputation, research, technology slots and event defaults.
- Invalid or duplicate technology ids are normalized during migration.
- Deep validation covers organization identity, two unique values, stability, reputation, research resources, technology unlock/install relationships and pending organization events.
- Additive migration is written back to the existing local-storage key.

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

`npm run test:campaign` runs V0.6, V0.7, V0.7.1, V0.8, V0.8.1 and V0.9 suites.

The V0.9 suite covers:

- deterministic organization creation and archetype starting modules
- `0.2 → 0.3` migration
- Campaign Code round-trip and invalid organization rejection
- research gains and organization modifiers
- technology unlock, installation, removal and cargo safety
- deterministic value-gated organization events
- event action blocking
- cross-sector event creation
- jump fuel technology
- treatment cost and organization-collapse defeat
- a complete three-sector V0.9 smoke flow

## V0.9 boundary

V0.9 deliberately does not add:

- multiple player fleets or bases
- external faction diplomacy
- market prices or trade routes
- internal political factions or voting simulations
- a large branching technology tree
- new core-v4 ship classes, variants or default battle balance

## V0.9 hardening maintenance

- Terminal campaigns and pending decision states now reject technology, treatment, and emergency-refuel actions consistently with the base reducer.
- Current `0.3` Campaign Codes are strictly validated; only explicit historical map/commander compatibility fields are filled during local migration.
- Campaign-facing imported text is HTML-escaped before rendering, including organization and commander names plus historical log text.
- Organization, cargo, fleet, and commander management controls are disabled while a pending decision owns the action flow.

## Next milestone candidate

After V0.9 playtest acceptance, the next milestone should deepen one of the existing strategic systems rather than widen all of them at once. The recommended path is a V0.9.1 balance and usability pass followed by a focused V1.0 vertical campaign release plan.
