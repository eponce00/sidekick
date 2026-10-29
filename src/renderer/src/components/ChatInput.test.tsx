// @vitest-environment jsdom

import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatInput } from './ChatInput'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ChatInputProps = React.ComponentProps<typeof ChatInput>

function baseProps(overrides: Partial<ChatInputProps> = {}): ChatInputProps {
  return {
    inputValue: '',
    attachedImages: [],
    attachedContext: [],
    attachmentError: null,
    visionAvailable: true,
    isLoading: false,
    isStopping: false,
    editingMessageId: null,
    researchSelected: false,
    researchActive: false,
    researchPhase: 'idle',
    researchAvailable: true,
    planSelected: false,
    planActive: false,
    planAvailable: true,
    planningModelId: '',
    planningModels: [],
    executorModelName: 'Qwen',
    goal: null,
    goalArmed: false,
    goalAvailable: true,
    reasoningOptions: { levels: ['on', 'off'], initial: 'on' },
    reasoningLevel: 'off',
    isFeaturesMenuOpen: true,
    isModelMenuOpen: false,
    selectedModel: '',
    pinnedModels: [],
    queuedMessages: [],
    pivotMessage: null,
    inputRef: createRef<HTMLTextAreaElement>(),
    featuresMenuRef: createRef<HTMLDivElement>(),
    modelMenuRef: createRef<HTMLDivElement>(),
    onInputChange: vi.fn(),
    onAddImageFiles: vi.fn(),
    onAddFiles: vi.fn(),
    onAddContextAttachments: vi.fn(),
    onAddPastedText: vi.fn(),
    onInsertPastedText: vi.fn(),
    onRemoveImage: vi.fn(),
    onRemoveContextAttachment: vi.fn(),
    onKeyDown: vi.fn(),
    onSendMessage: vi.fn(),
    onStopGeneration: vi.fn(),
    onToggleResearch: vi.fn(),
    onTogglePlan: vi.fn(),
    onPlanModelChange: vi.fn(),
    onToggleGoal: vi.fn(),
    onPauseGoal: vi.fn(),
    onResumeGoal: vi.fn(),
    onClearGoal: vi.fn(),
    onReasoningLevelChange: vi.fn(),
    onToggleFeaturesMenu: vi.fn(),
    onToggleModelMenu: vi.fn(),
    onModelChange: vi.fn(),
    onOpenModelSearch: vi.fn(),
    workspaceFolder: 'C:\\work\\sidekick',
    onOpenWorkspace: vi.fn(),
    onOpenWorkspaceMemory: vi.fn(),
    workspaceMemoryAvailable: true,
    onEditQueuedMessage: vi.fn(),
    onRemovePendingMessage: vi.fn(),
    onMoveQueuedMessage: vi.fn(),
    onSteerQueuedMessage: vi.fn(),
    instructionSources: ['AGENTS.md', 'packages/desktop/AGENTS.md'],
    instructionsTruncated: false,
    ...overrides
  }
}

describe('ChatInput add menu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const menuButton = (label: string): HTMLButtonElement => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('.features-menu-action')].find(
      (candidate) =>
        candidate.querySelector('.features-menu-item-label')?.textContent?.trim() === label
    )
    if (!button) throw new Error(`Could not find add-menu action: ${label}`)
    return button
  }

  it('explains disabled actions and does not show project-only context without a project', async () => {
    const props = baseProps({
      workspaceFolder: null,
      visionAvailable: false,
      visionUnavailableReason: 'This model cannot inspect images',
      goalAvailable: false,
      goalUnavailableReason: 'Finish the current goal first',
      planAvailable: false,
      planUnavailableReason: 'Planning is unavailable while running',
      researchAvailable: false,
      researchUnavailableReason: 'Configure web search first'
    })
    await act(async () => root.render(<ChatInput {...props} />))

    expect(menuButton('Open project folder').disabled).toBe(false)
    expect(container.textContent).not.toContain('Shared project notes')

    for (const label of ['Image from computer', 'Ongoing goal', 'Plan first', 'Research report']) {
      expect(menuButton(label).disabled).toBe(true)
    }
  })

  it('keeps shared notes unavailable until the current project notes finish loading', async () => {
    const props = baseProps({
      workspaceMemoryAvailable: false,
      workspaceMemoryUnavailableReason: 'Loading shared project notes…'
    })
    await act(async () => root.render(<ChatInput {...props} />))

    expect(menuButton('Shared project notes').disabled).toBe(true)
  })
})

describe('ChatInput goal banner', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  const goal = {
    id: 'goal-1',
    conversationId: 'conversation-1',
    objective: 'Ship the settings page',
    status: 'active' as const,
    revision: 1,
    continuationCount: 2,
    promptTokens: 0,
    completionTokens: 0,
    blockedStreak: 0,
    plan: [],
    createdAt: 1,
    updatedAt: 1
  }

  it('offers pause on a running goal and resume, not pause, once it has stopped', async () => {
    const labels = (): Array<string | null> =>
      [...container.querySelectorAll('.goal-mode-bar button')].map((button) =>
        button.getAttribute('aria-label')
      )
    await act(async () => root.render(<ChatInput {...baseProps({ goal })} />))
    expect(labels()).toEqual(['Pause goal', 'Drop goal'])
    await act(async () =>
      root.render(<ChatInput {...baseProps({ goal: { ...goal, status: 'paused' } })} />)
    )
    expect(labels()).toEqual(['Resume goal', 'Drop goal'])
  })
})

describe('ChatInput long pastes', () => {
  let container: HTMLDivElement
  let root: Root
  const longText = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function paste(text: string): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [], getData: (type: string) => (type === 'text/plain' ? text : '') }
    })
    container.querySelector('textarea.message-input')!.dispatchEvent(event)
    return event
  }

  it('attaches a long paste instead of inserting it', async () => {
    const onAddPastedText = vi.fn()
    await act(async () => root.render(<ChatInput {...baseProps({ onAddPastedText })} />))

    const shortPaste = paste('a short sentence')
    expect(shortPaste.defaultPrevented).toBe(false)
    expect(onAddPastedText).not.toHaveBeenCalled()

    const longPaste = paste(longText)
    expect(longPaste.defaultPrevented).toBe(true)
    expect(onAddPastedText).toHaveBeenCalledWith(longText)
  })

  it('pastes long text inline with Ctrl+Shift+V, also while editing a message', async () => {
    const onAddPastedText = vi.fn()
    await act(async () => root.render(<ChatInput {...baseProps({ onAddPastedText })} />))
    const input = container.querySelector('textarea.message-input')!
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true })
    )
    expect(paste(longText).defaultPrevented).toBe(false)
    // The bypass covers one paste only.
    expect(paste(longText).defaultPrevented).toBe(true)

    onAddPastedText.mockClear()
    await act(async () =>
      root.render(<ChatInput {...baseProps({ onAddPastedText, editingMessageId: 'message-1' })} />)
    )
    // An edited message is in the box like any draft, so a long paste becomes an attachment.
    expect(paste(longText).defaultPrevented).toBe(true)
    expect(onAddPastedText).toHaveBeenCalledOnce()
  })

  it('shows the edit it holds, and cancels it with Escape or Cancel', async () => {
    const onCancelEdit = vi.fn()
    await act(async () =>
      root.render(<ChatInput {...baseProps({ editingMessageId: 'message-1', onCancelEdit })} />)
    )
    const bar = container.querySelector('.composer-editing-bar')!
    const input = container.querySelector<HTMLTextAreaElement>('textarea.message-input')!
    expect(input.disabled).toBe(false)
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCancelEdit).toHaveBeenCalledOnce()
    await act(async () => bar.querySelector('button')!.click())
    expect(onCancelEdit).toHaveBeenCalledTimes(2)
  })
})

describe('ChatInput prompt history', () => {
  let container: HTMLDivElement
  let root: Root
  const history = [
    { id: 'm1', prompt: 'first prompt' },
    { id: 'm2', prompt: 'second prompt' }
  ]

  function Harness({ initial = '' }: { initial?: string }): React.JSX.Element {
    const [value, setValue] = useState(initial)
    return (
      <ChatInput
        {...baseProps({
          inputValue: value,
          onInputChange: setValue,
          isFeaturesMenuOpen: false,
          getPromptHistory: () => history
        })}
      />
    )
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // The command menu lists saved prompts when it opens.
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { workspace: { listPrompts: vi.fn(async () => ({ ok: true, prompts: [] })) } }
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const input = (): HTMLTextAreaElement => container.querySelector('textarea.message-input')!

  async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    await act(async () => {
      input().dispatchEvent(event)
    })
    return event
  }

  it('recalls earlier prompts with ArrowUp and restores the draft with ArrowDown', async () => {
    await act(async () => root.render(<Harness initial="draft" />))
    input().setSelectionRange(0, 0)

    expect((await press('ArrowUp')).defaultPrevented).toBe(true)
    expect(input().value).toBe('second prompt')
    await press('ArrowUp')
    expect(input().value).toBe('first prompt')
    await press('ArrowDown')
    expect(input().value).toBe('second prompt')
    await press('ArrowDown')
    expect(input().value).toBe('draft')
    expect((await press('ArrowDown')).defaultPrevented).toBe(false)
  })

  it('leaves the caret alone mid-text, with modifiers, and while composing', async () => {
    await act(async () => root.render(<Harness initial={'line one\nline two'} />))
    input().setSelectionRange(12, 12)
    expect((await press('ArrowUp')).defaultPrevented).toBe(false)
    input().setSelectionRange(0, 0)
    expect((await press('ArrowUp', { shiftKey: true })).defaultPrevented).toBe(false)
    expect((await press('ArrowUp', { altKey: true })).defaultPrevented).toBe(false)
    expect((await press('ArrowUp', { isComposing: true })).defaultPrevented).toBe(false)
    expect(input().value).toBe('line one\nline two')
  })

  it('lets the command menu keep its arrow keys', async () => {
    await act(async () => root.render(<Harness initial="/" />))
    input().setSelectionRange(0, 0)
    await press('ArrowUp')
    expect(input().value).toBe('/')
  })
})
