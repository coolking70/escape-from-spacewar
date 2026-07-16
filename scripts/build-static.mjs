// 构建"单文件"静态站点：把 Vite 产物中的 JS/CSS 内联进 index.html，
// 生成一个零外部依赖、可直接发布的 lightweight 静态站点（位于 static/）。
//
// 用法：node scripts/build-static.mjs
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'static');

// 1) 静态发布显式使用单包模式。标准构建仍可按需加载 Three.js；这里把动态模块
// 合回入口，确保最终 HTML 不依赖额外 chunk。Worker 使用源码中的 inline worker。
await build({
  root,
  base: './',
  outDir: 'dist',
  logLevel: 'info',
  build: {
    // 单文件产物按设计会超过普通分包的 500 kB 提示线；标准 build 仍保留默认阈值。
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: { inlineDynamicImports: true }
    }
  }
});

// 2) 读取 index.html，内联 CSS / JS
let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');

// 去掉 modulepreload（内联后无对应文件，避免 404）
html = html.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, '');

// 内联样式表
let inlinedStylesheets = 0;
html = html.replace(
  /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/,
  (_m, href) => {
    inlinedStylesheets++;
    const css = fs.readFileSync(path.join(distDir, href), 'utf-8');
    return `<style>\n${css}\n</style>`;
  }
);

// 内联模块脚本
let inlinedScripts = 0;
html = html.replace(
  /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*><\/script>/,
  (_m, src) => {
    inlinedScripts++;
    const js = fs.readFileSync(path.join(distDir, src), 'utf-8');
    return `<script type="module">\n${js}\n</script>`;
  }
);

if (inlinedStylesheets !== 1 || inlinedScripts !== 1) {
  throw new Error(`静态构建内联失败：CSS=${inlinedStylesheets}，JS=${inlinedScripts}`);
}
if (/(?:src|href)=["'](?:\.\/|\/)?assets\//.test(html)) {
  throw new Error('静态构建仍包含外部 assets 引用。');
}

// 3) 写出到 static/ 单文件
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);

const kb = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1);
console.log(`✅ 已生成轻量级静态站点：static/index.html (${kb} KB，零外部依赖)`);
console.log('   本地测试：npm run serve:static  →  http://localhost:4173');
