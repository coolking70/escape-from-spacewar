Original prompt: 在当前仓库开发 V0.6 星域 Roguelike 垂直切片，保持 spacewar-core-v4 冻结，完成确定性星域探索、资源、威胁、战斗接入、撤离、保存、UI、测试、CI 与推送。

## Progress

- Baseline passed: `npm ci`, build, acceptance, stress, and static build.
- Added deterministic campaign/sector logic, persistent-fleet adapter, save/code helpers, campaign UI, and Node campaign tests.
- Next: browser interaction verification, final regression suite, commits and push.

## TODO

- Persistent fleet and core-v4 battle-result adapter.
- Campaign persistence/code, DOM campaign UI, CI campaign test, browser verification.
