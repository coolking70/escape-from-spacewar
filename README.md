# Escape from SpaceWar · 3D 太空战斗与星域战役原型

基于 TypeScript、Vite 和 Three.js 的确定性太空战斗模拟器，并包含可玩的星域 Roguelike 战役。

单场战斗层使用固定 tick 和 seed 驱动；战役层在此基础上提供随机星域探索、资源管理、持久舰损、打捞维修、战前部署和星门撤离决策。

## 当前功能

### core-v4 单场战斗

- **舰队构筑**：3 舰种（Fighter/Frigate/Cruiser）× 4 改型，共 12 种合法组合
- **确定性模拟**：相同配置与 seed 得到一致结果（30 tick/s）
- **3D 观看**：Three.js 渲染、自动镜头、暂停和倍速
- **录像系统**：Replay Code 可复现普通单场战斗
- **舰队库、战前分析、平衡实验室和战舰图鉴**

### V0.6 星域基础切片

- 确定性生成 20～30 个星域节点
- 战争迷雾、扫描、移动、资源、信号、hazard 与威胁
- 复用 core-v4 的 3D 战役战斗
- 稳定 `campaignShipId ↔ battleShipId` 映射和组件 HP 继承
- 隐藏星门、跨星域撤离和第三星域胜利

### V0.7 持久舰队与搜打撤循环

- Campaign 存档格式 `0.2`，自动迁移 V0.6 `0.1` 存档
- 有容量和重量限制的货舱
- 补给箱、燃料电池、维修零件和高价值遗物
- 战后快速搜刮、完整打捞或立即离开
- 战地维修和组件损伤管理
- 失能舰船拖曳、拆解或永久放弃
- 拖曳增加移动和跃迁燃料成本
- 战前选择本场参战舰，未部署舰船留守
- 星门撤离规划显示燃料、安全载荷、风险分数和影响因素
- 跃迁准备可降低风险
- 主动抛弃货物以解除超载
- 普通跃迁拒绝不安全载荷
- 紧急跃迁会确定性自动抛货并可能造成组件损伤
- 星域结算记录探索、回合、舰队、货舱、风险和跃迁损伤
- 舰船、组件 HP、失能/拖曳状态、货物和历史跨星域保留

V0.6 已冻结；V0.7 功能范围完成后只接受明确回归修复。

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

## 确定性原则

1. 战斗使用固定 30 tick/s。
2. 所有影响结果的随机行为使用 seed 派生 PRNG。
3. 模拟和战役逻辑禁止使用非确定性时间或随机源产生结果。
4. 相同配置、seed 和行动序列必须得到一致结果。
5. 战利品、hazard、敌军、跃迁损伤和自动抛货均由稳定派生输入决定。
6. 渲染层只消费状态，不能反向修改模拟结果。

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
- 保存星域、资源、货舱、舰队、组件 HP、部署、拖曳、威胁、总结和待处理状态
- 支持导入 V0.6 `0.1` Campaign Code 并迁移

## 项目目录结构

```text
src/
├── sim/                 # core-v4 战斗模拟、回放和测试
├── campaign/
│   ├── cargo/           # 货舱和物品
│   ├── deployment/      # 战前部署
│   ├── extraction/      # 撤离规划和跃迁结算
│   ├── fleet/           # 持久舰队与 Battle Adapter
│   ├── repair/          # 战地维修
│   ├── salvage/         # 战后打捞
│   └── sector/          # 星域、情报、事件和威胁
├── render/              # Three.js 渲染
└── ui/                  # 单场战斗与战役 UI
```

## 当前版本状态

- **Replay 版本**：v0.5
- **战斗规则集**：spacewar-core-v4
- **战役存档版本**：0.2
- core-v4 与 V0.6 已冻结
- V0.7 持久舰队、打捞维修、部署和撤离循环已实现
- 黄金回放、19 套件验收、V0.6/V0.7 战役测试、压力测试和静态构建由 CI 验证

## 已知限制与暂不实现内容

- 战役战斗暂不支持进度跳转和 Replay 分享
- 仅支持一支玩家舰队和占位指挥官
- 没有完整舰员系统、装备随机词条或舰船制造
- 尚未实现指挥官创建与成长、多舰队、基地、科技树、市场、外交、组织和继承政治
- 无后端、账号或联网功能
