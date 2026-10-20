import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // boot.ts picks between the installed app code and a newer downloaded one, then loads index.ts.
    build: {
      rolldownOptions: {
        input: { boot: resolve('src/main/boot.ts'), index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {},
  renderer: {
    // Shown in the title bar. The renderer ships inside the app code, so it's that code's version.
    define: {
      __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
