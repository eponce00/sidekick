import { expect, it } from 'vitest'
import type { ContentSegment } from '../types/chat.types'
import { artifactSlots } from './artifactSlots'

it('shows an edited artifact where it first appeared, in the same place while the edit runs', () => {
  const created: ContentSegment = {
    type: 'artifact',
    artifact: { type: 'react', title: 'Chart', code: 'v1', toolCallId: 'create-1' }
  }
  const editing: ContentSegment = {
    type: 'artifact',
    artifact: {
      type: 'react',
      title: '',
      code: '',
      isStreaming: true,
      toolCallId: 'edit-1',
      editing: true
    }
  }
  const edited: ContentSegment = {
    type: 'artifact',
    artifact: { type: 'react', title: 'Chart', code: 'v2', toolCallId: 'edit-1' }
  }

  const running = artifactSlots([created, editing])
  expect(running.get(editing)).toBeNull()
  expect(running.get(created)).toMatchObject({ code: 'v1', editing: true, isStreaming: true })

  const done = artifactSlots([created, edited])
  expect(done.get(edited)).toBeNull()
  expect(done.get(created)).toMatchObject({ code: 'v2', slotKey: 'create-1' })
})
