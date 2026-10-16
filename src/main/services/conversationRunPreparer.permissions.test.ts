import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../shared/permissions'
import type { ProviderSettings } from '../../shared/settings'
import { openApplicationDatabase } from '../bootstrap/database'
import type { AgentToolRuntime } from './agentToolRuntime'
import { ConversationGoalStore } from './conversationGoalStore'
import { ConversationRunPreparer } from './conversationRunPreparer'

const databases: ReturnType<typeof openApplicationDatabase>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/** The permission mode a run's tools receive, stopping preparation right after. */
async function preparedMode(setting: PermissionMode, ceiling: string | null): Promise<unknown> {
  const db = openApplicationDatabase(':memory:')
  databases.push(db)
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, permission_ceiling)
     VALUES ('chat', 'Chat', 1, 1, ?)`
  ).run(ceiling)
  const createSession = vi.fn().mockRejectedValue(new Error('stop here'))
  const preparer = new ConversationRunPreparer(
    db,
    { createSession } as unknown as AgentToolRuntime,
    new ConversationGoalStore(db),
    () => ({ commandPermissionMode: setting }) as ProviderSettings,
    () => 'assets'
  )
  await expect(
    preparer.prepare(
      {
        id: 'run',
        conversationId: 'chat',
        assistantMessageId: 'reply',
        model: { id: 'model', name: 'model', provider: 'ollama' }
      },
      async () => undefined
    )
  ).rejects.toThrow('stop here')
  return createSession.mock.calls[0][0].permissionMode
}

describe('a chat permission ceiling', () => {
  it('narrows the setting for a scheduled chat and the chats it starts', async () => {
    expect(await preparedMode('full-access', 'always-ask')).toBe('always-ask')
    expect(await preparedMode('full-access', 'sensitive-only')).toBe('sensitive-only')
  })

  it('never widens the setting, and chats without one follow it', async () => {
    expect(await preparedMode('always-ask', 'full-access')).toBe('always-ask')
    expect(await preparedMode('sensitive-only', null)).toBe('sensitive-only')
    expect(await preparedMode('sensitive-only', 'not-a-mode')).toBe('sensitive-only')
  })
})
