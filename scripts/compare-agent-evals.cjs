const { readFileSync } = require('node:fs')
const { basename, resolve } = require('node:path')

const paths = process.argv.slice(2)
if (!paths.length) {
  console.error('Usage: npm run benchmark:agent-evals -- <report.json> [more-report.json ...]')
  process.exit(1)
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toolRounds(report) {
  const rounds = (report.metrics || [])
    .map((metric) => metric.details?.toolRounds)
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
  return rounds.length ? rounds.reduce((total, value) => total + value, 0) : 0
}

const reports = paths.map((path) => {
  const absolutePath = resolve(path)
  const report = JSON.parse(readFileSync(absolutePath, 'utf8'))
  if (report.schemaVersion !== 3 || !report.summary) {
    throw new Error(`${basename(path)} is not a SideKick agent-eval schema v3 report`)
  }
  return { path: absolutePath, report }
})

reports.sort(
  (left, right) =>
    finite(right.report.summary.score) - finite(left.report.summary.score) ||
    finite(left.report.summary.p95LatencyMs) - finite(right.report.summary.p95LatencyMs)
)

const lines = [
  '# SideKick agent benchmark',
  '',
  '| Rank | Provider | Model | Suite | Score | Scenarios | Median | P95 | Tool rounds | Revision |',
  '| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |'
]

reports.forEach(({ report }, index) => {
  const summary = report.summary
  lines.push(
    `| ${index + 1} | ${report.providerKind} | ${report.model} | ${report.suite} | ${finite(summary.score).toFixed(1)}/${finite(summary.maxPoints).toFixed(0)} | ${summary.passedCases}/${summary.totalCases} | ${finite(summary.medianLatencyMs).toFixed(0)} ms | ${finite(summary.p95LatencyMs).toFixed(0)} ms | ${toolRounds(report)} | ${(report.runtime?.revision || 'local').slice(0, 8)} |`
  )
})

lines.push('', '## Category scores', '')
for (const { report } of reports) {
  const categories = Object.entries(report.summary.byCategory || {})
    .map(([name, value]) => `${name} ${finite(value.score).toFixed(0)}`)
    .join(' · ')
  lines.push(`- ${report.providerKind}/${report.model}: ${categories}`)
}

process.stdout.write(`${lines.join('\n')}\n`)
