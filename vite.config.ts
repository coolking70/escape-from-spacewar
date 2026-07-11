import { defineConfig } from 'vite';

export default defineConfig({
  // 使用相对路径，构建产物可放在任意子路径/静态托管下直接运行
  base: './',
  server: { port: 5173, host: true }
});
