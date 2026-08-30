import { describe, expect, it } from 'vitest'
import {
  checkpointFallbackTitleFromDiff,
  checkpointFallbackTitleFromPaths,
  isCheckpointTitleSource,
  normalizeCheckpointTitle
} from './checkpointTitles'

describe('checkpoint titles', () => {
  it('recognizes durable title sources', () => {
    expect(isCheckpointTitleSource('generated')).toBe(true)
    expect(isCheckpointTitleSource('model')).toBe(false)
  })

  it('rejects meta-instructions repeated by a weak title model', () => {
    expect(normalizeCheckpointTitle('The user wants me to create an imperative')).toBeNull()
    expect(normalizeCheckpointTitle('Update files')).toBeNull()
    expect(normalizeCheckpointTitle('Fix approval card state.')).toBe('Fix approval card state')
  })

  it('creates an immediate label from the changed path', () => {
    expect(checkpointFallbackTitleFromPaths(['cuba-population/index.html'])).toBe(
      'Update Cuba population'
    )
  })

  it('extracts changed paths from a Git diff', () => {
    const diff = [
      'diff --git a/src/ApprovalCard.tsx b/src/ApprovalCard.tsx',
      'diff --git a/src/approval-card.css b/src/approval-card.css'
    ].join('\n')
    expect(checkpointFallbackTitleFromDiff(diff)).toBe('Update Approval Card files')
  })
})
