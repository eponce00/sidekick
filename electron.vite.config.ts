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
  preload: {
    build: {
      rollupOptions: {
        // The annotation overlay gets a preload of its own, with nothing but its two calls.
        input: {
          index: resolve('src/preload/index.ts'),
          annotationOverlay: resolve('src/preload/annotationOverlay.ts')
        }
      }
    }
  },
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
          'html-sandbox': resolve('src/renderer/html-sandbox.html'),
          'artifact-inspect': resolve('src/renderer/artifact-inspect.html'),
          // The page SideKick serves to paired phones on the local network.
          companion: resolve('src/renderer/companion.html'),
          // SideKick's own page over a live web page while the user marks it.
          'annotation-overlay': resolve('src/renderer/annotation-overlay.html')
        }
      }
    }
  }
})
