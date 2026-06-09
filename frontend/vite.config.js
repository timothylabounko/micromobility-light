import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/city': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
      },
      // More specific path first — `/api/overpass` is a prefix of `/api/overpass-alt`
      '/api/overpass-alt': {
        target: 'https://overpass.kumi.systems',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
        timeout: 180000,
        proxyTimeout: 180000,
      },
      '/api/overpass-fr': {
        target: 'https://overpass.openstreetmap.fr',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
        timeout: 180000,
        proxyTimeout: 180000,
      },
      '/api/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: () => '/api/interpreter',
        timeout: 180000,
        proxyTimeout: 180000,
      },
    },
  },
})
