# Escape from SpaceWar · 太空搜打撤 SLG 原型

基于 TypeScript、Vite 和 Three.js 的确定性太空战斗与战役原型。

项目当前同时保留三条入口：

- `core-v4` 单场 3D 太空战斗；
- V0.6～V0.9 的七层航道兼容战役；
- V1.0「单星域高速 SLG + 星门撤离」主方向（V1.0-B 已完成真实逐舰舰队与 core-v4 战略战斗接线）。

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
- 星门位于距离入口较远的敌方控制区；
- 星域开局至少有两个真实敌方据点；
- 玩家开局没有免费永久基地，只拥有一支远征舰队和有限资源。

### 高速 SLG 发展

玩家可以占领已测绘的无主空间站，建立本星域临时基地。基地可建设：

| 设施 | 作用 |
|---|---|
| 临时太阳能阵列 | 每回合提供能源 |
| 自动采矿阵列 | 每回合提供矿物 |
| 星域研究实验室 | 每回合提供科学 |
| 补给生产线 | 每回合提供补给 |
| 战地维修坞 | 修复失能舰 |
| 据点防御网 | 降低敌方袭击损失 |

设施和建设队列都属于当前星域，撤离后不会继承。

### 本地科研与长期蓝图

本星域科研：

- 本地航路解析：降低当前星域航行燃料；
- 快速装配工艺：缩短当前星域建造时间；
- 危机演化预测：降低危机压力增速；
- 星门快速校准：提高每次校准进度。

这些研究在穿越星门后重置。

科研遗迹可以产出长期蓝图：

- 远征后勤核心；
- 强化舰体蓝图；
- 紧凑工业核心。

长期蓝图只有成功撤离后才会进入继承状态。

### 危机与敌军后台

每个星域具有不可逆危机：

1. 立足窗口；
2. 争夺阶段；
3. 崩溃阶段；
4. 最终撤离。

危机会提高压力、缩短安全窗口，并推动敌方从现有据点沿航线扩张。敌方控制区具有实际战力，舰队必须进行战略战斗才能清除；敌军还可能袭击玩家前进基地。

### 星门撤离

星门需要被发现、清除守军并逐步校准。

- **稳定撤离**：需要 100% 校准、补给和燃料，可携带更多资源和失能舰；
- **紧急撤离**：40% 校准即可启动，但会丢失失能舰、大部分资源，并可能遭受额外舰损；
- **断后撤离**：可主动留下舰船断后，降低高压紧急撤离的额外风险。

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
- 版本：`1.0-alpha.5`（真实逐舰舰队；敌方战力自 V1.0-B.1 起改用 core-v4 舰船成本量纲）；`1.0-alpha.2` 抽象舰队 / `1.0-alpha.3` 旧量纲敌战力 / `1.0-alpha.4` 旧 escaped 语义存档均会确定性迁移为 `1.0-alpha.5`
- 保存当前星域、实体、敌军、设施、队列、危机、星门、真实舰队与跨域继承状态
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

## 验证矩阵

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

`npm run test:strategy` 覆盖（59 项，无 `as unknown as` 伪造 BattleState）：

- 九星系确定性生成与图连通；
- 星门、科研遗迹和敌方据点；
- 无基地开局与据点占领；
- 临时建设与回合生产；
- 本地科研效果与跨域重置；
- 危机阶段与超时失败；
- **战略敌方战力与 core-v4 舰船成本同量纲**（预算≥最低合法舰船成本，且等于按预算生成的真实敌舰队成本）；
- 不同星域前哨 / 星门守卫预算因子差异（约 45%～150% 基线）；
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
- alpha.2 的零值、极低值和高值迁移保持确定、合法并按最近可达战力钳制；Sector Expedition Code 仍为 `1.0-alpha.5`。
- jsdom 测试使用可通过 `validateUniverseState` 的真实状态：所有战略按钮在各自合法上下文中派发正确 action，pending 状态在 DOM 与 reducer 两层锁定行动。

> V1.0-B.1 修复了一处真实写回缺陷：`applyStrategicBattleResult` 原先将战后 `enemyPower` / `control` 写到了原始 `state` 的星系对象上，而返回值是深拷贝的 `next`，导致敌方剩余战力从未真正生效、星系清零逻辑失效；现改为写入克隆后的 `target` 星系。

## 当前边界

V1.0-B.5 已完成战略参战/可选择资格拆分、严格 deployment/binding 集合、组件状态、敌袭与维修持久化、低战力迁移和真实 DOM 行为的闭环；策略套件现为 64 项，真实 DOM 覆盖采用 jsdom。以下内容仍属于 V1.0-C：

- 将 V0.8 指挥官与候补系统接入新模式；
- 多据点与真实运输航线；
- 舰船生产和模块装配；
- 更完整的敌方舰队移动、围攻和星门决战；
- 撤离时逐舰分配护送、断后和抛弃任务的精细化调度。

下一阶段为 **V1.0-C：据点网络、敌方舰队后台模拟与指挥官系统**。
