import { defineConfig } from 'vite';

export default defineConfig({
  // 使用相对路径，构建产物可放在任意子路径/静态托管下直接运行
  base: './',
  // 默认仅监听本机，避免把开发服务器和源码暴露给局域网。
  server: { port: 5173, host: '127.0.0.1' }
});
