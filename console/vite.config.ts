import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: '/console/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    hmr: {
      // Omit clientPort so the WS uses the page's port (7003, 7021, …).
      // Hardcoding 7003 made any other published port reload against the wrong stack.
      path: '/__hmr',
    },
  },
})
