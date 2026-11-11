#!/usr/bin/env node

// Prints the monthly dependency review as Markdown: what `npm audit` still reports, and the major
// versions Dependabot leaves for a person to decide on. The Dependency review workflow posts it
// as an issue; docs/development/DEPENDENCIES.md says what to do with it.
const { execSync } = require('node:child_process')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
// Electron fixes security issues in its latest three major versions only.
const ELECTRON_SUPPORTED_MAJORS = 3
// An issue resolves a relative link against the issue, not the repository.
const GUIDE = process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/blob/main/docs/development/DEPENDENCIES.md`
  : 'docs/development/DEPENDENCIES.md'

// npm exits non-zero when it has findings to report, with the JSON still on stdout.
function npmJson(command, cwd) {
  try {
    return JSON.parse(
      execSync(`npm ${command} --json`, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024
      })
    )
  } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout)
    throw error
  }
}

const major = (version) => Number(String(version).split('.')[0])

function advisories(audit) {
  const found = new Map()
  for (const [name, entry] of Object.entries(audit.vulnerabilities ?? {})) {
    for (const via of entry.via) {
      if (typeof via === 'string') continue
      found.set(via.url, { name, severity: via.severity, title: via.title, url: via.url })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function auditSection(title, audit, productionAudit) {
  const all = advisories(audit)
  if (all.length === 0) return [`### ${title}`, '', 'No known vulnerabilities.', '']
  const shipped = new Set(productionAudit ? advisories(productionAudit).map((a) => a.url) : [])
  return [
    `### ${title}`,
    '',
    '| Package | Severity | Ships in the app | Advisory |',
    '| --- | --- | --- | --- |',
    ...all.map(
      (a) =>
        `| \`${a.name}\` | ${a.severity} | ${shipped.has(a.url) ? '**yes**' : 'no'} | [${a.title}](${a.url}) |`
    ),
    ''
  ]
}

function majorsSection(outdated) {
  const waiting = Object.entries(outdated)
    .filter(([, entry]) => entry.current && major(entry.latest) > major(entry.current))
    .sort(([a], [b]) => a.localeCompare(b))
  const lines = ['## Major versions waiting', '']
  if (waiting.length === 0) return [...lines, 'None.', '']

  const electron = outdated.electron
  if (electron?.current) {
    const behind = major(electron.latest) - major(electron.current)
    lines.push(
      behind >= ELECTRON_SUPPORTED_MAJORS
        ? `**Electron ${major(electron.current)} no longer receives security fixes.** Upgrade it before the next release.`
        : `Electron ${major(electron.current)} still receives security fixes, and stops when Electron ${major(electron.current) + ELECTRON_SUPPORTED_MAJORS} is released.`,
      ''
    )
  }
  return [
    ...lines,
    '| Package | Installed | Latest | Used for |',
    '| --- | --- | --- | --- |',
    ...waiting.map(
      ([name, entry]) =>
        // Electron is installed as a development dependency and ships as the app's runtime.
        `| \`${name}\` | ${entry.current} | ${entry.latest} | ${entry.type === 'dependencies' || name === 'electron' ? 'the app' : 'building and testing'} |`
    ),
    ''
  ]
}

function report() {
  const media = join(ROOT, 'media')
  return [
    `Follow the monthly review in the [dependency guide](${GUIDE}), then close this issue.`,
    '',
    '## Known vulnerabilities',
    '',
    ...auditSection('SideKick', npmJson('audit', ROOT), npmJson('audit --omit=dev', ROOT)),
    ...auditSection('README media tooling', npmJson('audit --package-lock-only', media)),
    ...majorsSection(npmJson('outdated --long', ROOT))
  ].join('\n')
}

if (require.main === module) process.stdout.write(`${report()}\n`)
