const INSTRUCTION_FRAME_TAG = /<(\s*\/?\s*(?:project[_-]instructions|system[_-]reminder)\b)/gi

const PROJECT_INSTRUCTIONS_FRAME = '<project_instructions trust="app-loaded-project-instructions">'

/** Prevent project-controlled text from forging an app-owned instruction boundary. */
export function neutralizeProjectInstructionFrames(content: string): string {
  return content.replace(INSTRUCTION_FRAME_TAG, '&lt;$1')
}

export function formatProjectInstructionsMessage(input: {
  content: string
  sources: readonly string[]
  scoped?: boolean
  retryRequired?: boolean
}): string {
  const content = input.content.trim()
  if (!content) return ''
  const sources = input.sources.length ? input.sources.join(', ') : 'project instruction files'
  const scopeNotice = input.scoped
    ? 'These instructions apply to the file or directory just accessed. More deeply nested files take precedence within their directory tree.'
    : 'More deeply nested instruction files take precedence within their directory tree.'
  const retryNotice = input.retryRequired
    ? '\nThe requested mutation was not performed. Review these instructions, then retry the operation if it remains appropriate.'
    : ''
  return `${PROJECT_INSTRUCTIONS_FRAME}
Loaded from: ${neutralizeProjectInstructionFrames(sources)}
${scopeNotice}${retryNotice}

${neutralizeProjectInstructionFrames(content)}
</project_instructions>`
}

/**
 * The message a run's project instructions arrive in. Project text cannot forge its opening tag,
 * which `neutralizeProjectInstructionFrames` escapes.
 */
export function isProjectInstructionsMessage(message: {
  role: string
  content?: string | null
}): boolean {
  return message.role === 'user' && Boolean(message.content?.startsWith(PROJECT_INSTRUCTIONS_FRAME))
}
