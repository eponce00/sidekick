import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'fs'
import { relative, resolve } from 'path'
import type { ToolDiagnostic, ToolWorkspaceChange } from '../../shared/agentRuntime'
import type { ShellCommandResult } from '../../shared/types'
import type {
  VerificationCheckSuggestion,
  VerificationEvidence,
  VerificationKind,
  VerificationScope,
  VerificationTerminalDecision,
  WorkspaceChangeRecord,
  WorkspaceVerificationSummary
} from '../../shared/verification'

interface EvidenceRow {
  id: string
  run_id: string
  workspace_root: string
  revision: number
  kind: VerificationKind
  scope: VerificationScope
  source: VerificationEvidence['source']
  status: VerificationEvidence['status']
  command: string | null
  cwd: string | null
  exit_code: number | null
  summary: string
  changed_paths_json: string
  fingerprint: string | null
  diagnostics_json: string | null
  started_at: number
  completed_at: number
}

export interface VerificationCommandClassification {
  kind?: VerificationKind
  scope: VerificationScope
  mutatesWorkspace: boolean
}

export interface WorkspaceCommandSnapshot {
  entries: Map<string, string>
  complete: boolean
}

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.cache',
  '.next',
  '.nuxt',
  '.vite',
  'coverage'
])
const MAX_SNAPSHOT_FILES = 25_000

const READ_ONLY_COMMANDS = [
  /^\s*(?:pwd|ls|dir|find|fd|rg|grep|cat|head|tail|sed\s+-n|wc|stat|file|which|where|type)\b/i,
  /^\s*git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)\b/i,
  /^\s*(?:node|python\d*|ruby|php|go|rustc|java|dotnet|swift|cargo|npm|pnpm|yarn|bun)\s+--version\b/i
]

const VERIFY_PATTERNS: Array<[VerificationKind, RegExp]> = [
  [
    'test',
    /(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|mocha|rspec|phpunit)\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bswift\s+test\b|\b(?:mvn|mvnw)\b[^;&|]*\btest\b|\bgradle\w*\b[^;&|]*\btest\b/i
  ],
  [
    'typecheck',
    /\b(?:tsc|vue-tsc|mypy|pyright|basedpyright)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check:types)\b/i
  ],
  [
    'lint',
    /\b(?:eslint|biome|ruff|pylint|flake8|golangci-lint|rubocop|phpstan|stylelint|clippy)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i
  ],
  [
    'build',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bcargo\s+build\b|\bgo\s+build\b|\bdotnet\s+build\b|\bswift\s+build\b|\b(?:mvn|mvnw)\b[^;&|]*\bpackage\b|\bgradle\w*\b[^;&|]*\bbuild\b/i
  ],
  ['check', /\bcargo\s+check\b|\bgo\s+vet\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check\b/i]
]

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function evidenceFromRow(row: EvidenceRow): VerificationEvidence {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceRoot: row.workspace_root,
    revision: row.revision,
    kind: row.kind,
    scope: row.scope,
    source: row.source,
    status: row.status,
    command: row.command ?? undefined,
    cwd: row.cwd ?? undefined,
    exitCode: row.exit_code ?? undefined,
    summary: row.summary,
    changedPaths: parseJson(row.changed_paths_json, []),
    fingerprint: row.fingerprint ?? undefined,
    diagnostics: parseJson<ToolDiagnostic[] | undefined>(row.diagnostics_json, undefined),
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

function normalizedRelativePath(root: string, path: string): string | null {
  const absolute = resolve(root, path)
  const result = relative(resolve(root), absolute).replaceAll('\\', '/')
  return result && !result.startsWith('../') && result !== '..'
    ? result
    : result === ''
      ? '.'
      : null
}

function commandSummary(kind: VerificationKind, result: ShellCommandResult): string {
  const label =
    kind === 'typecheck'
      ? 'Typecheck'
      : kind === 'test'
        ? 'Tests'
        : kind[0].toUpperCase() + kind.slice(1)
  if (result.cancelled) return `${label} was cancelled.`
  if (result.success) {
    const output = `${result.stdout}\n${result.stderr}`
    const count =
      /\bTests?\s+(\d+)\s+passed\b/i.exec(output)?.[1] ||
      /\b(\d+)\s+(?:tests?\s+)?passed\b/i.exec(output)?.[1]
    return `${label} passed${count ? ` (${count} passed)` : ''}.`
  }
  const launchError = result.error?.trim()
  if (launchError && /\b(?:spawn|ENOENT|EACCES|EPERM)\b/i.test(launchError)) {
    return `Command could not start: ${launchError.slice(0, 240)}.`
  }
  const detail = `${result.stderr}\n${result.stdout}\n${result.error || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) =>
        line &&
        line !== '#< CLIXML' &&
        !line.startsWith('<Objs ') &&
        !/^={3,}/.test(line)
    )
  return `${label} failed${detail ? `: ${detail.slice(0, 240)}` : ` with exit code ${result.exitCode}`}.`
}

function snapshotWorkspace(workspaceRoot: string): WorkspaceCommandSnapshot {
  const root = resolve(workspaceRoot)
  const entries = new Map<string, string>()
  let complete = true
  const visit = (directory: string): void => {
    if (!complete) return
    let children
    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch {
      complete = false
      return
    }
    for (const child of children) {
      if (entries.size >= MAX_SNAPSHOT_FILES) {
        complete = false
        return
      }
      if (child.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(child.name)) continue
      const absolute = resolve(directory, child.name)
      const path = relative(root, absolute).replaceAll('\\', '/')
      try {
        const stat = child.isSymbolicLink() ? lstatSync(absolute) : statSync(absolute)
        if (child.isDirectory()) visit(absolute)
        else entries.set(path, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`)
      } catch {
        complete = false
      }
    }
  }
  visit(root)
  return { entries, complete }
}

function workspaceChanges(
  before: WorkspaceCommandSnapshot,
  after: WorkspaceCommandSnapshot
): ToolWorkspaceChange[] {
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()])
  const changes: ToolWorkspaceChange[] = []
  for (const path of paths) {
    const previous = before.entries.get(path)
    const current = after.entries.get(path)
    if (previous === current) continue
    changes.push({
      path,
      kind: previous === undefined ? 'create' : current === undefined ? 'delete' : 'update'
    })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

function packageManager(root: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  if (existsSync(resolve(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(resolve(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(resolve(root, 'bun.lock')) || existsSync(resolve(root, 'bun.lockb'))) return 'bun'
  return 'npm'
}

export function classifyVerificationCommand(command: string): VerificationCommandClassification {
  const kind = VERIFY_PATTERNS.find(([, pattern]) => pattern.test(command))?.[0]
  const onlyRead = READ_ONLY_COMMANDS.some((pattern) => pattern.test(command))
  const explicitMutation =
    /(?:^|[;&|]\s*|\s)(?:rm|mv|cp|mkdir|touch|install|patch|tee|truncate)\b|(?:^|[^<])>{1,2}\s*[^&]|\bsed\s+-i\b|\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|update)\b|\b(?:pip|uv|poetry|gem|composer)\s+(?:install|add|remove|update)\b/i.test(
      command
    )
  return {
    kind,
    scope:
      /(?:^|\s)(?:\.\/|src\/|test\/|tests\/|[^\s]+\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|rb|php|swift))(?:\s|$)/i.test(
        command
      )
        ? 'targeted'
        : 'workspace',
    // Verification commands frequently create ignored caches/build output. Those do not invalidate
    // source evidence. Compound commands with an explicit mutation do.
    mutatesWorkspace: explicitMutation || (!kind && !onlyRead)
  }
}

export class WorkspaceVerificationService {
  constructor(private readonly db: Database.Database) {}

  currentRevision(workspaceRoot: string): number {
    const row = this.db
      .prepare('SELECT revision FROM workspace_verification_state WHERE workspace_root = ?')
      .get(resolve(workspaceRoot)) as { revision: number } | undefined
    return row?.revision ?? 0
  }

  beginSession(workspaceRoot?: string): number {
    return workspaceRoot ? this.currentRevision(workspaceRoot) : 0
  }

  captureCommandWorkspace(
    workspaceRoot: string,
    command: string
  ): WorkspaceCommandSnapshot | undefined {
    return classifyVerificationCommand(command).mutatesWorkspace
      ? snapshotWorkspace(workspaceRoot)
      : undefined
  }

  recordChanges(
    runId: string,
    workspaceRoot: string,
    source: WorkspaceChangeRecord['source'],
    changes: ToolWorkspaceChange[]
  ): number {
    if (!changes.length) return this.currentRevision(workspaceRoot)
    const root = resolve(workspaceRoot)
    const now = Date.now()
    return this.db.transaction(() => {
      const revision = this.currentRevision(root) + 1
      this.db
        .prepare(
          `INSERT INTO workspace_verification_state (workspace_root, revision, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_root) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`
        )
        .run(root, revision, now)
      this.db
        .prepare(
          `INSERT INTO workspace_change_events
           (id, run_id, workspace_root, revision, source, changes_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), runId, root, revision, source, JSON.stringify(changes), now)
      this.db
        .prepare(
          `DELETE FROM workspace_change_events WHERE id IN (
             SELECT id FROM workspace_change_events WHERE workspace_root = ?
             ORDER BY revision DESC, created_at DESC LIMIT -1 OFFSET 5000
           )`
        )
        .run(root)
      return revision
    })()
  }

  recordCommand(
    runId: string,
    workspaceRoot: string,
    command: string,
    cwd: string | undefined,
    result: ShellCommandResult,
    startedAt: number,
    before?: WorkspaceCommandSnapshot
  ): VerificationEvidence | null {
    const classification = classifyVerificationCommand(command)
    const root = resolve(workspaceRoot)
    if (classification.mutatesWorkspace) {
      const changes = before
        ? workspaceChanges(before, snapshotWorkspace(root))
        : [{ path: '*', kind: 'update' as const }]
      if (changes.length) this.recordChanges(runId, root, 'command', changes)
    }
    if (!classification.kind) return null
    const changedPaths = this.changedPaths(runId, root, 0)
    return this.recordEvidence({
      id: randomUUID(),
      runId,
      workspaceRoot: root,
      revision: this.currentRevision(root),
      kind: classification.kind,
      scope: classification.scope,
      source: 'command',
      status: result.cancelled ? 'cancelled' : result.success ? 'passed' : 'failed',
      command,
      cwd,
      exitCode: result.exitCode,
      summary: commandSummary(classification.kind, result),
      changedPaths,
      fingerprint: this.fingerprint(root, changedPaths),
      startedAt,
      completedAt: Date.now()
    })
  }

  recordDiagnostics(
    runId: string,
    workspaceRoot: string,
    diagnostics: ToolDiagnostic[],
    changedPaths: string[],
    source = 'Language diagnostics'
  ): VerificationEvidence {
    const errors = diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error' && diagnostic.state !== 'resolved'
    )
    const now = Date.now()
    return this.recordEvidence({
      id: randomUUID(),
      runId,
      workspaceRoot: resolve(workspaceRoot),
      revision: this.currentRevision(workspaceRoot),
      kind: 'diagnostics',
      scope: changedPaths.length === 1 ? 'targeted' : 'workspace',
      source: 'lsp',
      status: errors.length ? 'failed' : 'passed',
      summary: errors.length
        ? `${source} found ${errors.length} error${errors.length === 1 ? '' : 's'}.`
        : `${source} found no errors in the changed files.`,
      changedPaths,
      fingerprint: this.fingerprint(workspaceRoot, changedPaths),
      diagnostics,
      startedAt: now,
      completedAt: now
    })
  }

  private recordEvidence(evidence: VerificationEvidence): VerificationEvidence {
    this.db
      .prepare(
        `INSERT INTO workspace_verification_events
         (id, run_id, workspace_root, revision, kind, scope, source, status, command, cwd,
          exit_code, summary, changed_paths_json, fingerprint, diagnostics_json, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidence.id,
        evidence.runId,
        resolve(evidence.workspaceRoot),
        evidence.revision,
        evidence.kind,
        evidence.scope,
        evidence.source,
        evidence.status,
        evidence.command ?? null,
        evidence.cwd ?? null,
        evidence.exitCode ?? null,
        evidence.summary,
        JSON.stringify(evidence.changedPaths),
        evidence.fingerprint ?? null,
        evidence.diagnostics ? JSON.stringify(evidence.diagnostics) : null,
        evidence.startedAt,
        evidence.completedAt
      )
    this.db
      .prepare(
        `DELETE FROM workspace_verification_events WHERE id IN (
           SELECT id FROM workspace_verification_events WHERE workspace_root = ?
           ORDER BY completed_at DESC LIMIT -1 OFFSET 5000
         )`
      )
      .run(resolve(evidence.workspaceRoot))
    return evidence
  }

  changedPaths(runId: string, workspaceRoot: string, baselineRevision: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT changes_json FROM workspace_change_events
         WHERE run_id = ? AND workspace_root = ? AND revision > ? ORDER BY revision ASC`
      )
      .all(runId, resolve(workspaceRoot), baselineRevision) as Array<{ changes_json: string }>
    const paths = new Set<string>()
    for (const row of rows) {
      for (const change of parseJson<ToolWorkspaceChange[]>(row.changes_json, [])) {
        paths.add(change.previousPath || change.path)
        paths.add(change.path)
      }
    }
    return [...paths].filter(Boolean).sort()
  }

  evidence(runId: string, workspaceRoot: string): VerificationEvidence[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workspace_verification_events
         WHERE run_id = ? AND workspace_root = ? ORDER BY completed_at ASC`
      )
      .all(runId, resolve(workspaceRoot)) as EvidenceRow[]
    return rows.map(evidenceFromRow)
  }

  summary(
    runId: string,
    workspaceRoot: string,
    baselineRevision: number
  ): WorkspaceVerificationSummary {
    const root = resolve(workspaceRoot)
    const currentRevision = this.currentRevision(root)
    const changedPaths = this.changedPaths(runId, root, baselineRevision)
    const suggestedChecks = this.suggestChecks(root)
    if (!changedPaths.length) {
      return {
        status: 'not_applicable',
        workspaceRoot: root,
        baselineRevision,
        currentRevision,
        changedPaths,
        evidence: [],
        suggestedChecks,
        headline: 'No workspace changes to verify.'
      }
    }
    const evidence = this.evidence(runId, root)
    const fingerprint = this.fingerprint(root, changedPaths)
    const fresh = evidence.filter(
      (item) =>
        item.revision === currentRevision &&
        (!item.fingerprint || !fingerprint || item.fingerprint === fingerprint)
    )
    const passing = fresh.filter((item) => item.status === 'passed')
    const failing = fresh.filter((item) => item.status === 'failed')
    const newestPassing = passing.at(-1)
    const newestFailing = failing.at(-1)
    if (
      newestFailing &&
      (!newestPassing || newestFailing.completedAt > newestPassing.completedAt)
    ) {
      return {
        status: 'failed',
        workspaceRoot: root,
        baselineRevision,
        currentRevision,
        changedPaths,
        evidence,
        suggestedChecks,
        headline: newestFailing.summary,
        detail: 'The latest verification for the current workspace revision failed.'
      }
    }
    if (passing.length) {
      const kinds = [...new Set(passing.map((item) => item.kind))]
      return {
        status: 'passed',
        workspaceRoot: root,
        baselineRevision,
        currentRevision,
        changedPaths,
        evidence,
        suggestedChecks,
        headline: `Verified with ${kinds.join(', ')}.`,
        detail: `${changedPaths.length} changed path${changedPaths.length === 1 ? '' : 's'} at revision ${currentRevision}.`
      }
    }
    if (evidence.length) {
      return {
        status: 'stale',
        workspaceRoot: root,
        baselineRevision,
        currentRevision,
        changedPaths,
        evidence,
        suggestedChecks,
        headline: 'Previous verification is stale.',
        detail: 'The workspace changed after the recorded check. Run a relevant check again.'
      }
    }
    return {
      status: 'unverified',
      workspaceRoot: root,
      baselineRevision,
      currentRevision,
      changedPaths,
      evidence,
      suggestedChecks,
      headline: 'Workspace changes have not been verified.',
      detail: 'Run the smallest relevant test, build, typecheck, or lint command before finishing.'
    }
  }

  createTerminalController(
    runId: string,
    workspaceRoot: string | undefined,
    baselineRevision: number
  ): { afterTerminalTurn: () => Promise<VerificationTerminalDecision> } | undefined {
    if (!workspaceRoot) return undefined
    let nudged = false
    return {
      afterTerminalTurn: async () => {
        const summary = this.summary(runId, workspaceRoot, baselineRevision)
        if (
          !nudged &&
          (summary.status === 'unverified' ||
            summary.status === 'stale' ||
            summary.status === 'failed')
        ) {
          nudged = true
          const commands = summary.suggestedChecks.slice(0, 3).map((item) => `- ${item.command}`)
          return {
            continue: true,
            summary,
            prompt:
              `<sidekick_verification_guard trust="app-policy">\n` +
              `${summary.headline} Do not claim completion yet. Inspect the latest failure when present, ` +
              `then run the smallest relevant verification for the files you changed. ` +
              `If no safe or applicable check exists, explain that limitation honestly and finish without inventing success.` +
              `${commands.length ? `\nSuggested project checks:\n${commands.join('\n')}` : ''}\n` +
              `</sidekick_verification_guard>`
          }
        }
        return { continue: false, summary }
      }
    }
  }

  suggestChecks(workspaceRoot: string): VerificationCheckSuggestion[] {
    const root = resolve(workspaceRoot)
    const suggestions: VerificationCheckSuggestion[] = []
    const add = (
      kind: VerificationCheckSuggestion['kind'],
      command: string,
      source: string
    ): void => {
      if (!suggestions.some((item) => item.command === command) && suggestions.length < 6) {
        suggestions.push({ kind, command, source })
      }
    }
    const packagePath = resolve(root, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const scripts = parseJson<Record<string, unknown>>(String(readFileSync(packagePath)), {})
          .scripts as Record<string, unknown> | undefined
        const manager = packageManager(root)
        const run = (name: string): string =>
          manager === 'npm' ? `npm run ${name}` : `${manager} ${name}`
        if (scripts?.typecheck) add('typecheck', run('typecheck'), 'package.json')
        if (scripts?.test) add('test', run('test'), 'package.json')
        if (scripts?.lint) add('lint', run('lint'), 'package.json')
        if (scripts?.build) add('build', run('build'), 'package.json')
        if (scripts?.check) add('check', run('check'), 'package.json')
      } catch {
        // A malformed manifest should not make verification itself fail.
      }
    }
    if (existsSync(resolve(root, 'pyproject.toml')) || existsSync(resolve(root, 'pytest.ini'))) {
      add('test', 'python -m pytest', 'Python project')
    }
    if (existsSync(resolve(root, 'Cargo.toml'))) {
      add('test', 'cargo test', 'Cargo.toml')
      add('check', 'cargo check', 'Cargo.toml')
    }
    if (existsSync(resolve(root, 'go.mod'))) add('test', 'go test ./...', 'go.mod')
    if (existsSync(resolve(root, 'pom.xml'))) add('test', 'mvn test', 'pom.xml')
    if (existsSync(resolve(root, 'gradlew'))) add('test', './gradlew test', 'Gradle wrapper')
    try {
      if (readdirSync(root).some((name) => name.endsWith('.sln') || name.endsWith('.slnx'))) {
        add('test', 'dotnet test', '.NET solution')
      }
    } catch {
      // Ignore unreadable workspace roots; the caller still gets other manifest suggestions.
    }
    if (existsSync(resolve(root, 'Gemfile'))) add('test', 'bundle exec rspec', 'Gemfile')
    if (existsSync(resolve(root, 'composer.json')))
      add('test', 'vendor/bin/phpunit', 'composer.json')
    if (existsSync(resolve(root, 'Package.swift'))) add('test', 'swift test', 'Package.swift')
    return suggestions.slice(0, 4)
  }

  private fingerprint(workspaceRoot: string, paths: string[]): string | undefined {
    const root = resolve(workspaceRoot)
    const normalized = [...new Set(paths)].filter((path) => path !== '*').slice(0, 128)
    if (!normalized.length) return undefined
    const hash = createHash('sha256')
    for (const path of normalized) {
      const relativePath = normalizedRelativePath(root, path)
      if (!relativePath) continue
      const absolute = resolve(root, relativePath)
      hash.update(relativePath)
      try {
        const stat = statSync(absolute)
        hash.update(`${stat.size}:${stat.mtimeMs}`)
        if (stat.isFile() && stat.size <= 4 * 1024 * 1024) hash.update(readFileSync(absolute))
      } catch {
        hash.update('missing')
      }
    }
    return hash.digest('hex')
  }
}
