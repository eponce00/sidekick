// Adapted from Cline (https://github.com/cline/cline, commit 23791b9),
// sdk/packages/ui/components/agent-pull-request-bar.tsx (merge-status and check
// summary precedence), under the Apache License 2.0:
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
// Changed for SideKick: SideKick state names, a merge-queue state, and labels.

export type PullRequestCheckState = 'pending' | 'success' | 'failure' | 'skipped'

export interface PullRequestCheck {
  name: string
  state: PullRequestCheckState
  /** The check's log or details page, when GitHub reports an http(s) one. */
  url: string | null
}

export type PullRequestState = 'draft' | 'open' | 'queued' | 'merged' | 'closed'

export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: PullRequestState
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** GitHub's mergeStateStatus, such as CLEAN, BLOCKED, BEHIND, DIRTY, or UNSTABLE. */
  mergeStateStatus: string
  additions: number
  deletions: number
  checks: PullRequestCheck[]
}

export interface PullRequestStatus {
  /** owner/name on github.com. */
  repository: string
  branch: string
  /** GitHub's compare form for this branch; null when the base branch is unknown. */
  createUrl: string | null
  pullRequest: PullRequestSummary | null
}

/**
 * `status: null` means there is nothing to show: not a GitHub repository, the default
 * branch, a detached HEAD, or a missing or signed-out GitHub CLI.
 */
export type PullRequestStatusResult =
  | { ok: true; status: PullRequestStatus | null }
  | { ok: false; error: string }

export interface PullRequestsAPI {
  getStatus: (workspaceRoot: string) => Promise<PullRequestStatusResult>
}

export type PullRequestTone = 'success' | 'warning' | 'failure' | 'merged' | 'neutral'

/** One label for the pull request, in the order a reviewer cares about. */
export function pullRequestMergeStatus(pr: PullRequestSummary): {
  label: string
  tone: PullRequestTone
} {
  if (pr.state === 'merged') return { label: 'Merged', tone: 'merged' }
  if (pr.state === 'closed') return { label: 'Closed', tone: 'failure' }
  if (pr.state === 'draft') return { label: 'Draft', tone: 'neutral' }
  if (pr.state === 'queued') return { label: 'In merge queue', tone: 'merged' }
  if (pr.mergeable === 'conflicting' || pr.mergeStateStatus === 'DIRTY')
    return { label: 'Conflicts', tone: 'failure' }
  if (pr.mergeStateStatus === 'BLOCKED') return { label: 'Blocked', tone: 'warning' }
  if (pr.mergeStateStatus === 'BEHIND') return { label: 'Behind base', tone: 'warning' }
  if (pr.mergeStateStatus === 'UNSTABLE') return { label: 'Checks failing', tone: 'failure' }
  if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'HAS_HOOKS')
    return { label: 'Ready to merge', tone: 'success' }
  if (pr.mergeable === 'mergeable') return { label: 'No conflicts', tone: 'neutral' }
  return { label: 'Checking mergeability', tone: 'neutral' }
}

export type PullRequestChecksSummary = 'none' | PullRequestCheckState

export function summarizePullRequestChecks(checks: PullRequestCheck[]): PullRequestChecksSummary {
  if (!checks.length) return 'none'
  if (checks.some((check) => check.state === 'failure')) return 'failure'
  if (checks.some((check) => check.state === 'pending')) return 'pending'
  if (checks.every((check) => check.state === 'skipped')) return 'skipped'
  return 'success'
}
