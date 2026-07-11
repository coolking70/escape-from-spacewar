# SpaceWar 轻量级静态站点（发布/测试用）

本目录是 **单文件、零外部依赖** 的构建产物，便于直接发布或本地测试。

## 目录内容

- `index.html` —— 已内联全部 JS/CSS，**无任何外部资源引用**，打开即用。
- `serve.mjs` —— 零依赖本地静态服务器（仅用 Node 内置模块）。

## 本地测试

```bash
# 方式一：用本项目自带的零依赖服务器
npm run serve:static
# 然后浏览器打开 http://localhost:4173

# 方式二：用任意静态服务器（如 npx serve）
npx serve static
```

也可以直接双击 `index.html` 用浏览器打开（现代浏览器支持内联 module 脚本）。

## 重新生成

```bash
npm run build:static
```

该命令会先执行标准 Vite 构建，再把产物内联成 `static/index.html` 单文件。

## 发布

把整个 `static/` 文件夹上传到任意静态托管即可：

- **GitHub Pages / GitLab Pages**：将 `static/` 内容作为站点根目录。
- **Netlify / Vercel / Cloudflare Pages**：构建命令 `npm run build:static`，发布目录 `static`。
- **对象存储（COS/OSS/S3）**：直接上传 `static/index.html`（单文件）。
- **任意 Web 服务器**：把 `static/` 当作站点根目录。

因为所有资源都已内联，无需担心子路径、base 路径或缺失 `assets/` 的问题。
