// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSessionSummary } from '../../../shared/terminalSessions'

const sessions = vi.hoisted(() => ({ current: [] as TerminalSessionSummary[] }))
/** What the fit addon proposes, call by call (the last one repeats), and what the terminal did. */
const fitState = vi.hoisted(() => ({
  proposals: [] as Array<{ cols: number; rows: number } | undefined>,
  fits: 0,
  openedIn: null as HTMLElement | null
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    loadAddon = (): void => undefined
    open = (element: HTMLElement): void => {
      fitState.openedIn = element
    }
    write = (): void => undefined
    focus = (): void => undefined
    selectAll = (): void => undefined
    getSelection(): string {
      return ''
    }
    clearSelection = (): void => undefined
    onData(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
    attachCustomKeyEventHandler = (): void => undefined
    dispose = (): void => undefined
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FitAddon {
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return fitState.proposals.length > 1 ? fitState.proposals.shift() : fitState.proposals[0]
    }
    fit(): void {
      fitState.fits += 1
    }
  }
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('../utils/terminalSessionStore', () => ({
  useTerminalSessions: () => sessions.current,
  subscribeTerminalOutput: () => () => undefined
}))
vi.mock('../utils/userTerminalStore', () => ({
  useUserTerminals: () => [],
  addUserTerminal: () => undefined,
  subscribeUserTerminalOutput: () => () => undefined
}))

import { TerminalPanel } from './TerminalPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const session = (fields: Partial<TerminalSessionSummary>): TerminalSessionSummary => ({
  id: 'id',
  runId: 'run',
  title: 'title',
  command: 'command',
  cwd: 'C:\\Projects\\sidekick',
  background: false,
  pty: true,
  state: 'running',
  startedAt: Date.now() - 4_000,
  outputLength: 0,
  tail: [],
  ...fields
})

describe('TerminalPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const stop = vi.fn()

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe = (): void => undefined
      disconnect = (): void => undefined
    } as unknown as typeof ResizeObserver
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: {
          read: vi.fn(async () => null),
          write: vi.fn(),
          stop,
          moveToBackground: vi.fn()
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    stop.mockReset()
  })

  it('lists each command once by title, and shows the selected command above its terminal', async () => {
    sessions.current = [
      session({
        id: 'done',
        title: 'Check the renderer',
        command: 'npm run typecheck',
        state: 'exited',
        exitCode: 0,
        endedAt: Date.now()
      }),
      session({
        id: 'prompt',
        title: 'Scaffold the docs',
        command: 'npx create-vite docs',
        state: 'waiting_for_input'
      })
    ]
    await act(async () => root.render(<TerminalPanel conversationId="chat" />))

    const rows = [...container.querySelectorAll('.terminal-panel-item-select')]
    expect(rows.map((row) => row.textContent)).toEqual([
      'Scaffold the docsNeeds input',
      'Check the renderer4s'
    ])
    // The command is the row's tooltip, not a second line.
    expect(rows[0].getAttribute('title')).toBe('npx create-vite docs\nWaiting for input')

    // A waiting command is shown first, with where to type its reply.
    expect(container.querySelector('.terminal-panel-command')?.textContent).toBe(
      '$npx create-vite docs'
    )
    expect(container.querySelector('.terminal-panel-status')?.textContent).toBe(
      'Waiting for input: click the terminal and type your replysidekick'
    )
    expect(container.querySelector('.terminal-panel-cwd')?.getAttribute('title')).toBe(
      'C:\\Projects\\sidekick'
    )

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop the command"]')!.click()
    )
    expect(stop).toHaveBeenCalledWith('prompt')

    await act(async () => (rows[1] as HTMLButtonElement).click())
    expect(container.querySelector('.terminal-panel-status')?.textContent).toBe('Finishedsidekick')
    // A finished command has nothing left to stop or move.
    expect(container.querySelector('button[aria-label="Stop the command"]')).toBeNull()
  })

  it('fits the terminal once xterm has measured it, inside the padded frame', async () => {
    // Right after opening, xterm has no cell size yet and the fit proposes nothing. A terminal
    // left there stayed at 80 columns, a narrow band in a wide panel, because its host's size
    // never changed again to prompt another fit.
    fitState.proposals = [undefined, undefined, { cols: 120, rows: 30 }]
    fitState.fits = 0
    sessions.current = [session({ id: 'live', state: 'running' })]
    await act(async () => root.render(<TerminalPanel conversationId="chat" />))
    expect(fitState.fits).toBe(0)
    await act(async () => {
      for (let frame = 0; frame < 4; frame++)
        await new Promise((done) => requestAnimationFrame(() => done(undefined)))
    })
    expect(fitState.fits).toBe(1)

    // The fit reads its host's size padding included, so the padding is on the frame around it.
    expect(fitState.openedIn?.className).toBe('terminal-panel-host')
    expect(fitState.openedIn?.parentElement?.className).toBe('terminal-panel-screen')
  })
})
