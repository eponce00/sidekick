// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSessionEvent, TerminalSessionSummary } from '../../../shared/terminalSessions'
import { CommandLiveView } from './CommandLiveView'
import { subscribeTerminalView } from '../utils/terminalSessionStore'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let emit: (event: TerminalSessionEvent) => void = () => undefined
const terminal = {
  list: vi.fn(async () => []),
  read: vi.fn(async () => null),
  stop: vi.fn(async () => ({ stopped: true })),
  moveToBackground: vi.fn(async () => ({ moved: true })),
  write: vi.fn(async () => ({ written: true })),
  onEvent: vi.fn((callback: (event: TerminalSessionEvent) => void) => {
    emit = callback
    return () => undefined
  })
}
Object.defineProperty(window, 'api', { configurable: true, value: { terminal } })

function session(overrides: Partial<TerminalSessionSummary>): TerminalSessionSummary {
  return {
    id: 'command',
    runId: 'run',
    conversationId: 'chat',
    toolCallId: 'call',
    title: 'Install',
    command: 'npx create-vite docs',
    cwd: 'C:\\project',
    background: false,
    pty: true,
    state: 'running',
    startedAt: 1,
    outputLength: 10,
    tail: ['Need to install the following packages:', 'Ok to proceed? (y)'],
    ...overrides
  }
}

describe('CommandLiveView', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<CommandLiveView toolCallId="call" />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('shows a running command live, with the controls of its terminal', async () => {
    expect(container.textContent).toBe('')
    await act(async () => emit({ type: 'session', session: session({}) }))

    expect(container.querySelector('.command-live-tail')?.textContent).toContain(
      'Ok to proceed? (y)'
    )
    const button = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes(label)
      ) as HTMLButtonElement
    await act(async () => button('Stop').click())
    expect(terminal.stop).toHaveBeenCalledWith('command')
    await act(async () => button('Background').click())
    expect(terminal.moveToBackground).toHaveBeenCalledWith('command')
    const opened: string[] = []
    const unsubscribe = subscribeTerminalView((id) => opened.push(id))
    await act(async () => button('Open in Terminal').click())
    unsubscribe()
    expect(opened).toEqual(['command'])
  })

  it('takes a reply when the command waits for input, and goes away when it ends', async () => {
    await act(async () =>
      emit({ type: 'session', session: session({ state: 'waiting_for_input' }) })
    )
    expect(container.textContent).toContain('Waiting for input')
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input, 'y')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }))
    )
    // A terminal's Enter is a carriage return.
    expect(terminal.write).toHaveBeenCalledWith('command', 'y\r')

    await act(async () =>
      emit({ type: 'session', session: session({ state: 'exited', exitCode: 0 }) })
    )
    expect(container.querySelector('.command-live')).toBeNull()
  })
})
