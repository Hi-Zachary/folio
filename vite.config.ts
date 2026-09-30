import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/folio/',
  plugins: [react()],
  // AutoDL forwards the public hostname to the local dev server. Vite's
  // default Host allow-list otherwise returns 403 before the app loads.
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
})
