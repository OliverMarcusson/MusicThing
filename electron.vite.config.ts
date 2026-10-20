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
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
