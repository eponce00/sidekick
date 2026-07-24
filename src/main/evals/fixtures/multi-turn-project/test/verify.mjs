import { readFileSync } from 'node:fs'

const report = readFileSync(new URL('../src/report.ts', import.meta.url), 'utf8')
const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
const catalog = readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8')
const expected = /expectedSubtotal\s*=\s*(\d+)/.exec(config)?.[1]

if (!expected) throw new Error('expectedSubtotal is missing')
if (!report.includes(`subtotal = ${expected}`))
  throw new Error(`report subtotal is not ${expected}`)
if (!report.includes("currency = 'USD'")) throw new Error('report currency is not USD')
if (!catalog.includes("id: 'alpha'") || !catalog.includes("id: 'beta'")) {
  throw new Error('base catalog products are missing')
}

console.log('SIDEKICK_PROJECT_VERIFY_OK')
