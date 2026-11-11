// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../types/app.types'
import {
  useConversationPanelRegistry,
  type ConversationPanelRegistry
} from './useConversationPanelRegistry'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const conversation = (id: string): Conversation => ({
  id,
  title: id,
  created_at: 1,
  updated_at: 1,
  project_id: id === 'a' ? 'project-a' : 'project-b',
  title_source: 'user',
  title_version: 1,
  sidebar_order: 0,
  project_context_version: 0,
  home_workspace_root: null,
  home_project_name: null
})

describe('useConversationPanelRegistry', () => {
  let root: Root
  let container: HTMLDivElement
  let registry: ConversationPanelRegistry
  const conversations = [conversation('a'), conversation('b')]

  // Reports that it stopped from its own cleanup, as a chat panel does.
  function Panel({
    onBusyStateChange
  }: Pick<ConversationPanelRegistry, 'onBusyStateChange'>): null {
    useEffect(() => () => onBusyStateChange('a', false), [onBusyStateChange])
    return null
  }

  function Harness({ currentId }: { currentId: string | null }): React.JSX.Element {
    const value = useConversationPanelRegistry(conversations, currentId)
    useEffect(() => {
      registry = value
    }, [value])
    return <Panel onBusyStateChange={value.onBusyStateChange} />
  }

  const render = async (currentId: string | null): Promise<void> => {
    await act(async () => root.render(<Harness currentId={currentId} />))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it('keeps a running conversation mounted after switching projects', async () => {
    await render('a')
    act(() => registry.onBusyStateChange('a', true))
    await render('b')

    expect(registry.mountedConversationIds).toEqual(['b', 'a'])
    expect(registry.currentConversationBusy).toBe(false)
  })

  it('releases a completed background panel after the queue hand-off window', async () => {
    await render('a')
    act(() => registry.onBusyStateChange('a', true))
    await render('b')
    act(() => registry.onBusyStateChange('a', false))

    expect(registry.mountedConversationIds).toEqual(['b', 'a'])
    act(() => vi.advanceTimersByTime(150))
    expect(registry.mountedConversationIds).toEqual(['b'])
  })

  it('starts no timer for a panel that stops as the whole view unmounts', async () => {
    await render('a')
    act(() => registry.onBusyStateChange('a', true))
    await act(async () => root.unmount())

    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(container)
  })
})
