# Escape from SpaceWar · 3D 太空战斗与星域战役原型

基于 TypeScript、Vite 和 Three.js 的确定性太空战斗模拟器，并包含可玩的星域 Roguelike 战役。

单场战斗层使用固定 tick 和 seed 驱动；战役层在此基础上提供结构化星域探索、资源管理、持久舰损、打捞维修、舰队恢复、战前部署、撤退和星门撤离决策。

## 当前功能

### core-v4 单场战斗

- **舰队构筑**：3 舰种（Fighter/Frigate/Cruiser）× 4 改型，共 12 种合法组合
- **确定性模拟**：相同配置与 seed 得到一致结果（30 tick/s）
- **3D 观看**：Three.js 渲染、自动镜头、暂停和倍速
- **录像系统**：Replay Code 可复现普通单场战斗
- **舰队库、战前分析、平衡实验室和战舰图鉴**

### V0.6 星域基础切片

- 确定性星域、战争迷雾、扫描、移动、资源、信号、hazard 与威胁
- 复用 core-v4 的 3D 战役战斗
- 稳定 `campaignShipId ↔ battleShipId` 映射和组件 HP 继承
- 隐藏星门、跨星域撤离和第三星域胜利

### V0.7 持久舰队与搜打撤循环

- Campaign 存档格式 `0.2`，自动迁移 V0.6 `0.1` 存档
- 有容量和重量限制的货舱
- 战后打捞、战地维修和组件损伤管理
- 失能舰拖曳、拆解或永久放弃
- 战前选择本场参战舰，未部署舰船留守
- 撤离规划、跃迁准备、主动抛货和紧急跃迁
- 星域结算和舰队、货物、损伤跨星域继承

### V0.7.1 可玩性与表现

- 舰体级战力成本，不再把标准护卫舰和巡洋舰按战斗机价格计算
- 普通敌军根据当前部署舰队和实际组件完整度缩放
- 战前显示敌我战力、危险等级和确定性规避概率
- 可尝试规避或消耗燃料退回上一节点
- 战役战斗可手动命令全舰撤退
- 自动撤退策略在每个固定模拟 tick 后判定，不受帧率和倍速影响
- 撤退保留舰损、不产生打捞，未解决遭遇可以稍后再次挑战
- 失能敌舰可作为战后回收机会，以低完整度加入舰队
- 救援信号和低舰数保底为受损舰队提供恢复机会
- 失能舰经过战地维修可重新启用
- 星域改为七层航道、区域主题、多路线和局部星系簇
- 第一星域前两层保证资源、救援和无强制战斗保护
- 星图增加节点图标、区域颜色、主支线和已走路线区分
- 战斗画面提高亮度、饱和度、对比度和背景层次

V0.6 与 V0.7 的功能边界保持冻结；V0.7.1 只修复可玩性、平衡、撤退和视觉可读性，不扩展指挥官、组织或基地系统。

## 技术栈

| 层 | 技术 |
|---|---|
| 战斗模拟层 | 纯 TypeScript，固定 tick 驱动 |
| 战役逻辑层 | 纯 TypeScript reducer 与确定性生成器 |
| 渲染层 | Three.js 0.160 |
| UI 层 | 原生 DOM + CSS |
| 构建 | Vite 5 |
| 测试 | 自研轻量框架 |

## 环境要求

- Node.js ≥ 18
- npm ≥ 9

GitHub Actions 使用 Node.js 24。

## 安装与运行

```bash
npm install
npm run dev
```

## 构建与测试

```bash
npm run build
npm run build:static
npm test
npm run test:det
npm run test:acceptance
npm run test:campaign
npm run test:stress
```

CI 在 push 和 pull request 时执行：

```bash
npm ci
npm run build
npm test
npm run test:det
npm run test:campaign
npm run test:stress
npm run build:static
```

`npm run test:campaign` 同时执行 V0.6、V0.7 和 V0.7.1 战役回归测试。

## 确定性原则

1. 战斗使用固定 30 tick/s。
2. 所有影响结果的随机行为使用 seed 派生 PRNG。
3. 模拟和战役逻辑禁止使用非确定性时间或随机源产生结果。
4. 相同配置、seed 和行动序列必须得到一致结果。
5. 星域、战利品、hazard、敌军、规避和跃迁损伤均由稳定派生输入决定。
6. 自动撤退在固定模拟 tick 后检查；显示帧率和倍速不改变触发状态。
7. 渲染层只消费状态，不能反向修改模拟结果。

## Code 格式

### Replay Code

- 当前版本：`v0.5`
- 规则集：`spacewar-core-v4`
- 用于普通单场战斗回放

战役战斗包含跨战斗继承损伤，暂不支持 seek 或 Replay 分享。

### Fleet Code

- `type: "spacewar-fleet"`
- 描述 fleet、formation 和 doctrine

### Campaign Code

- `type: "spacewar-campaign"`
- 当前版本：`0.2`
- 保存星域结构、资源、货舱、舰队、组件 HP、部署、撤退策略、拖曳、威胁、总结和待处理状态
- 支持导入 V0.6 `0.1` 和较早的 V0.7 `0.2` Campaign Code 并迁移

## 项目目录结构

```text
src/
├── sim/                 # core-v4 战斗模拟、回放和测试
├── campaign/
│   ├── cargo/           # 货舱和物品
│   ├── deployment/      # 战前部署
│   ├── extraction/      # 撤离规划和跃迁结算
│   ├── fleet/           # 持久舰队、战力、遭遇和 Battle Adapter
│   ├── repair/          # 战地维修和重新启用
│   ├── salvage/         # 战后打捞和舰体回收
│   └── sector/          # 分层星域、情报、事件和威胁
├── render/              # Three.js 渲染
└── ui/                  # 单场战斗与战役 UI
```

## 当前版本状态

- **Replay 版本**：v0.5
- **战斗规则集**：spacewar-core-v4
- **战役存档版本**：0.2
- core-v4 与 V0.6 已冻结
- V0.7 持久舰队与搜打撤循环已实现
- V0.7.1 可玩性修正包含独立战役测试套件
- 黄金回放、验收、战役、压力和静态构建由 CI 验证

## 已知限制与暂不实现内容

- 战役战斗暂不支持进度跳转和 Replay 分享
- 敌我战力是用于遭遇缩放和风险提示的启发式数值，不保证单场战斗胜负
- 舰体回收和救援目前使用简化的低完整度入队规则
- 战斗亮度使用统一的可读性预设，尚未提供玩家自定义亮度滑块
- 仅支持一支玩家舰队和占位指挥官
- 没有完整舰员系统、装备随机词条或舰船制造
- 尚未实现指挥官创建与成长、多舰队、基地、科技树、市场、外交、组织和继承政治
- 无后端、账号或联网功能
