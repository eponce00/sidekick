import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Generated artifacts and private user workspaces are never test inputs.
    // A positive source boundary also excludes future output directory names.
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)']
  }
})
