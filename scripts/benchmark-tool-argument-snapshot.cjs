// Offline synthetic microbenchmark, not agent latency. Builds both revisions in memory.
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve, dirname } = require('node:path')
const Module = require('node:module')
const { performance } = require('node:perf_hooks')
const { buildSync } = require('esbuild')

const file = 'src/main/services/agentToolRegistry.ts'
const baseline = process.argv[2] || '67b7d402eec7028504af532dd01c59daab7082ff'
function compile(source, label) {
  const result = buildSync({
    stdin: { contents: source, resolveDir: dirname(resolve(file)), loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false
  })
  const compiled = new Module(resolve(`synthetic-snapshot-${label}.cjs`), module)
  compiled.filename = resolve(`synthetic-snapshot-${label}.cjs`)
  compiled.paths = module.paths
  compiled._compile(result.outputFiles[0].text, compiled.filename)
  return compiled.exports.prepareAgentToolCall
}
const before = compile(
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }),
  'before'
)
const after = compile(readFileSync(file, 'utf8'), 'after')
const catalog = {
  surface: 'conversation',
  browserEnabled: true,
  workspaceRoot: '/synthetic-project'
}
function measure(prepare, call, iterations) {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) prepare(catalog, call)
  return (performance.now() - start) / iterations
}
const reports = []
for (const [label, count, valueLength, iterations] of [
  ['small', 3, 32, 2000],
  ['one_mib', 128, 8192, 100]
]) {
  const args = {
    fields: Array.from({ length: count }, () => ({
      kind: 'textbox',
      ref: 'synthetic',
      value: 'x'.repeat(valueLength)
    }))
  }
  const call = { id: 'synthetic', name: 'browser_fill_form', arguments: args }
  measure(before, call, 50)
  measure(after, call, 50)
  const beforeSamples = [],
    afterSamples = []
  for (let round = 0; round < 5; round++) {
    beforeSamples.push(measure(before, call, iterations))
    afterSamples.push(measure(after, call, iterations))
  }
  const median = (samples) => samples.sort((a, b) => a - b)[2]
  const beforeMs = median(beforeSamples),
    afterMs = median(afterSamples)
  reports.push({
    label,
    jsonBytes: Buffer.byteLength(JSON.stringify(args)),
    iterationsPerRound: iterations,
    rounds: 5,
    baselineMedianMsPerPreparation: beforeMs,
    snapshotMedianMsPerPreparation: afterMs,
    addedMedianMsPerPreparation: afterMs - beforeMs
  })
}
console.log(
  JSON.stringify(
    { scope: 'synthetic-preparation-microbenchmark-not-agent-latency', baseline, reports },
    null,
    2
  )
)
