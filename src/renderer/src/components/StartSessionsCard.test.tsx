// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartSessionsCardRequest } from '../../../shared/sessions'
import AgentInteractionCard from './AgentInteractionCard'
import { chooseSelectOption } from './Select.testing'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const request: StartSessionsCardRequest = {
  intent: 'start_sessions',
  managerConversationId: 'manager',
  projects: [
    { id: 'project', name: 'sidekick' },
    { id: 'other', name: 'sidekick-api' }
  ],
  sessions: [
    {
      title: 'Port schedules',
      handle: 'schedules',
      brief: 'Port it',
      projectId: 'project',
      projectName: 'sidekick',
      workIn: 'worktree',
      modelId: 'm',
      modelName: 'Claude Sonnet',
      context: 'fresh',
      needsGrant: false
    },
    {
      title: 'Contract tests',
      handle: 'api-contract',
      brief: 'Add tests',
      projectId: 'other',
      projectName: 'sidekick-api',
      workIn: 'worktree',
      modelId: 'm',
      modelName: 'Claude Sonnet',
      context: 'fresh',
      needsGrant: true
    }
  ]
}

describe('StartSessionsCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (status: 'pending' | 'resolved', onResolve = vi.fn(), response?: object) =>
    act(() =>
      root.render(
        <AgentInteractionCard
          interaction={{
            id: 'interaction',
            kind: 'question',
            status,
            request: request as unknown as Record<string, unknown>,
            ...(response ? { response: response as Record<string, unknown> } : {})
          }}
          onResolve={onResolve}
        />
      )
    )

  it('lists each chat, names the project it allows, and starts with the user’s changes', async () => {
    const onResolve = vi.fn()
    render('pending', onResolve)
    // A chat that needs a grant says which project starting it allows.
    expect(container.textContent).toContain('starting allows it to use sidekick-api')

    const workIn = container.querySelector<HTMLElement>(
      '.ui-select[aria-label="Where schedules works"]'
    )!
    await chooseSelectOption(workIn, 'read-only')
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Start 2 chats')
    )!
    await act(async () => start.click())
    expect(onResolve).toHaveBeenCalledWith('interaction', {
      action: 'start',
      sessions: [{ workIn: 'read-only' }, {}]
    })
  })

  it('declines without starting anything', async () => {
    const onResolve = vi.fn()
    render('pending', onResolve)
    const notNow = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Not now'
    )!
    await act(async () => notNow.click())
    expect(onResolve).toHaveBeenCalledWith('interaction', { action: 'cancel' })
  })
})
