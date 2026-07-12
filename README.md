# Escape from SpaceWar · 3D 太空战斗与星域战役原型

基于 TypeScript、Vite 和 Three.js 的确定性太空战斗模拟器，并包含可玩的 V0.6 星域 Roguelike 战役垂直切片。

单场战斗层使用固定 tick 和 seed 驱动；战役层在此基础上提供随机星域探索、资源管理、威胁增长、事件、舰损继承与星门撤离。

## 当前功能

### core-v4 单场战斗

- **舰队构筑**：3 舰种（Fighter/Frigate/Cruiser）× 4 改型，共 12 种合法组合，支持点数预算
- **确定性模拟**：相同配置与相同 seed 得到一致结果（30 tick/s 固定步长）
- **3D 观看**：Three.js 渲染，自动镜头、手动拖拽、暂停和倍速播放
- **录像系统**：Base64url 编码 Replay Code，可复现同一场普通战斗
- **舰队库**：保存、载入、导入、导出、重命名和复制舰队方案
- **战前分析**：双方舰队静态评分对比，不预测确定胜负
- **平衡实验室**：批量运行战斗，统计胜率、损耗和价值守恒
- **战舰图鉴**：3D 预览舰种与改型，展示数值和组件信息

### V0.6 星域战役切片

- 使用 campaign seed 确定性生成 20～30 个星域节点
- 战争迷雾与 detected、scanned、visited 多级情报状态
- 节点移动、扫描、资源采集、特殊信号和 hazard
- 随行动提升的星域威胁，以及巡逻战斗和星门守卫
- 战役战斗复用现有 core-v4 和 Three.js 战斗界面
- 稳定的 `campaignShipId ↔ battleShipId` 映射
- 舰船摧毁、失能、逃脱和组件 HP 跨战斗写回
- 隐藏星门、跨星域撤离和第三星域胜利条件
- Campaign Code 与 localStorage 自动保存
- 深层战役存档校验和 Node 端确定性测试

V0.6 已完成最终验收并冻结。除明确回归缺陷外，不再扩展其规则范围。

## 技术栈

| 层 | 技术 |
|---|---|
| 战斗模拟层 | 纯 TypeScript，固定 tick 驱动 |
| 战役逻辑层 | 纯 TypeScript reducer 与确定性生成器 |
| 渲染层 | Three.js 0.160 |
| UI 层 | 原生 DOM + CSS，无框架 |
| 构建 | Vite 5 |
| 测试 | 自研轻量框架（runSuite / Case） |

## 环境要求

- Node.js ≥ 18
- npm ≥ 9

GitHub Actions 当前使用 Node.js 24。

## 安装与运行

```bash
npm install
npm run dev          # 开发服务器
```

## 构建命令

```bash
npm run build        # TypeScript 编译 + Vite 构建
npm run build:static # 静态单文件构建（可离线部署）
```

## 测试命令

```bash
npm test                 # 完整验收测试（= test:acceptance）
npm run test:det         # 独立确定性自检 + 黄金回放 + 验收测试
npm run test:acceptance  # 19 套件完整验收
npm run test:campaign    # V0.6 星域战役确定性与回归测试
npm run test:stress      # 50v50 压力测试（含 Carrier）
```

## 确定性原则

1. 战斗使用固定 30 tick/s 推进，不依赖真实时间。
2. 所有影响结果的随机行为使用 seed 派生 PRNG。
3. 模拟和战役逻辑禁止使用 `Math.random`、`Date.now` 或 `performance.now` 产生结果。
4. 相同配置、seed 和行动序列必须得到一致结果。
5. 渲染层只消费模拟状态和事件，不能反向修改结果。
6. 战役地图、节点内容、事件、战利品预留和战斗 seed 使用独立派生路径。

## Code 格式

### Replay Code

- JSON → Base64url
- 当前版本：`v0.5`
- 唯一规则集：`spacewar-core-v4`
- 用于普通单场战斗回放

战役战斗包含跨战斗继承损伤，V0.6 暂不支持战役战斗 seek 或 Replay 分享。

### Fleet Code

- 带 `type: "spacewar-fleet"` 标识
- 描述一支舰队的 fleet、formation 和 doctrine
- 不包含 seed、对手或预算

### Campaign Code

- 带 `type: "spacewar-campaign"` 标识
- 当前战役格式版本：`0.1`
- 保存星域、资源、舰队、组件 HP、威胁、历史和待处理战斗

Replay Code、Fleet Code 与 Campaign Code 相互独立，误粘贴时会显示对应类型错误。

## 项目目录结构

```text
escape-from-spacewar/
├── src/
│   ├── sim/               # core-v4 战斗模拟、回放、舰队与测试
│   ├── campaign/          # 星域、战役状态、持久舰队、保存与测试
│   │   ├── fleet/         # 战役舰船和 core-v4 Battle Adapter
│   │   └── sector/        # 节点生成、情报、事件、威胁和行动
│   ├── render/            # Three.js 渲染层
│   └── ui/                # 单场战斗与战役 UI
├── scripts/               # 构建和 Node 测试入口
├── static/                # 静态构建产物
├── .github/workflows/     # Node 24 CI
└── package.json
```

## 当前版本状态

- **Replay 版本**：v0.5
- **战斗规则集**：spacewar-core-v4
- **战役存档版本**：0.1
- core-v4 战斗规则已冻结
- V0.6 星域战役垂直切片已冻结
- 黄金回放、19 套件验收、战役测试、50v50 压力测试和静态构建全部通过
- GitHub Actions 在 push 和 pull request 时运行完整验证

## 下一阶段：V0.7

V0.7 聚焦持久舰队与完整搜打撤损失循环：

- 有容量限制的货舱和战利品
- 战后打捞选择
- 战地维修与组件损伤管理
- 失能舰船的拖曳、拆解或放弃
- 战前参战名单
- 星门撤离规划、超载处理和跃迁风险
- 星域结算与跨星域持续状态

## 已知限制与暂不实现内容

- 战役战斗暂不支持进度跳转和 Replay 分享
- Balance Lab 仅支持 core-v4
- 舰船 3D 模型为程序化生成，无外部模型导入
- 无后端、账号或联网功能
- 尚未实现维修、战利品货舱、指挥官成长、多舰队、基地、科技树、市场、外交和组织系统
