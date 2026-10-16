import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // The `sidekick` CLI runs under plain Node (or the app's runtime as Node), never Electron.
        input: { index: resolve('src/main/index.ts'), cli: resolve('src/cli/main.ts') }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          sandbox: resolve('src/renderer/sandbox.html'),
          'artifact-inspect': resolve('src/renderer/artifact-inspect.html')
        }
      }
    }
  }
})
