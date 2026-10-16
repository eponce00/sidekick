import { describe, expect, it, vi } from 'vitest'
import {
  createPullRequestStatusReader,
  GITHUB_AVAILABILITY_CACHE_MS,
  githubRepository,
  isReadOnlyCommand,
  LOAD_FAILED_MESSAGE,
  normalizeCheck,
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_MESSAGE,
  type ReadOnlyCommand
} from './pullRequestStatus'
import { pullRequestMergeStatus, summarizePullRequestChecks } from '../../shared/pullRequests'

const pr = {
  number: 42,
  title: 'Add the pull request bar',
  url: 'https://github.com/sidekick-labs/sidekick/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  additions: 120,
  deletions: 8,
  headRepositoryOwner: { login: 'sidekick-labs' },
  headRepository: { name: 'sidekick' },
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'Validate (Windows x64)',
      workflowName: 'CI',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/sidekick-labs/sidekick/actions/runs/1/job/2'
    }
  ]
}

type CannedPullRequest = Omit<typeof pr, 'statusCheckRollup'> &
  Record<string, unknown> & { statusCheckRollup: Record<string, string>[] }

interface RunnerOptions {
  prs?: CannedPullRequest[]
  branch?: string
  remote?: string
  upstream?: string
  defaultBranch?: string
  queued?: boolean
  fail?: (file: ReadOnlyCommand, args: string[]) => unknown
}

/** A fake git and gh that answer from canned `--json` output. */
function runner({
  prs = [pr],
  branch = 'feature/pr-bar',
  remote = 'git@github.com:sidekick-labs/sidekick.git',
  upstream = '',
  defaultBranch = 'main',
  queued = false,
  fail
}: RunnerOptions = {}) {
  return vi.fn(async (file: ReadOnlyCommand, args: string[], _cwd: string): Promise<string> => {
    const failure = fail?.(file, args)
    if (failure) throw failure
    if (file === 'git') {
      if (args[0] === 'branch') return branch
      if (args[0] === 'remote') return remote
      if (!upstream) throw Object.assign(new Error('no upstream'), { code: 128 })
      return upstream
    }
    if (args[0] === 'auth') return 'Logged in to github.com'
    if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: defaultBranch } })
    if (args[0] === 'api') {
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: queued } } } })
    }
    if (args[1] === 'list') return JSON.stringify(prs)
    return JSON.stringify(prs.find((item) => item.number === Number(args[2])))
  })
}

function commandError(code: unknown, stderr = ''): Error {
  return Object.assign(new Error(`Command failed\n${stderr}`), { code, stderr })
}

describe('pull request status reader', () => {
  it('reads an open pull request for the folder and runs every command there', async () => {
    const run = runner()
    const result = await createPullRequestStatusReader({ run })('/worktree')
    expect(result).toEqual({
      ok: true,
      status: {
        repository: 'sidekick-labs/sidekick',
        branch: 'feature/pr-bar',
        createUrl:
          'https://github.com/sidekick-labs/sidekick/compare/main...feature%2Fpr-bar?expand=1',
        pullRequest: {
          number: 42,
          title: 'Add the pull request bar',
          url: 'https://github.com/sidekick-labs/sidekick/pull/42',
          state: 'open',
          mergeable: 'mergeable',
          mergeStateStatus: 'CLEAN',
          additions: 120,
          deletions: 8,
          checks: [
            {
              name: 'CI / Validate (Windows x64)',
              state: 'success',
              url: 'https://github.com/sidekick-labs/sidekick/actions/runs/1/job/2'
            }
          ]
        }
      }
    })
    expect(run.mock.calls.every((call) => call[2] === '/worktree')).toBe(true)
    expect(run.mock.calls.every(([file, args]) => isReadOnlyCommand(file, args))).toBe(true)
  })

  it.each([
    ['draft', { isDraft: true, mergeStateStatus: 'DRAFT' }, false, 'Draft'],
    ['open', { mergeStateStatus: 'CLEAN' }, false, 'Ready to merge'],
    ['queued', { mergeStateStatus: 'CLEAN' }, true, 'In merge queue'],
    [
      'merged',
      { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
      false,
      'Merged'
    ],
    ['closed', { state: 'CLOSED' }, false, 'Closed']
  ])('reports a %s pull request', async (state, overrides, queued, label) => {
    const run = runner({ prs: [{ ...pr, ...overrides }], queued })
    const result = await createPullRequestStatusReader({ run })('/repo')
    const summary = result.ok ? result.status?.pullRequest : null
    expect(summary?.state).toBe(state)
    expect(summary && pullRequestMergeStatus(summary).label).toBe(label)
    // Only open, ready pull requests can be in a merge queue, so only they ask.
    expect(run.mock.calls.some(([, args]) => args[0] === 'api')).toBe(
      state === 'open' || state === 'queued'
    )
  })

  it.each([
    ['CONFLICTING', 'DIRTY', 'Conflicts', 'failure'],
    ['MERGEABLE', 'BLOCKED', 'Blocked', 'warning'],
    ['MERGEABLE', 'BEHIND', 'Behind base', 'warning'],
    ['MERGEABLE', 'UNSTABLE', 'Checks failing', 'failure'],
    ['UNKNOWN', 'UNKNOWN', 'Checking mergeability', 'neutral']
  ])('labels mergeable=%s merge state %s', async (mergeable, mergeStateStatus, label, tone) => {
    const run = runner({ prs: [{ ...pr, mergeable, mergeStateStatus }] })
    const result = await createPullRequestStatusReader({ run })('/repo')
    const summary = result.ok ? result.status?.pullRequest : null
    expect(summary && pullRequestMergeStatus(summary)).toEqual({ label, tone })
  })

  it('summarizes running and failing checks and lists failures first', async () => {
    const run = runner({
      prs: [
        {
          ...pr,
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'Build', status: 'IN_PROGRESS' },
            {
              __typename: 'StatusContext',
              context: 'ci/circleci',
              state: 'FAILURE',
              targetUrl: 'https://circleci.com/gh/sidekick-labs/sidekick/7'
            }
          ]
        }
      ]
    })
    const result = await createPullRequestStatusReader({ run })('/repo')
    const checks = result.ok ? (result.status?.pullRequest?.checks ?? []) : []
    expect(checks.map((check) => [check.name, check.state])).toEqual([
      ['ci/circleci', 'failure'],
      ['Build', 'pending'],
      ['Lint', 'success']
    ])
    expect(summarizePullRequestChecks(checks)).toBe('failure')
    expect(summarizePullRequestChecks(checks.slice(1))).toBe('pending')
    expect(summarizePullRequestChecks([])).toBe('none')
  })

  it('offers Create PR when the branch has no pull request', async () => {
    const result = await createPullRequestStatusReader({ run: runner({ prs: [] }) })('/repo')
    expect(result).toMatchObject({
      ok: true,
      status: {
        pullRequest: null,
        createUrl:
          'https://github.com/sidekick-labs/sidekick/compare/main...feature%2Fpr-bar?expand=1'
      }
    })
  })

  it('ignores same-named branches in forks and prefers an open pull request', async () => {
    const run = runner({
      prs: [
        { ...pr, number: 99, headRepositoryOwner: { login: 'someone-else' } },
        { ...pr, number: 41, state: 'MERGED' },
        pr
      ]
    })
    const result = await createPullRequestStatusReader({ run })('/repo')
    expect(result.ok && result.status?.pullRequest?.number).toBe(42)
  })

  it('looks the pull request up by the branch name pushed to origin', async () => {
    const run = runner({ branch: 'local-name', upstream: 'origin/eponce/remote-name', prs: [] })
    const result = await createPullRequestStatusReader({ run })('/repo')
    expect(result.ok && result.status?.createUrl).toBe(
      'https://github.com/sidekick-labs/sidekick/compare/main...eponce%2Fremote-name?expand=1'
    )
    const list = run.mock.calls.find(([, args]) => args[1] === 'list')?.[1]
    expect(list?.[list.indexOf('--head') + 1]).toBe('eponce/remote-name')
  })

  it.each([
    ['the default branch', { branch: 'main' }],
    ['a detached HEAD', { branch: '' }],
    ['a non-GitHub remote', { remote: 'https://gitlab.com/sidekick-labs/sidekick.git' }],
    ['a folder without an origin', { remote: '' }]
  ])('shows nothing for %s', async (_name, options) => {
    const result = await createPullRequestStatusReader({ run: runner(options) })('/repo')
    expect(result).toEqual({ ok: true, status: null })
  })

  it('shows nothing for a folder that is not a repository', async () => {
    const run = runner({ fail: (file) => (file === 'git' ? commandError(128) : null) })
    const result = await createPullRequestStatusReader({ run })('/not-a-repo')
    expect(result).toEqual({ ok: true, status: null })
    expect(run.mock.calls.some(([file]) => file === 'gh')).toBe(false)
  })

  it('caches a missing gh so polls do not spawn it again until the cache expires', async () => {
    let time = 1_000
    const run = runner({ fail: (file) => (file === 'gh' ? commandError('ENOENT') : null) })
    const read = createPullRequestStatusReader({ run, now: () => time })
    expect(await read('/a')).toEqual({ ok: true, status: null })
    expect(await read('/b')).toEqual({ ok: true, status: null })
    expect(run.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(1)
    // The cached result stops the git reads too.
    expect(run.mock.calls.filter(([file]) => file === 'git')).toHaveLength(3)

    time += GITHUB_AVAILABILITY_CACHE_MS + 1
    await read('/a')
    expect(run.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(2)
  })

  it('treats a signed-out gh as unavailable', async () => {
    const run = runner({
      fail: (file, args) =>
        file === 'gh' && args[0] === 'auth'
          ? commandError(1, 'You are not logged into any GitHub hosts. Run gh auth login')
          : null
    })
    const read = createPullRequestStatusReader({ run })
    expect(await read('/repo')).toEqual({ ok: true, status: null })
    await read('/repo')
    expect(run.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(1)
  })

  it('hides the bar when the token expires after a successful probe', async () => {
    let expired = false
    const run = runner({
      fail: (file, args) =>
        expired && file === 'gh' && args[0] === 'pr'
          ? commandError(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)')
          : null
    })
    const read = createPullRequestStatusReader({ run })
    expect((await read('/repo')).ok).toBe(true)
    expired = true
    expect(await read('/repo')).toEqual({ ok: true, status: null })
    const ghCalls = run.mock.calls.filter(([file]) => file === 'gh').length
    await read('/repo')
    expect(run.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(ghCalls)
  })

  it('reports a rate limit and backs off before calling GitHub again', async () => {
    let time = 0
    let limited = true
    const run = runner({
      fail: (file, args) =>
        limited && file === 'gh' && args[0] === 'pr'
          ? commandError(1, 'GraphQL: API rate limit exceeded for user ID 1.')
          : null
    })
    const read = createPullRequestStatusReader({ run, now: () => time })
    expect(await read('/repo')).toEqual({ ok: false, error: RATE_LIMIT_MESSAGE })
    const ghCalls = run.mock.calls.filter(([file]) => file === 'gh').length
    time += 30_000
    expect(await read('/repo')).toEqual({ ok: false, error: RATE_LIMIT_MESSAGE })
    expect(run.mock.calls.filter(([file]) => file === 'gh')).toHaveLength(ghCalls)

    limited = false
    time += RATE_LIMIT_BACKOFF_MS
    expect((await read('/repo')).ok).toBe(true)
  })

  it('returns a readable error for other gh failures and malformed output', async () => {
    const offline = runner({
      fail: (file, args) =>
        file === 'gh' && args[0] === 'repo'
          ? commandError(1, 'error connecting to api.github.com')
          : null
    })
    expect(await createPullRequestStatusReader({ run: offline })('/repo')).toEqual({
      ok: false,
      error: LOAD_FAILED_MESSAGE
    })

    const malformed = vi.fn(async (file: ReadOnlyCommand, args: string[]) =>
      file === 'git'
        ? args[0] === 'branch'
          ? 'feature'
          : 'https://github.com/sidekick-labs/sidekick.git'
        : 'not json'
    )
    expect(await createPullRequestStatusReader({ run: malformed })('/repo')).toEqual({
      ok: false,
      error: LOAD_FAILED_MESSAGE
    })
  })

  it('keeps an open pull request open when the merge-queue lookup fails', async () => {
    const run = runner({
      fail: (file, args) =>
        file === 'gh' && args[0] === 'api' ? commandError(1, 'HTTP 502') : null
    })
    const result = await createPullRequestStatusReader({ run })('/repo')
    expect(result.ok && result.status?.pullRequest?.state).toBe('open')
  })

  it('shares one read between concurrent callers for a folder', async () => {
    const run = runner()
    const read = createPullRequestStatusReader({ run })
    const [first, second] = await Promise.all([read('/repo'), read('/repo')])
    expect(first).toBe(second)
    expect(run.mock.calls.filter(([, args]) => args[1] === 'list')).toHaveLength(1)
  })

  it('never runs a branch name that could be read as a flag', async () => {
    const run = runner({ branch: '--upload-pack=evil' })
    expect(await createPullRequestStatusReader({ run })('/repo')).toEqual({
      ok: true,
      status: null
    })
    expect(run.mock.calls.some(([file]) => file === 'gh')).toBe(false)
  })
})

describe('read-only command list', () => {
  it.each([
    ['gh', ['pr', 'create', '--fill']],
    ['gh', ['pr', 'merge', '42', '--repo', 'sidekick-labs/sidekick']],
    ['gh', ['api', 'graphql', '-f', 'query=mutation { deleteRepository }']],
    ['gh', ['api', '-X', 'DELETE', 'repos/sidekick-labs/sidekick']],
    ['gh', ['repo', 'view', '--web', '--json', 'defaultBranchRef']],
    [
      'gh',
      [
        'pr',
        'list',
        '--repo',
        'sidekick-labs/sidekick',
        '--head',
        '--web',
        '--state',
        'all',
        '--limit',
        '30',
        '--json',
        'number,state,headRepositoryOwner,headRepository'
      ]
    ],
    ['git', ['push', 'origin', 'HEAD']],
    ['git', ['remote', 'set-url', 'origin', 'https://evil.example/repo.git']],
    ['git', ['branch', '--show-current', '--delete']],
    ['sh', ['-c', 'gh pr view']]
  ])('refuses %s %j', (file, args) => {
    expect(isReadOnlyCommand(file, args)).toBe(false)
  })

  it('accepts only positive pull request numbers', () => {
    const view = (number: string): string[] => [
      'pr',
      'view',
      number,
      '--repo',
      'sidekick-labs/sidekick',
      '--json',
      'number,title,url,state,isDraft,mergeable,mergeStateStatus,additions,deletions,statusCheckRollup'
    ]
    expect(isReadOnlyCommand('gh', view('42'))).toBe(true)
    expect(isReadOnlyCommand('gh', view('0'))).toBe(false)
    expect(isReadOnlyCommand('gh', view('--web'))).toBe(false)
  })
})

describe('GitHub helpers', () => {
  it.each([
    ['https://github.com/sidekick-labs/sidekick.git', 'sidekick-labs/sidekick'],
    ['https://github.com/sidekick-labs/sidekick', 'sidekick-labs/sidekick'],
    ['https://token@github.com/sidekick-labs/side.kick.git', 'sidekick-labs/side.kick'],
    ['git@github.com:sidekick-labs/sidekick.git', 'sidekick-labs/sidekick'],
    ['ssh://git@github.com/sidekick-labs/sidekick.git', 'sidekick-labs/sidekick'],
    ['https://github.example.com/sidekick-labs/sidekick.git', null],
    ['https://gitlab.com/sidekick-labs/sidekick.git', null],
    ['https://github.com.evil.example/sidekick-labs/sidekick.git', null],
    ['', null]
  ])('reads %s as %s', (remote, repository) => {
    expect(githubRepository(remote)).toBe(repository)
  })

  it('drops check links that are not http(s)', () => {
    expect(
      normalizeCheck({
        __typename: 'StatusContext',
        context: 'deploy',
        state: 'PENDING',
        targetUrl: 'javascript:alert(1)'
      })
    ).toEqual({ name: 'deploy', state: 'pending', url: null })
    expect(
      normalizeCheck({
        __typename: 'CheckRun',
        name: 'Docs',
        status: 'COMPLETED',
        conclusion: 'SKIPPED'
      }).state
    ).toBe('skipped')
  })
})
