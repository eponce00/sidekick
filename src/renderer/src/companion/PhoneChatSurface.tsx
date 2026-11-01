import type { ReactNode } from 'react'
import { ChatSurfaceContext, type ChatSurface } from '../components/chatSurface'
import { WorkerChatContext } from '../components/sessionChatContext'
import { SubAgentNavigation } from '../components/subAgentNavigation'
import { ReviewCommentSinkContext } from '../hooks/useReviewCommentSink'
import { COMPUTER_ONLY, resolvePhoneImage } from './phoneApi'

const PHONE_SURFACE: ChatSurface = {
  resolveImage: resolvePhoneImage,
  computerOnly: COMPUTER_ONLY,
  offline: true
}

/**
 * What the desktop's chat components need from around them, as the phone has it: images through
 * the computer, no sub-agent transcripts to open, no comments on changed lines, and no worker
 * identity, since the phone follows one chat at a time.
 */
export function PhoneChatSurface({ children }: { children: ReactNode }) {
  return (
    <ChatSurfaceContext.Provider value={PHONE_SURFACE}>
      <ReviewCommentSinkContext.Provider value={null}>
        <SubAgentNavigation.Provider value={null}>
          <WorkerChatContext.Provider value={null}>{children}</WorkerChatContext.Provider>
        </SubAgentNavigation.Provider>
      </ReviewCommentSinkContext.Provider>
    </ChatSurfaceContext.Provider>
  )
}
