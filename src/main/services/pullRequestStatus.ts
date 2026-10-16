// Adapted from Cline (https://github.com/cline/cline, commit 23791b9),
// apps/examples/desktop-app/sidecar/pull-request.ts, under the Apache License 2.0:
//
// Copyright 2026 Cline Bot Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
// in compliance with the License. You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
// writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific
// language governing permissions and limitations under the License.
//
// Changed for SideKick: an allow-list of read-only git and gh commands,
// merge-queue lookup, upstream branch names, rate-limit backoff, cached default branches, shared
// in-flight reads, and a typed result in place of thrown errors.

import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestState,
  PullRequestStatus,
  PullRequestStatusResult,
  PullRequestSummary
} from '../../shared/pullRequests'

const execFileAsync = promisify(execFile)

export type ReadOnlyCommand = 'git' | 'gh'
export type ReadOnlyRunner = (file: ReadOnlyCommand, args: string[], cwd: string) => Promise<string>

// Missing or signed-out gh is a machine-level state, so it is shared across workspaces and
// rechecked only after this long. Polls in between never spawn a failing process.
export const GITHUB_AVAILABILITY_CACHE_MS = 5 * 60_000
export const RATE_LIMIT_BACKOFF_MS = 2 * 60_000
const DEFAULT_BRANCH_CACHE_MS = 10 * 60_000

const PR_FIELDS =
  'number,title,url,state,isDraft,mergeable,mergeStateStatus,additions,deletions,statusCheckRollup'
// `gh pr view --json` has no merge-queue field, so this one read-only query fills it in.
const MERGE_QUEUE_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}'

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
// A git branch name that cannot be read as a flag or carry characters git refuses in refs.
const BRANCH = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\\p{Cc}]+$/u
const PR_NUMBER = /^[1-9]\d{0,9}$/

type Template = readonly (string | RegExp)[]

/**
 * Every command this service may run. Nothing here writes: no push, no PR creation, no
 * GraphQL mutation. Placeholders are validated so a branch name can never become a flag.
 */
const READ_ONLY_COMMANDS: Record<ReadOnlyCommand, readonly Template[]> = {
  git: [
    ['branch', '--show-current'],
    ['remote', 'get-url', 'origin'],
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']
  ],
  gh: [
    ['auth', 'status', '--active', '--hostname', 'github.com'],
    ['repo', 'view', REPOSITORY, '--json', 'defaultBranchRef'],
    [
      'pr',
      'list',
      '--repo',
      REPOSITORY,
      '--head',
      BRANCH,
      '--state',
      'all',
      '--limit',
      '30',
      '--json',
      'number,state,headRepositoryOwner,headRepository'
    ],
    ['pr', 'view', PR_NUMBER, '--repo', REPOSITORY, '--json', PR_FIELDS],
    [
      'api',
      'graphql',
      '-f',
      `query=${MERGE_QUEUE_QUERY}`,
      '-f',
      /^owner=[\w.-]+$/,
      '-f',
      /^name=[\w.-]+$/,
      '-F',
      /^number=[1-9]\d{0,9}$/
    ]
  ]
}

export function isReadOnlyCommand(file: string, args: readonly string[]): boolean {
  const templates = READ_ONLY_COMMANDS[file as ReadOnlyCommand]
  if (!templates) return false
  return templates.some(
    (template) =>
      template.length === args.length &&
      template.every((part, index) =>
        typeof part === 'string' ? part === args[index] : part.test(args[index])
      )
  )
}

const defaultRunner: ReadOnlyRunner = async (file, args, cwd) => {
  const { stdout } = await execFileAsync(
    file,
    // fsmonitor is a repository-configured program; these reads never need it.
    file === 'git' ? ['-c', 'core.fsmonitor=false', ...args] : args,
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_SPINNER_DISABLED: '1',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0'
      }
    }
  )
  return stdout.trim()
}

interface GitHubCheck {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

interface GitHubPullRequest {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  additions: number
  deletions: number
  statusCheckRollup: GitHubCheck[] | null
}

interface GitHubPullRequestCandidate {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRepositoryOwner: { login: string } | null
  headRepository: { name: string } | null
}

const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STALE',
  'STARTUP_FAILURE'
])
const CHECK_ORDER: Record<PullRequestCheckState, number> = {
  failure: 0,
  pending: 1,
  success: 2,
  skipped: 3
}

function safeHttpUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function normalizeCheck(check: GitHubCheck): PullRequestCheck {
  // CheckRun (Actions and apps) reports status + conclusion; StatusContext reports state.
  const result =
    check.__typename === 'CheckRun'
      ? check.status === 'COMPLETED'
        ? check.conclusion
        : 'PENDING'
      : check.state
  const state: PullRequestCheckState =
    result === 'SUCCESS'
      ? 'success'
      : result === 'NEUTRAL' || result === 'SKIPPED'
        ? 'skipped'
        : FAILED_CONCLUSIONS.has(result ?? '')
          ? 'failure'
          : 'pending'
  const name = check.name || check.context || 'Check'
  return {
    name: check.workflowName ? `${check.workflowName} / ${name}` : name,
    state,
    url: safeHttpUrl(check.detailsUrl || check.targetUrl)
  }
}

/** owner/name for a github.com origin over HTTPS or SSH; null for anything else. */
export function githubRepository(remote: string): string | null {
  const match = remote
    .trim()
    .match(
      /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
    )
  return match ? `${match[1]}/${match[2]}` : null
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

function errorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const stderr = 'stderr' in error ? String(error.stderr) : ''
  const message = 'message' in error ? String(error.message) : ''
  return `${stderr}\n${message}`
}

function isMissingCli(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isAuthenticationFailure(error: unknown): boolean {
  // gh documents exit 4 for "authentication required".
  if (errorCode(error) === 4) return true
  return /HTTP 401|Bad credentials|not logged in|gh auth login/i.test(errorOutput(error))
}

function isRateLimited(error: unknown): boolean {
  return /rate limit/i.test(errorOutput(error))
}

function pullRequestState(pr: GitHubPullRequest, queued: boolean): PullRequestState {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.isDraft) return 'draft'
  return queued ? 'queued' : 'open'
}

function summarize(pr: GitHubPullRequest, queued: boolean): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    url: safeHttpUrl(pr.url) ?? '',
    state: pullRequestState(pr, queued),
    mergeable:
      pr.mergeable === 'MERGEABLE'
        ? 'mergeable'
        : pr.mergeable === 'CONFLICTING'
          ? 'conflicting'
          : 'unknown',
    mergeStateStatus: pr.mergeStateStatus || 'UNKNOWN',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    checks: (pr.statusCheckRollup ?? [])
      .map(normalizeCheck)
      .sort((left, right) => CHECK_ORDER[left.state] - CHECK_ORDER[right.state])
  }
}

export const RATE_LIMIT_MESSAGE =
  'GitHub’s API rate limit was reached. Pull request status will refresh in a few minutes.'
export const LOAD_FAILED_MESSAGE =
  'Could not load pull request status. Check your connection and try again.'

/**
 * Reads the GitHub pull request for a folder's current branch through git and the GitHub
 * CLI. It only reads: creating a PR happens in GitHub's compare form, never here.
 */
export function createPullRequestStatusReader({
  run = defaultRunner,
  now = Date.now
}: { run?: ReadOnlyRunner; now?: () => number } = {}) {
  let available: boolean | undefined
  let availableUntil = 0
  let availabilityProbe: Promise<boolean> | undefined
  let rateLimitedUntil = 0
  const defaultBranches = new Map<string, { name: string | null; expiresAt: number }>()
  const inFlight = new Map<string, Promise<PullRequestStatusResult>>()

  const exec = (file: ReadOnlyCommand, args: string[], cwd: string): Promise<string> => {
    if (!isReadOnlyCommand(file, args)) {
      return Promise.reject(new Error(`Refused a command outside the read-only list: ${file}`))
    }
    return run(file, args, cwd)
  }

  const markUnavailable = (): void => {
    available = false
    availableUntil = now() + GITHUB_AVAILABILITY_CACHE_MS
  }

  async function isAvailable(cwd: string): Promise<boolean> {
    if (available !== undefined && now() < availableUntil) return available
    availabilityProbe ??= (async () => {
      try {
        await exec('gh', ['auth', 'status', '--active', '--hostname', 'github.com'], cwd)
        available = true
        availableUntil = now() + GITHUB_AVAILABILITY_CACHE_MS
        return true
      } catch (error) {
        // gh auth status exits 1 when signed out; ENOENT means it is not installed.
        if (isMissingCli(error) || errorCode(error) === 1 || isAuthenticationFailure(error)) {
          markUnavailable()
          return false
        }
        throw error
      }
    })().finally(() => {
      availabilityProbe = undefined
    })
    return availabilityProbe
  }

  async function defaultBranch(repository: string, cwd: string): Promise<string | null> {
    const cached = defaultBranches.get(repository)
    if (cached && now() < cached.expiresAt) return cached.name
    const repo = JSON.parse(
      await exec('gh', ['repo', 'view', repository, '--json', 'defaultBranchRef'], cwd)
    ) as { defaultBranchRef: { name: string } | null }
    const name = repo.defaultBranchRef?.name || null
    defaultBranches.set(repository, { name, expiresAt: now() + DEFAULT_BRANCH_CACHE_MS })
    return name
  }

  async function isInMergeQueue(repository: string, number: number, cwd: string) {
    const [owner, name] = repository.split('/')
    try {
      const response = JSON.parse(
        await exec(
          'gh',
          [
            'api',
            'graphql',
            '-f',
            `query=${MERGE_QUEUE_QUERY}`,
            '-f',
            `owner=${owner}`,
            '-f',
            `name=${name}`,
            '-F',
            `number=${number}`
          ],
          cwd
        )
      ) as { data?: { repository?: { pullRequest?: { isInMergeQueue?: boolean } } } }
      return response.data?.repository?.pullRequest?.isInMergeQueue === true
    } catch (error) {
      // The queue is a refinement of "open"; only rate limits and sign-outs matter here.
      if (isRateLimited(error) || isAuthenticationFailure(error)) throw error
      return false
    }
  }

  async function read(cwd: string): Promise<PullRequestStatusResult> {
    if (available === false && now() < availableUntil) return { ok: true, status: null }
    // An empty branch is a detached HEAD; a failure means the folder is not a repository.
    const branch = await exec('git', ['branch', '--show-current'], cwd).catch(() => '')
    if (!branch || !BRANCH.test(branch)) return { ok: true, status: null }
    const remote = await exec('git', ['remote', 'get-url', 'origin'], cwd).catch(() => '')
    const repository = githubRepository(remote)
    if (!repository) return { ok: true, status: null }
    // A branch pushed under another name on origin is still this branch's PR head.
    const upstream = await exec(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      cwd
    ).catch(() => '')
    const remoteBranch = upstream.startsWith('origin/') ? upstream.slice('origin/'.length) : ''
    const head = remoteBranch && BRANCH.test(remoteBranch) ? remoteBranch : branch

    if (now() < rateLimitedUntil) return { ok: false, error: RATE_LIMIT_MESSAGE }
    try {
      if (!(await isAvailable(cwd))) return { ok: true, status: null }
      const base = await defaultBranch(repository, cwd)
      // The default branch can carry years-old PRs from earlier workflows; none describe
      // the current work, and it is not a PR source branch.
      if (branch === base || head === base) return { ok: true, status: null }
      const [owner, name] = repository.split('/')
      const candidates = (
        JSON.parse(
          await exec(
            'gh',
            [
              'pr',
              'list',
              '--repo',
              repository,
              '--head',
              head,
              '--state',
              'all',
              '--limit',
              '30',
              '--json',
              'number,state,headRepositoryOwner,headRepository'
            ],
            cwd
          )
        ) as GitHubPullRequestCandidate[]
      ).filter(
        // --head matches the branch name in any fork; only this repository's branch counts.
        (pr) =>
          pr.headRepositoryOwner?.login.toLowerCase() === owner.toLowerCase() &&
          pr.headRepository?.name.toLowerCase() === name.toLowerCase()
      )
      const candidate = candidates.find((pr) => pr.state === 'OPEN') ?? candidates[0]
      let pullRequest: PullRequestSummary | null = null
      if (candidate && PR_NUMBER.test(String(candidate.number))) {
        const pr = JSON.parse(
          await exec(
            'gh',
            ['pr', 'view', String(candidate.number), '--repo', repository, '--json', PR_FIELDS],
            cwd
          )
        ) as GitHubPullRequest
        const queued =
          pr.state === 'OPEN' && !pr.isDraft
            ? await isInMergeQueue(repository, pr.number, cwd)
            : false
        pullRequest = summarize(pr, queued)
      }
      const status: PullRequestStatus = {
        repository,
        branch,
        createUrl: base
          ? `https://github.com/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
          : null,
        pullRequest
      }
      return { ok: true, status }
    } catch (error) {
      // Authentication can expire while a positive availability result is cached.
      if (isMissingCli(error) || isAuthenticationFailure(error)) {
        markUnavailable()
        return { ok: true, status: null }
      }
      if (isRateLimited(error)) {
        rateLimitedUntil = now() + RATE_LIMIT_BACKOFF_MS
        return { ok: false, error: RATE_LIMIT_MESSAGE }
      }
      return { ok: false, error: LOAD_FAILED_MESSAGE }
    }
  }

  /** Concurrent callers for one folder (focus plus interval) share one read. */
  return function readPullRequestStatus(cwd: string): Promise<PullRequestStatusResult> {
    const pending = inFlight.get(cwd)
    if (pending) return pending
    const next = read(cwd).finally(() => inFlight.delete(cwd))
    inFlight.set(cwd, next)
    return next
  }
}
