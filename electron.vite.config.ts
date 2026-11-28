import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Vite only inlines *literal* `process.env.VITE_*` reads. Computed access such
  // as `process.env['VITE_SUPABASE_URL']` survives into the bundle as a runtime
  // lookup, which is always undefined in a packaged app. Bake the two public
  // (publishable) Supabase values into the main/preload bundles explicitly.
  const env = loadEnv(mode, process.cwd(), '')
  const supabaseUrl = env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? ''
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? ''
  const define = {
    'process.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
    'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey)
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: { '@shared': resolve('src/shared') } },
      define
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias: { '@shared': resolve('src/shared') } },
      define
    },
    renderer: {
      resolve: {
        alias: {
          '@': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      plugins: [react()],
      build: { chunkSizeWarningLimit: 3000 }
    }
  }
})
