import { readFileSync } from 'node:fs'

const status = readFileSync(new URL('../src/status.ts', import.meta.url), 'utf8')

if (!status.includes("status = 'after'")) throw new Error('status was not updated')

console.log('SIDEKICK_VERIFICATION_GUARD_OK')
