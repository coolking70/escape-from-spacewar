# Escape from SpaceWar · 3D 太空战斗模拟器

确定性自动战斗模拟器，基于 TypeScript + Vite + Three.js。配置双方舰队后自动交战，全程可回放、可分享。

## 当前功能

- **舰队构筑**：3 舰种（Fighter/Frigate/Cruiser）× 4 改型 = 12 种组合，点数预算系统
- **确定性模拟**：相同配置 + 相同 seed = 完全一致的结果（30 tick/s 固定步长）
- **3D 观看**：Three.js 渲染，自动镜头 / 手动拖拽 / 倍速播放 / 进度条跳转
- **录像系统**：Base64url 编码的 Replay Code，可分享给任何人复现同一场战斗
- **舰队库**：保存 / 载入 / 导入 / 导出 / 重命名 / 复制舰队方案
- **战前分析**：双方舰队静态评分对比（不预测确切胜负）
- **平衡实验室**：批量运行 N 场战斗，统计胜率 / 损耗 / 价值守恒
- **战舰图鉴**：3D 预览所有舰种和改型，含数值条和组件详情

## 技术栈

| 层 | 技术 |
|---|---|
| 模拟层 | 纯 TypeScript，零依赖，固定 tick 驱动 |
| 渲染层 | Three.js 0.160 |
| UI 层 | 原生 DOM + CSS，无框架 |
| 构建 | Vite 5 |
| 测试 | 自研轻量框架（runSuite / Case） |

## 环境要求

- Node.js ≥ 18
- npm ≥ 9

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
npm run test:det         # 确定性 + 黄金回放 + 验收测试
npm run test:acceptance  # 18 套件完整验收
npm run test:stress      # 50v50 压力测试（含 Carrier）
```

## 确定性模拟原则

1. 战斗使用固定 30 tick/s 推进，不依赖真实时间。
2. 所有随机行为使用 seed 派生的 PRNG（mulberry32）。
3. 影响战斗结果的逻辑禁止使用 `Math.random`、`Date.now`、`performance.now`。
4. 相同配置和 seed 必须得到完全一致的结果。
5. 渲染层只消费模拟事件，绝不反向修改战斗结果。

## Replay Code 机制

- 格式：JSON → Base64url
- 当前版本：`v0.5`
- 唯一规则集：`spacewar-core-v4`
- 仅接受 v0.5 Replay Code
- Replay Code 与 Fleet Code 类型独立，误粘贴时给出明确提示

## Fleet Code 机制

- 格式：JSON → Base64url，带 `type: "spacewar-fleet"` 标识
- 只描述单支舰队（fleet + formation + doctrine），不含 seed / 对方舰队 / 预算
- 与 Replay Code 完全独立，互不兼容

## 项目目录结构

```
escape-from-spacewar/
├── src/
│   ├── sim/              # 模拟层（纯逻辑，零依赖）
│   │   ├── battleTypes.ts        # 核心类型定义
│   │   ├── battleConfig.ts       # 常量（TICK_MS, MAX_TICKS, SPAWN...）
│   │   ├── rulesets.ts           # 规则集注册与分发
│   │   ├── simulatorV4.ts        # core-v4 模拟器主逻辑
│   │   ├── shipFactory.ts        # 舰船定义与创建
│   │   ├── shipVariants.ts       # 改型定义与 VARIANTS_BY_CLASS
│   │   ├── replayCodec.ts        # Replay Code 编解码
│   │   ├── fleetPreset.ts        # Fleet Code 编解码
│   │   ├── fleetValidator.ts     # 舰队校验
│   │   ├── fleetRepository.ts    # localStorage 持久化
│   │   ├── battleStats.ts        # 战后统计
│   │   ├── balanceRunner.ts      # 批量平衡测试
│   │   ├── timeline.ts           # 战斗时间线聚合
│   │   ├── prng.ts               # 确定性 PRNG
│   │   └── *Tests.ts             # 测试套件
│   ├── render/           # 渲染层（Three.js）
│   └── ui/               # UI 层（原生 DOM）
├── scripts/              # 构建/测试脚本
├── static/               # 静态构建产物
├── .github/workflows/    # CI 配置
└── package.json
```

## 当前规则版本

- **Replay 版本**：v0.5
- **战斗规则集**：spacewar-core-v4（方向命中 / 失能 / 撤退）
- **唯一支持**：Replay v0.5

## 当前开发状态

- core-v4 战斗规则已稳定
- 确定性验证通过（黄金回放 8 例 + 50v50 压力测试）
- 18 套件验收测试全部通过
- GitHub Actions CI 已配置

## 已知限制

- Balance Lab 仅支持 core-v4（无可对比的旧规则集）
- 舰船 3D 模型为程序化生成（无外部模型导入）
- 无后端、无账号、无联网功能

## CI

GitHub Actions 会在 push 和 pull request 时依次执行 `npm ci`、构建、验收测试、压力测试与静态构建。
