# Escape from SpaceWar · 太空搜打撤 SLG 原型

基于 TypeScript、Vite 7 和 Three.js 的确定性太空战斗与战役原型。

项目当前同时保留三条入口：

- `core-v4` 单场 3D 太空战斗；
- V0.6～V0.9 的七层航道兼容战役；
- V1.0「单星域高速 SLG + 星门撤离」主方向（V1.0-E.2 已完成发布候选 UI/UX 收尾）。

## V1.0-A：单星域高速 SLG 重构

新的主模式不再使用“永久大宇宙 → 进入 FTL 小地图”的双层结构。每个星域本身就是一局完整但快速推进的战略地图：

```text
进入陌生星域
→ 探索星系与长期实体
→ 清除敌军、抢占空间站
→ 建立临时前进基地
→ 采集、建设、研究、维修
→ 在危机持续升级时寻找并校准星门
→ 稳定撤离或舍弃资源/舰船紧急突围
→ 继承舰船、蓝图和有限压缩物资进入下一星域
```

### 星域结构

- 每个星域生成 9 个确定性星系；
- 航线组成非分层、整体连通的战略图；
- 实体包括行星、卫星、空间站、小行星带、科研遗迹和星门；
- 星门位于距离入口较远的中立星系，普通敌方扩张不会占领星门；
- 星域开局包含一个固定敌方据点和一支会移动、围攻的真实 raider 特遣舰队；
- 玩家开局没有免费永久基地，只拥有一支远征舰队和有限资源。

### 高速 SLG 发展

玩家可以占领已测绘的无主空间站，先建立唯一主基地，再把其他安全空间站建设为临时补给前哨。每个据点拥有独立设施槽和建造队列；次级前哨通过已发现航路向主基地输送资源，路径被敌军控制时运输会中断。各据点可建设：

| 设施 | 作用 |
|---|---|
| 临时太阳能阵列 | 每回合提供能源 |
| 自动采矿阵列 | 每回合提供矿物 |
| 星域研究实验室 | 每回合提供科学 |
| 补给生产线 | 每回合提供补给 |
| 战地维修坞 | 修复失能舰 |
| 据点防御网 | 降低敌方袭击损失 |
| 轻型轨道船坞 | 在主基地生产现有 core-v4 舰体与改型 |

设施和建设/生产队列都属于当前星域，撤离后不会继承；已经交付的舰船拥有稳定 `campaignShipId`，会随唯一战略舰队正常撤离继承。

### 本地科研与长期蓝图

本星域科研：

- 本地航路解析：降低当前星域航行燃料；
- 快速装配工艺：缩短当前星域建造时间；
- 危机演化预测：降低危机压力增速；
- 星门快速校准：提高每次校准进度。

这些研究在穿越星门后重置。

科研遗迹可以产出长期蓝图：

- 远征后勤核心：跨域激活后最大燃料 +2、航行燃料 -1（最低 1）；
- 强化舰体蓝图：免除高压紧急撤离的额外舰损，不修改 core-v4 舰体或组件 HP；
- 紧凑工业核心：设施和舰船生产的矿物成本 -4（最低 0）。

长期蓝图只有成功撤离后才会进入继承状态；本星域刚取得时会明确显示“待撤离后激活”。

### 危机与敌军后台

每个星域具有不可逆危机：

1. 立足窗口；
2. 争夺阶段；
3. 崩溃阶段；
4. 最终撤离。

危机会提高压力，并推动敌方从现有据点沿航线扩张。每个星域都有 17 回合行动窗口，高星域的压力增长和移动敌军目标预算更高。普通领土扩张只建立固定驻军，不会绕过可见敌军直接远程伤害玩家据点；据点攻击统一由持久特遣舰队完成。特遣舰队按确定性最短路每回合移动一跳；已发现位置会显示在星图上，进入运输链会中断送达，抵达玩家据点后会形成围攻。无防御网据点有 2 回合响应窗口，防御网可延长窗口；舰队抵达后倒计时暂停，玩家可在现有 Three.js 战斗界面迎战。

### 星门撤离

星门需要被发现并逐步校准。星门开局不叠加固定驻军；首次达到可启动阈值时会触发本星域唯一一场不可绕过的真实 `core-v4` 星门防御战。击毁、失能或迫使拦截舰队撤离后才能撤离。

- **稳定撤离**：需要 100% 校准、补给和燃料；玩家按稳定舰船 ID 为每艘舰指定随队、拖曳或放弃；
- **紧急撤离**：40% 校准即可启动；玩家按舰指定随队、拖曳、断后或放弃，拖曳失能舰有明确额外燃料/补给成本；
- **权威预览**：执行前显示准确的存活/损失舰 ID、携带资源和高压风险，实际结算复用同一计划，不依赖舰队数组顺序。

默认原型包含三个连续星域。第三星域撤离后获得战役胜利。

## 旧版兼容战役

V0.6～V0.9 仍可通过主菜单进入，包含：

- 七层航道与节点探索；
- 持久舰损、拖曳、打捞、维修与撤退；
- 指挥官属性、特质、伤病、招募与继任；
- 组织、政体、价值观、研究资源和模块科技；
- Campaign Code `0.3` 与 Campaign Log `1.1`。

该模式作为兼容与规则参考保留，V1.0 主方向不再继续扩大抽象事件节点图。

## core-v4 单场战斗

- 3 舰种 × 4 改型；
- 固定 30 tick/s；
- seed 驱动的确定性模拟；
- Three.js 3D 渲染；
- Replay Code `v0.5`；
- 舰队库、战前分析、平衡实验室与战舰图鉴。

V1.0-A 没有修改 core-v4 舰船模板、默认平衡、AI 或黄金回放。

## 存档格式

### Sector Expedition Code

- `type: "spacewar-sector-expedition"`
- 版本：`1.0-alpha.13`（在 D.3 永久蓝图闭环上加入逐舰战略模块装配）；`1.0-alpha.2` 至 `1.0-alpha.12` 存档均会确定性迁移到当前版本
- 保存当前星域、实体、固定驻军、移动特遣舰队、围攻、设施、建设/生产队列、危机、星门防御、真实舰队、逐舰战略模块与跨域继承状态
- 旧 `1.0-alpha.1` 永久宇宙实验存档会重置迁移为新的第一星域

### Campaign Code

- `type: "spacewar-campaign"`
- 版本：`0.3`
- 用于旧版七层航道兼容战役

### Replay Code

- 版本：`v0.5`
- 规则集：`spacewar-core-v4`

## 安装与运行

```bash
npm install
npm run dev
```

开发服务器默认只监听 `127.0.0.1`。生产构建不会打包浏览器调试测试套件；Three.js 战舰图鉴与战斗场景按需加载。`npm run build:static` 则将动态模块和内联 Worker 合并回单个 HTML，并在写出前检查不存在外部 `assets/` 引用。

## 验证矩阵

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:strategy
npm run test:browser
npm run test:stress
npm run build:static
```

`npm run test:strategy` 覆盖 100 项（无 `as unknown as` 伪造 BattleState），其中 C.5 正式矩阵对 65 个 seed 逐步执行远征码往返与六场真实 core-v4 战斗并全部取得三星域胜利；额外 1000-seed 发布探针同样无失败。`npm run test:browser` 使用真实 Chromium 验证星域界面的视口滚动、指挥官招募、真实航行、次级前哨建立、本地建设队列、移动敌军、主基地围攻、舰队回防、D.1 船坞生产、D.2 逐舰撤离、D.3 遗迹蓝图取得/跨域激活、D.4 逐舰装配/卸下、E.1 招募/战斗中断刷新恢复与损坏主槽备份恢复，以及 E.2 键盘焦点、危险操作取消/确认、锁定原因和战略日志下载；完整三星域 UI 流程仍完成六次 Three.js 战斗和胜利结算。也可通过 `BROWSER_TEST_URL` 验收已经启动的单文件静态站点：

- 九星系确定性生成与图连通；
- 星门、科研遗迹和敌方据点；
- 无基地开局与据点占领；
- 临时建设与回合生产；
- 本地科研效果与跨域重置；
- 危机阶段与超时失败；
- **战略敌方战力与 core-v4 舰船成本同量纲**（预算≥最低合法舰船成本，且等于按预算生成的真实敌舰队成本）；
- 不同星域前哨 / 星门守卫预算因子差异（约 45%～150% 基线）；
- 移动 raider 与强制星门防御另使用 C.5 压力预算：完整舰队的目标逐域提高，同时分别受当前舰队战力 55% / 65% 上限约束；
- `strategicEnemyFleetFor` 确定性且不对强敌压缩；
- `validateUniverseState` 拒绝敌战力与控制不一致的存档（敌方控制但 0 战力 / 非敌方却有正战力 / 低于最低合法预算）；
- `engageEnemy` 仅锁定 `PendingStrategicBattle`，不直接削减敌方战力；
- 待处理战斗锁定 travel / advance-turn，但允许选择星系；
- **待处理战斗逻辑层锁定**：`canQueueFacility` / `canQueueResearch` / `canEngageEnemy` / `canCalibrateGate` / `canExtractSector` 在 pending 时一律 false（与 UI 禁用共同防呆）；
- 单舰高压紧急撤离最多损失 `max(0, 总数-1)`，不产生空舰队；
- `previewExtractLosses` 返回具体舰船 ID 且与实际撤离一致；
- 真实 `core-v4` 战斗结果写回：destroyed 删除、敌方剩余战力由真实 Team B（部分摧毁）重算、清零转 neutral、单回合推进；
- 写回后 escaped 玩家舰归一化为 `escaped=false / deployed=true`，未参战舰状态完全不变；
- `validatePersistentBattleBindings`：合法通过；重复 campaignShipId / 未部署舰参战 / hull·改型不匹配 / battleShipId 重复 均抛错；
- 写回幂等与玩家全灭 → 崩溃；
- 战斗 seed / ruleset 不一致、敌方舰队与 pending 不一致、战后战力高于战前 一律拒绝写回；
- 跨星域继承真实舰队（舰船 ID 持续保留）；
- `1.0-alpha.2` → `1.0-alpha.4` 迁移为真实舰船（旧抽象战力换算为 core-v4 价值、保留失能舰）；
- `1.0-alpha.3` → `1.0-alpha.4` 迁移确定性重建敌战力（旧量纲 → core-v4 价值）；
- `1.0-alpha.4` 远征码完整往返 + 拒绝损坏状态（不存在星门 / 重复永久蓝图）；
- **V1.0-B.2 `BattleState` 深层校验**：`version` / `ruleset` / `seed` / `teamACount`·`teamBCount` 与在场舰数一致 / 舰 id 唯一 / 数值有限 / 每舰 `def`·组件·状态机一致 / `Team B` 等于 pending 敌舰队，任一项不符即拒绝写回；
- **低残余敌战力归一化**：残余低于最低合法舰船成本（=`minimumStrategicFleetCost()`=45，侦察型 Fighter）一律归零并转 `neutral`，修复「严重受损存活敌舰产生低于最低成本的残余无法保存」与「低残余被下一战膨胀成整舰」；
- **`1.0-alpha.4` → `1.0-alpha.5` 迁移**：`escaped` 归一化为 `false`、缺失 `deployed` 补全为 `true`、缺失 `towed` 补全为 `false`，并断言 `operational` 计数等于 `activeShips` 长度（escaped 语义统一），失能舰保留；
- **alpha.2 抽象战力单调迁移**：`combatPower` 越高迁移战力不下降、失能关键组件归零；
- **UI 锁定**：单一 `disabled` 属性（无 `disableddisabled` 重复）、`can*` 逻辑层与 UI 层在待处理战斗时共同锁定；
- **真实集成写回**：完整 `prepareStrategicBattle` → `createSimulator` 跑完 → `applyStrategicBattleResult`，结果自洽且可远征码往返（无 `as unknown as` 伪造，且不再手工 `syncBattleCounts` 回写，直接消费模拟器权威 `getState()`）。

### V1.0-B.3 低预算敌军生成闭环、持久战斗绑定完整性与测试真实性

- **低预算敌军生成闭环**：`strategicEnemyFleetFor(0)` 与任意低于 `minimumStrategicFleetCost()`（=45，侦察型 Fighter）的预算不再回退为标准战斗机——低于最低成本归一化为**空敌舰队**（成本 0），恰好等于最低成本则生成非空合法舰队；「低预算被膨胀成整舰」被重新定义为缺陷并由测试拒绝。
- **alpha.4 子最低成本正 `enemyPower` 迁移修复**：alpha.4 下映射到不足一艘合法舰的正 `enemyPower` 不再在迁移中被复活为整舰，而是归一化为 `0` / `neutral`。
- **绑定完整性**：`validatePersistentBattleBindings` 现在同时拒绝**失能**持久舰参战，并保证绑定集合等于实际参战舰集合（每艘在场舰恰好一个绑定，无孤儿绑定）。
- **待处理部署参与**：Team A 集合校验现在纳入 `pendingBattle.deployment` 选中舰，部署受限的战斗不会绑定未部署舰。
- **`BattleState` 一致性硬化**：`destroyed` 与任何 `escapedTick` / `retreatStartedTick` 互斥（模拟器在死亡时清空）；`disabled` 依据**真实组件损毁**（`expectedDisableFlags`）校验而非仅信任布尔标志；alpha.5 校验拒绝 `escaped=true` 持久舰以保持舰队计数一致。
- **alpha.2 战力迁移真实校准**：`migrateAlpha2Fleet` 现在对照真实 `campaignFleetPower`（二分校准），而不只校验单调性，迁移战力在容差 `max(8, 5%)` 内逼近目标。
- **真实 DOM UI 锁定测试**：策略套件使用 jsdom 创建真实元素并验证 `button.disabled===true`、点击禁用按钮不触发回调、「继续战斗」/导出/返回保持可用、且无 `disableddisabled`。

### V1.0-B.4 状态不变量与测试真实性

- `isStrategicShipEligible(ship)` 是“当前可参战”的权威判断：仅 `!disabled && !escaped && deployed !== false` 的舰船可进入默认部署、Team A、pending battle 与 binding；B.5 另以 `!disabled && !escaped` 判断舰船是否可在 UI 中重新选择。空、重复、不存在或不合资格的显式 deployment 不能保存或启动。
- 战斗 binding 必须精确覆盖部署集合与实际 Team A；少绑、多绑、未部署或失能舰一律拒绝。
- `combatState` 与真实组件损伤使用模拟器同源逻辑校验。引擎/武器失能不得伪装为 normal/damaged；持久舰也拒绝“关键组件全毁而 disabled=false”。
- `escaped` 的最终 core-v4 语义为：`alive`/结构存活为 true，但 `isPresentOnBattlefield` 为 false；只有 destroyed 才结构死亡。
- alpha.2 极低战力迁移将 operational 舰钳制到每个组件至少 1 HP 的最近合法状态，并在迁移日志中说明钳制；Sector Expedition Code 版本仍为 `1.0-alpha.5`。
- alpha.3/alpha.4 的非空 pending enemyFleet 恢复真实舰队成本与 `enemy` 控制权；空 pending 清除为 `neutral`。战略敌军装箱现在有成本/剩余预算后置断言。
- UI 锁定测试使用 **jsdom** 的真实 `HTMLElement` / `HTMLButtonElement`，不再使用 FakeRoot/FakeNode。

### V1.0-B.5 战略舰队状态与持久化闭环

- 战略舰船状态复用共享组件规则：当前 operational 必须满足 `!disabled && !escaped && deployed !== false`；仅取消部署的舰船仍可由玩家重新选择。
- `deploymentFleet` 与 `prepareStrategicBattle` 对显式部署执行严格校验，空集合、重复 ID、不存在 ID、失能舰、逃脱舰和 `deployed=false` 舰均直接报错，不再静默回退为默认舰队。
- 失能状态按 core-v4 的“同类系统全部损毁”规则计算；敌袭通过真实组件损伤造成失能，维修和战斗写回均从组件 HP 重新计算 `disabled`。
- alpha.2 的零值、极低值和高值迁移保持确定、合法并按最近可达战力钳制；Sector Expedition Code 当前为 `1.0-alpha.13`。
- jsdom 测试使用可通过 `validateUniverseState` 的真实状态：所有战略按钮在各自合法上下文中派发正确 action，pending 状态在 DOM 与 reducer 两层锁定行动。
- 指挥官可用性与继任状态执行双向一致性校验；现任不可履职时，保存、编码、`can*` 判定、reducer 与 UI 共用同一行动锁。

> V1.0-B.1 修复了一处真实写回缺陷：`applyStrategicBattleResult` 原先将战后 `enemyPower` / `control` 写到了原始 `state` 的星系对象上，而返回值是深拷贝的 `next`，导致敌方剩余战力从未真正生效、星系清零逻辑失效；现改为写入克隆后的 `target` 星系。

## 当前边界

V1.0-D.4 在冻结 core-v4 的边界内加入一个以 `campaignShipId` 绑定的战略模块槽。辅助燃料舱使舰队最大燃料 +1，远程测绘阵列使该可用舰参与测绘时科学 +2，舰载维修工坊降低该舰维修成本；装配只能在安全主基地船厂完成，资源在正式 reducer 中扣除，舰船损失会清理悬空装配，存活舰则跨星域继承。模块不会写入 ReplayConfig、BattleState、舰船定义或战斗数值。Sector Expedition Code 为 `1.0-alpha.13`，策略套件现为 95 项。

V1.0-E.1 保持 Sector Expedition Code `1.0-alpha.13` 不变，并加固浏览器本地存档：主菜单使用无写入副作用的统一迁移探测；每次合法保存先保留上一份有效状态；主槽损坏或缺失时可从备份恢复，并保留损坏原文用于诊断。真实 Chromium 验证待处理招募、战斗界面刷新、相同 battleId 继续和损坏主槽恢复，策略套件现为 97 项。

V1.0-E.2 同样不升级存档版本：战略面板为被锁定操作提供 `title`/`aria-disabled` 原因，行动锁横幅使用实时警报语义，重渲染恢复当前控件焦点；模块替换、断后/放弃任务和含已知损失的撤离在正式 UI 中要求确认，取消不会进入 reducer。工具栏可导出包含远征摘要、资源、逐舰组件状态和完整事件历史的 JSON 日志。jsdom 与真实 Chromium 均验证取消/确认、日志下载和焦点闭环，策略套件现为 100 项。

后续仍不默认扩展多玩家舰队、基地升级树、模块科技树、实时战略移动、外交或市场，也不会借战略模块修改冻结的 core-v4 战斗规则和平衡。
