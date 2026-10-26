import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = process.env.PORT ?? process.env.API_PORT ?? env.PORT ?? env.API_PORT ?? '3001'

  return {
    base: './',
    plugins: [react()],
    server: {
      fs: {
        deny: ['**/permissions.json', '**/requests.json'],
      },
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
    preview: {
      host: '127.0.0.1',
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  }
})
