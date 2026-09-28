import { createContext, useContext } from 'react'
import type { ReviewCommentInput } from '../../../shared/messageContextAttachments'

/**
 * Where a comment written on a diff line goes: the composer of the chat that
 * shows the diff. Returns whether it was added. Diffs outside a chat panel
 * have no sink and stay view-only.
 */
export type ReviewCommentSink = (comment: ReviewCommentInput) => boolean

export const ReviewCommentSinkContext = createContext<ReviewCommentSink | null>(null)

export function useReviewCommentSink(): ReviewCommentSink | null {
  return useContext(ReviewCommentSinkContext)
}
