// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedModel } from '../../../shared/models'
import type { Project } from '../../../shared/projects'
import type { PermissionMode } from '../../../shared/permissions'
import type { Schedule, ScheduleRun } from '../../../shared/schedules'
import SchedulesDialog from './SchedulesDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const projects: Project[] = [
  { id: 'p1', name: 'alpha', folder_path: 'C:\\alpha', is_pinned: 0, created_at: 1, updated_at: 1 }
]
const models: PinnedModel[] = [{ id: 'ollama:local/qwen', name: 'Qwen', provider: 'ollama' }]

const schedule: Schedule = {
  id: 's1',
  name: 'Nightly review',
  prompt: 'Review today.',
  projectId: 'p1',
  modelId: 'ollama:local/qwen',
  cadence: 'daily',
  hour: 22,
  minute: 0,
  weekday: 1,
  catchUp: true,
  enabled: true,
  nextRunAt: Date.now() + 3_600_000,
  runCount: 0,
  createdAt: 1,
  updatedAt: 1
}

describe('SchedulesDialog', () => {
  let container: HTMLDivElement
  let root: Root
  let api: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    api = {
      create: vi.fn(async (input) => ({ ...schedule, ...input, id: 'new' })),
      update: vi.fn(async (input) => ({ ...schedule, ...input })),
      pause: vi.fn(async () => ({ ...schedule, enabled: false, nextRunAt: null })),
      resume: vi.fn(),
      delete: vi.fn(async () => ({ success: true })),
      runNow: vi.fn(async () => ({
        id: 'r',
        scheduleId: 's1',
        scheduledFor: 1,
        outcome: 'skipped',
        trigger: 'manual',
        late: false,
        reason: 'Skipped: the previous run is still waiting for your approval.'
      })),
      runs: vi.fn(async () => [])
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { schedules: api }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const render = async (
    schedules: Schedule[],
    permissionMode: PermissionMode = 'full-access',
    onOpenConversation = vi.fn()
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <SchedulesDialog
          isOpen
          schedules={schedules}
          projects={projects}
          models={models}
          defaultModelId="ollama:local/qwen"
          defaultProjectId="p1"
          permissionMode={permissionMode}
          onClose={vi.fn()}
          onOpenConversation={onOpenConversation}
        />
      )
    })
  }

  const button = (label: string): HTMLButtonElement =>
    [...container.ownerDocument.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label
    ) as HTMLButtonElement

  it('creates a schedule from a suggestion with its preset and time', async () => {
    await render([])
    // The suggestion's text includes a locale-formatted clock, so find it by name.
    const suggestion = [...container.querySelectorAll('.schedules-template')].find((node) =>
      node.textContent?.includes('Dependency check')
    ) as HTMLButtonElement
    await act(async () => suggestion.click())
    const weekly = container.querySelector('[role="radio"][aria-checked="true"]')
    expect(weekly?.textContent).toBe('Weekly')
    await act(async () => button('Create schedule').click())
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Dependency check',
        cadence: 'weekly',
        weekday: 1,
        hour: 8,
        minute: 0,
        projectId: 'p1',
        modelId: 'ollama:local/qwen',
        catchUp: true,
        permissionCeiling: 'full-access'
      })
    )
  })

  it('offers only limits at least as strict as the permission setting', async () => {
    await render([], 'sensitive-only')
    await act(async () => button('New schedule').click())
    const select = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Without asking, runs may'))!
      .querySelector('select')!
    expect(select.value).toBe('sensitive-only')
    expect([...select.options].map((option) => option.value)).toEqual([
      'always-ask',
      'sensitive-only'
    ])
  })

  it('lists the chats a run started under the run, and opens one', async () => {
    const run: ScheduleRun = {
      id: 'r1',
      scheduleId: 's1',
      runNumber: 1,
      scheduledFor: 1,
      startedAt: 1,
      outcome: 'started',
      trigger: 'schedule',
      late: false,
      conversationId: 'chat-1',
      agentPhase: 'completed',
      workers: [
        {
          conversationId: 'w1',
          handle: 'docs-check',
          title: 'Check docs',
          agentPhase: 'awaiting_permission'
        }
      ]
    }
    api.runs.mockResolvedValue([run])
    const onOpenConversation = vi.fn()
    await render([schedule], 'full-access', onOpenConversation)
    await act(async () => button('Runs (0)').click())
    const workers = container.querySelector('.schedule-run-workers')!
    expect(workers.textContent).toContain('docs-check')
    expect(workers.textContent).toContain('Waiting for your approval')
    await act(async () => button('Open docs-check').click())
    expect(onOpenConversation).toHaveBeenCalledWith('w1')
  })

  it('switches presets, and asks only for the minute when hourly', async () => {
    await render([])
    await act(async () => button('New schedule').click())
    expect(container.querySelector('input[type="time"]')).not.toBeNull()
    await act(async () => button('Hourly').click())
    expect(container.querySelector('input[type="time"]')).toBeNull()
    expect(container.textContent).toContain('Minute past the hour')
  })

  it('pauses a schedule and explains a run that did not start', async () => {
    await render([schedule])
    expect(container.textContent).toContain('Daily at')
    await act(async () => button('Pause Nightly review').click())
    expect(api.pause).toHaveBeenCalledWith('s1')
    await act(async () => button('Run Nightly review now').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Skipped: the previous run is still waiting for your approval.'
    )
  })

  it('confirms before deleting', async () => {
    await render([schedule])
    await act(async () => button('Delete Nightly review').click())
    expect(api.delete).not.toHaveBeenCalled()
    await act(async () => button('Delete').click())
    expect(api.delete).toHaveBeenCalledWith('s1')
  })
})
