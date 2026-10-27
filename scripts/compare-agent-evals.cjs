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

// Cases whose result differs between reports, such as the same replay cases on two branches.
// Trials of a case (`case#1`, `case#2`) count together.
const caseResults = reports.map(({ report }) => {
  const cases = new Map()
  for (const metric of report.metrics || []) {
    const name = String(metric.name).replace(/#\d+$/, '')
    const counts = cases.get(name) || { passed: 0, total: 0 }
    counts.total++
    if (metric.passed) counts.passed++
    cases.set(name, counts)
  }
  return cases
})
const changed = [...new Set(caseResults.flatMap((cases) => [...cases.keys()]))]
  .sort()
  .filter(
    (name) => new Set(caseResults.map((cases) => JSON.stringify(cases.get(name) ?? null))).size > 1
  )
if (changed.length) {
  const revisions = reports.map(({ report }) => (report.runtime?.revision || 'local').slice(0, 16))
  lines.push('', '## Cases that differ', '')
  lines.push(
    `| Case | ${revisions.join(' | ')} |`,
    `| --- | ${revisions.map(() => '---:').join(' | ')} |`
  )
  for (const name of changed) {
    const cells = caseResults.map((cases) => {
      const counts = cases.get(name)
      return counts ? `${counts.passed}/${counts.total}` : '–'
    })
    lines.push(`| ${name} | ${cells.join(' | ')} |`)
  }
}

process.stdout.write(`${lines.join('\n')}\n`)
