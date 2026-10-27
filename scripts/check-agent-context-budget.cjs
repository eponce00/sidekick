#!/usr/bin/env node

// Compares two agent context budgets (src/shared/agentContextBudget.json) and fails when any
// number grew: a longer system prompt, a larger tool schema, or a new tool. Usage:
//   node scripts/check-agent-context-budget.cjs <base.json> <head.json>
// A missing base file passes, so the first pull request that adds the budget is not refused.

const fs = require('node:fs')

function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'number') out.set(name, child)
    else if (child && typeof child === 'object') flatten(child, name, out)
  }
  return out
}

function compare(base, head) {
  const before = flatten(base)
  const after = flatten(head)
  const grown = []
  const shrunk = []
  for (const [name, value] of after) {
    const previous = before.get(name) ?? 0
    if (value > previous) grown.push({ name, previous, value })
    else if (value < previous) shrunk.push({ name, previous, value })
  }
  for (const [name, previous] of before) {
    if (!after.has(name)) shrunk.push({ name, previous, value: 0 })
  }
  return { grown, shrunk }
}

function main([basePath, headPath]) {
  if (!basePath || !headPath) {
    console.error('Usage: check-agent-context-budget.cjs <base.json> <head.json>')
    return 2
  }
  if (!fs.existsSync(basePath)) {
    console.log(`No base budget at ${basePath}; nothing to compare.`)
    return 0
  }
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  const { grown, shrunk } = compare(read(basePath), read(headPath))
  const line = ({ name, previous, value }) =>
    `  ${name}: ${previous} -> ${value} (${value - previous > 0 ? '+' : ''}${value - previous})`
  if (shrunk.length) console.log(`Smaller:\n${shrunk.map(line).join('\n')}`)
  if (!grown.length) {
    console.log('No part of the per-turn agent context grew.')
    return 0
  }
  console.error(`Larger:\n${grown.map(line).join('\n')}`)
  console.error(
    'The per-turn agent context grew. Make the text shorter, or add the agent-context-increase label to the pull request when the growth is worth it, then re-run this job.'
  )
  return 1
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { compare }
