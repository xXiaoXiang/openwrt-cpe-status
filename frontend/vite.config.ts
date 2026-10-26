import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: './', plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }, dedupe: ['react', 'react-dom'] },
  define: { __APP_VERSION__: JSON.stringify('0.4.0'), __GIT_BRANCH__: JSON.stringify('openwrt'), __GIT_COMMIT__: JSON.stringify('development') },
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:4780' } } },
  build: { target: 'es2020', outDir: '../build/www', emptyOutDir: true, reportCompressedSize: false },
})
