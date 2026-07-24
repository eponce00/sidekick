import type { Message } from '../types/chat.types'
import { hasArtifacts, parseMessageWithArtifacts } from './artifactParser'

export function messageTextForClipboard(message: Message): string {
  let text = ''
  const segments =
    message.segments ||
    (hasArtifacts(message.content) ? parseMessageWithArtifacts(message.content).segments : null)

  if (segments) {
    for (const segment of segments) {
      if (segment.type === 'text' && segment.content) text += `${segment.content}\n\n`
      if (segment.type === 'artifact' && segment.artifact) {
        text += `\`\`\`${segment.artifact.type}\n${segment.artifact.code}\n\`\`\`\n\n`
      }
    }
  }

  return text.trim() || message.content.trim()
}
