// Audits a SideKick database's run journals; see src/main/diagnostics/runAudit.ts.
// Bundled and run under Electron's Node by scripts/audit-runs.cjs.
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { auditRuns, formatRunAudit, type RunAuditOptions } from '../src/main/diagnostics/runAudit'

const USAGE = `Usage: npm run audit:runs -- [database | --profile installed|dev] [options]

  --since-days N            only runs started in the last N days
  --min-compaction-share X  flag compactions below this share of the window (0.6)
  --max-quiet-minutes N     flag working runs silent this long (10)
  --json                    print the findings as JSON`

function profileDatabase(profile: string): string {
  const name = profile === 'dev' ? 'sidekick-dev' : 'sidekick'
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  return join(base, name, 'conversations.db')
}

function main(argv: string[]): number {
  const options: RunAuditOptions = {}
  let path: string | undefined
  let json = false
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const value = (): number => {
      const parsed = Number(argv[++index])
      if (!Number.isFinite(parsed)) throw new Error(`${argument} needs a number`)
      return parsed
    }
    if (argument === '--help' || argument === '-h') {
      console.log(USAGE)
      return 0
    } else if (argument === '--profile') path = profileDatabase(argv[++index] ?? '')
    else if (argument === '--since-days') options.since = Date.now() - value() * 86_400_000
    else if (argument === '--min-compaction-share') options.minCompactionShare = value()
    else if (argument === '--max-quiet-minutes') options.maxQuietMinutes = value()
    else if (argument === '--json') json = true
    else if (!argument.startsWith('--')) path = argument
    else throw new Error(`Unknown option ${argument}\n\n${USAGE}`)
  }
  path ??= profileDatabase('installed')
  if (!existsSync(path)) throw new Error(`No database at ${path}`)
  // Read-only: the audit never changes a profile, even one an app has open.
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const audit = auditRuns(db, options)
    console.log(json ? JSON.stringify(audit, null, 2) : `${path}\n\n${formatRunAudit(audit)}`)
    return audit.findings.some((finding) => finding.severity === 'flag') ? 1 : 0
  } finally {
    db.close()
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 2
}
