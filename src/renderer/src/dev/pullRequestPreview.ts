import type {
  PullRequestCheck,
  PullRequestStatus,
  PullRequestSummary,
  PullRequestsAPI
} from '../../../shared/pullRequests'

const repository = 'sidekick-labs/sidekick-demo'
const branch = 'eponce/refine-desktop-experience'
const actions = 'https://github.com/sidekick-labs/sidekick-demo/actions/runs/1042/job'

const check = (
  name: string,
  state: PullRequestCheck['state'],
  job: number | null
): PullRequestCheck => ({ name, state, url: job ? `${actions}/${job}` : null })

const pr = (overrides: Partial<PullRequestSummary>): PullRequestSummary => ({
  number: 128,
  title: 'Refine the desktop experience',
  url: `https://github.com/${repository}/pull/128`,
  state: 'open',
  mergeable: 'mergeable',
  mergeStateStatus: 'CLEAN',
  additions: 1284,
  deletions: 312,
  checks: [
    check('CI / Validate (Windows x64)', 'success', 1),
    check('CI / Validate (macOS arm64)', 'success', 2),
    check('CI / Validate (Linux x64)', 'success', 3),
    check('Docs / Link check', 'skipped', null)
  ],
  ...overrides
})

/**
 * Pull request states for the composer bar, chosen with `?pr=<state>` in the UI preview.
 * `none` hides the bar, as a default branch or a missing GitHub CLI would.
 */
export const previewPullRequestStates: Record<string, PullRequestSummary | null | 'none'> = {
  running: pr({
    mergeStateStatus: 'BLOCKED',
    checks: [
      check('CI / Validate (Windows x64)', 'pending', 1),
      check('CI / Validate (macOS arm64)', 'pending', 2),
      check('CI / Validate (Linux x64)', 'success', 3)
    ]
  }),
  failing: pr({
    mergeStateStatus: 'UNSTABLE',
    checks: [
      check('CI / Validate (Windows x64)', 'failure', 1),
      check('CI / Validate (macOS arm64)', 'success', 2),
      check('CI / Validate (Linux x64)', 'success', 3)
    ]
  }),
  draft: pr({ state: 'draft', mergeStateStatus: 'DRAFT', additions: 86, deletions: 14 }),
  ready: pr({}),
  queued: pr({ state: 'queued' }),
  conflicts: pr({ mergeable: 'conflicting', mergeStateStatus: 'DIRTY' }),
  merged: pr({ state: 'merged', mergeable: 'unknown', mergeStateStatus: 'UNKNOWN' }),
  closed: pr({ state: 'closed', additions: 40, deletions: 2, checks: [] }),
  create: null,
  none: 'none'
}

export function previewPullRequestsApi(): PullRequestsAPI {
  return {
    getStatus: async (workspaceRoot) => {
      const requested = new URLSearchParams(window.location.search).get('pr') ?? 'running'
      const sample =
        requested in previewPullRequestStates
          ? previewPullRequestStates[requested]
          : previewPullRequestStates.running
      if (sample === 'none' || !workspaceRoot) return { ok: true, status: null }
      const status: PullRequestStatus = {
        repository,
        branch,
        createUrl: `https://github.com/${repository}/compare/main...${encodeURIComponent(branch)}?expand=1`,
        pullRequest: sample
      }
      return { ok: true, status }
    }
  }
}
