import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.KEEL_BACKEND_URL ?? 'http://localhost:8787',
    },
  },
})
