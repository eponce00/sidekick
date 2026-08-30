// @vitest-environment jsdom

import { act, createRef } from 'react'
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
    isCompacting: false,
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
    goalAvailable: true,
    thinkingEnabled: false,
    thinkingAvailable: true,
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
    onAddContextAttachments: vi.fn(),
    onRemoveImage: vi.fn(),
    onRemoveContextAttachment: vi.fn(),
    onKeyDown: vi.fn(),
    onSendMessage: vi.fn(),
    onStopGeneration: vi.fn(),
    onToggleResearch: vi.fn(),
    onTogglePlan: vi.fn(),
    onPlanModelChange: vi.fn(),
    onOpenGoal: vi.fn(),
    onEditGoal: vi.fn(),
    onPauseGoal: vi.fn(),
    onResumeGoal: vi.fn(),
    onClearGoal: vi.fn(),
    onToggleThinking: vi.fn(),
    onToggleFeaturesMenu: vi.fn(),
    onToggleModelMenu: vi.fn(),
    onModelChange: vi.fn(),
    onOpenModelSearch: vi.fn(),
    workspaceFolder: 'C:\\work\\sidekick',
    onOpenWorkspace: vi.fn(),
    onOpenWorkspaceMemory: vi.fn(),
    workspaceMemoryAvailable: true,
    onUpdatePendingMessage: vi.fn(() => true),
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

  it('keeps the add menu compact while exposing plain-language help on hover', async () => {
    await act(async () => root.render(<ChatInput {...baseProps()} />))

    expect(
      [...container.querySelectorAll('.features-menu-section-label')].map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Add', 'Project context', 'Agent behavior'])

    expect(menuButton('Files and folders').textContent?.trim()).toBe('Files and folders')
    expect(menuButton('Files and folders').title).toContain('current project')
    expect(menuButton('Image from computer').textContent?.trim()).toBe('Image from computer')
    expect(menuButton('Image from computer').title).toContain('Attach a PNG, JPEG, WebP, or GIF')
    expect(menuButton('Change project folder').title).toContain(
      'Choose the files SideKick can read and change'
    )
    expect(menuButton('Shared project notes').title).toContain('included in every chat')
    expect(menuButton('Ongoing goal').title).toContain('across messages')
    expect(menuButton('Plan first').title).toContain('before SideKick changes project files')
    expect(menuButton('Research report').title).toContain('cross-check')
    expect(menuButton('Model thinking').title).toContain('reasoning mode')

    const instructions = container.querySelector('.features-menu-status') as HTMLDivElement
    expect(instructions.textContent?.trim()).toBe('Instruction files (AGENTS.md)')
    expect(instructions.getAttribute('aria-label')).toContain(
      '2 instruction files loaded automatically'
    )
    expect(instructions.title).toContain('AGENTS.md')
    expect(instructions.title).toContain('packages/desktop/AGENTS.md')
    expect(instructions.closest('button')).toBeNull()
  })

  it('runs every available action and closes the menu after choosing it', async () => {
    const props = baseProps()
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    await act(async () => root.render(<ChatInput {...props} />))

    const actions: Array<[string, keyof ChatInputProps | 'image']> = [
      ['Files and folders', 'onAddContextAttachments'],
      ['Image from computer', 'image'],
      ['Change project folder', 'onOpenWorkspace'],
      ['Shared project notes', 'onOpenWorkspaceMemory'],
      ['Ongoing goal', 'onOpenGoal'],
      ['Plan first', 'onTogglePlan'],
      ['Research report', 'onToggleResearch'],
      ['Model thinking', 'onToggleThinking']
    ]

    for (const [label, callback] of actions) {
      await act(async () => menuButton(label).click())
      if (callback === 'image') expect(inputClick).toHaveBeenCalledTimes(1)
      else expect(props[callback]).toHaveBeenCalledTimes(1)
    }
    expect(props.onToggleFeaturesMenu).toHaveBeenCalledTimes(actions.length)
  })

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
    expect(container.textContent).not.toContain('Instruction files (AGENTS.md)')

    const disabled = [
      ['Image from computer', 'This model cannot inspect images'],
      ['Ongoing goal', 'Finish the current goal first'],
      ['Plan first', 'Planning is unavailable while running'],
      ['Research report', 'Configure web search first']
    ] as const
    for (const [label, reason] of disabled) {
      const button = menuButton(label)
      expect(button.disabled).toBe(true)
      expect(button.title).toBe(reason)
      expect(button.textContent?.trim()).toBe(label)
      expect(button.getAttribute('aria-label')).toContain(reason)
    }
  })

  it('keeps shared notes unavailable until the current project notes finish loading', async () => {
    const props = baseProps({
      workspaceMemoryAvailable: false,
      workspaceMemoryUnavailableReason: 'Loading shared project notes…'
    })
    await act(async () => root.render(<ChatInput {...props} />))

    const notes = menuButton('Shared project notes')
    expect(notes.disabled).toBe(true)
    expect(notes.title).toBe('Loading shared project notes…')
    expect(notes.textContent?.trim()).toBe('Shared project notes')
    expect(notes.getAttribute('aria-label')).toContain('Loading shared project notes…')
  })
})
