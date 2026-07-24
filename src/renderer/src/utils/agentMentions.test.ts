import { describe, expect, it } from 'vitest'
import {
  activeAgentMentionAtCursor,
  filterAgentMentions,
  insertAgentMention,
  mentionedAgentIds,
  resolveGroupMessageRecipients,
  type AgentMentionCandidate
} from './agentMentions'

const agents: AgentMentionCandidate[] = [
  { id: 'data', label: 'Data agent', projectName: 'Cuba Data' },
  { id: 'web', label: 'Webpage agent', projectName: 'Dashboard' }
]

describe('group agent mentions', () => {
  it('recognizes a mention at the caret without treating email addresses as mentions', () => {
    expect(activeAgentMentionAtCursor('Ask @data', 9)).toEqual({ start: 4, end: 9, query: 'data' })
    expect(activeAgentMentionAtCursor('me@example.com', 6)).toBeNull()
    expect(activeAgentMentionAtCursor('Ask @data, then', 10)).toBeNull()
    expect(activeAgentMentionAtCursor('Ask @Data agent please', 22, agents)).toBeNull()
  })

  it('filters by agent and project names with the strongest matches first', () => {
    expect(filterAgentMentions(agents, 'web').map(({ id }) => id)).toEqual(['web'])
    expect(filterAgentMentions(agents, 'cuba').map(({ id }) => id)).toEqual(['data'])
    expect(filterAgentMentions(agents, '')).toEqual(agents)
  })

  it('replaces the active query and places the caret after a readable mention', () => {
    expect(
      insertAgentMention('Please ask @da', { start: 11, end: 14, query: 'da' }, agents[0])
    ).toEqual({ value: 'Please ask @Data agent ', cursor: 23 })
  })

  it('targets every visibly mentioned agent and ignores partial names', () => {
    expect(mentionedAgentIds('Ask @Data agent and @Webpage agent.', agents)).toEqual([
      'data',
      'web'
    ])
    expect(mentionedAgentIds('Ask @Data agents', agents)).toEqual([])
    expect(resolveGroupMessageRecipients('Ask @Data agent', agents, 'web')).toEqual(['data'])
    expect(resolveGroupMessageRecipients('Ask everyone', agents)).toEqual(['data', 'web'])
  })
})
