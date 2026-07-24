// Utility functions for grouping and organizing content segments

import type { ContentSegment, GroupedSegment } from '../types/chat.types'

/**
 * Groups consecutive thinking/tool segments together while keeping text/artifacts separate
 *
 * This helps render the UI more efficiently by grouping action segments (thinking + tools)
 * into collapsible sections while keeping content segments (text/artifacts) standalone.
 *
 * IMPORTANT: Tools that require approval (accessLevel === 'confirm' && approvalStatus === 'pending')
 * are kept as standalone segments so they're visible in the chat for user action.
 *
 * @param segments - Array of content segments to group
 * @returns Array of grouped segments (either action groups or individual content segments)
 *
 * @example
 * Input: [thinking, tool, text, thinking, artifact]
 * Output: [
 *   { type: 'actions', segments: [thinking, tool] },
 *   { type: 'content', segment: text },
 *   { type: 'actions', segments: [thinking] },
 *   { type: 'content', segment: artifact }
 * ]
 */
export function groupSegments(segments: ContentSegment[]): GroupedSegment[] {
  const groups: GroupedSegment[] = []
  let currentActionGroup: ContentSegment[] = []

  for (const segment of segments) {
    // Check if this is a tool that needs approval - keep it standalone
    const isPendingApproval =
      segment.type === 'tool' &&
      segment.tool?.accessLevel === 'confirm' &&
      segment.tool?.approvalStatus === 'pending'

    if (isPendingApproval) {
      // Close current action group first
      if (currentActionGroup.length > 0) {
        groups.push({
          type: 'actions',
          toolSegments: currentActionGroup.filter((s) => s.type === 'tool'),
          thinkingSegments: currentActionGroup.filter((s) => s.type === 'thinking')
        })
        currentActionGroup = []
      }
      // Add pending approval tool as standalone content
      groups.push({ type: 'content', segment })
    } else if (segment.type === 'thinking' || segment.type === 'tool') {
      // Add to current action group
      currentActionGroup.push(segment)
    } else if (
      segment.type === 'summary' ||
      segment.type === 'summarizing' ||
      segment.type === 'decision' ||
      segment.type === 'interaction' ||
      segment.type === 'verification'
    ) {
      // Summary, summarizing, and decision segments are standalone (like artifacts)
      if (currentActionGroup.length > 0) {
        groups.push({
          type: 'actions',
          toolSegments: currentActionGroup.filter((s) => s.type === 'tool'),
          thinkingSegments: currentActionGroup.filter((s) => s.type === 'thinking')
        })
        currentActionGroup = []
      }
      groups.push({ type: 'content', segment })
    } else {
      // Text or artifact - close current action group first
      if (currentActionGroup.length > 0) {
        groups.push({
          type: 'actions',
          toolSegments: currentActionGroup.filter((s) => s.type === 'tool'),
          thinkingSegments: currentActionGroup.filter((s) => s.type === 'thinking')
        })
        currentActionGroup = []
      }
      groups.push({ type: 'content', segment })
    }
  }

  // Don't forget trailing action group
  if (currentActionGroup.length > 0) {
    groups.push({
      type: 'actions',
      toolSegments: currentActionGroup.filter((s) => s.type === 'tool'),
      thinkingSegments: currentActionGroup.filter((s) => s.type === 'thinking')
    })
  }

  return groups
}
