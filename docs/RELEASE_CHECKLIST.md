# V1.0 Release Candidate Checklist

## Release identity

- Application: `1.0.0-rc.1`
- Replay: `v0.5` / `spacewar-core-v4`
- Compatible route campaign: Campaign Code `0.3`, Campaign Log `1.1`
- Strategic expedition: Sector Expedition Code `1.0-alpha.13`
- Supported strategic migrations: deterministic in-place migration from `1.0-alpha.2` through `1.0-alpha.12`; the discarded `1.0-alpha.1` universe experiment resets to a fresh first sector

Application and save versions are intentionally independent. E.1–E.4 add recovery, UX and release gates without changing serialized strategic gameplay state.

## Required release gates

Run from a clean checkout with Node.js 24:

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:strategy
npm run test:browser
npm run test:browser:production
npm run test:stress
npm run build:static
npm run test:browser:static
git diff --check
git status --short
```

Expected invariants:

- `npm audit` reports zero vulnerabilities after `npm ci`.
- Deterministic/golden replay coverage remains green; golden files are unchanged.
- Strategy coverage reports 100 cases and the 50v50 stress hash is `b66a7cee`.
- Development, production and standalone Chromium targets each complete the canonical three-sector run with six real Three.js/core-v4 battles and no console errors.
- The standard production build lazily requests preview/battle chunks.
- `static/index.html` is self-contained and the standalone browser target requests no external `assets` resources.

## GitHub release flow

1. Review the E-series diff against `main`; do not merge with failing or pending required checks.
2. Merge the reviewed release-candidate pull request into `main`.
3. Confirm both `CI` and `Deploy playable build to Pages` succeed on the merge commit.
4. Open the deployed Pages build and smoke-test new expedition, continue-save, one single battle and strategic log download.
5. Create the `v1.0.0-rc.1` tag only after the deployed artifact matches the merge commit.

Rollback uses the previous successful Pages artifact/merge commit. Do not downgrade a current `1.0-alpha.13` save into an older application; preserve an exported Sector Expedition Code before rollback testing.

## Known limitations

- One player-controlled strategic fleet; no multi-fleet command layer.
- No permanent empire map, colonies, population or workforce simulation.
- No diplomacy, market or trade simulation in the V1.0 strategic mode.
- Strategic movement is turn-based, not real-time.
- D.4 modules are strategic-only; there is no combat-affecting equipment or module technology tree.
- Saves are browser-local unless the player exports a code. E.1 keeps one previous valid browser backup and preserves corrupt primary text, but it is not cloud synchronization.
- The repository currently contains no explicit open-source license. Public source-distribution terms require a separate owner decision.

These limitations are release boundaries, not partially implemented hidden features. Core-v4 combat rules, ship values, status semantics and golden replays remain frozen.
