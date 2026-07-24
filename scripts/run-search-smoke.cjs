const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const result = spawnSync(
  process.execPath,
  [
    join(__dirname, 'run-vitest.cjs'),
    'src/main/services/sidekickSearch/sidekickSearch.smoke.test.ts'
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, SIDEKICK_SEARCH_SMOKE: '1' }
  }
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
