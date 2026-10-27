// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolExecutionCard } from './ToolExecutionCard'

describe('ToolExecutionCard', () => {
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
  })

  it('shows a finished command as its exit code and streams, and copies them as text', async () => {
    // The card showed the agent's copy of the result: one JSON line of escapes, cut in the middle.
    const copied: string[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copied.push(text)
            return { success: true }
          }
        }
      }
    })
    const stdout = Array.from({ length: 40 }, (_, line) => `RETR JOB${line}.LS OK`).join('\n')
    await act(async () => {
      root.render(
        <ToolExecutionCard
          tool={{
            id: 'shell-2',
            title: 'Download the job files',
            command: 'python fetch_jobs.py',
            status: 'success',
            presentation: { kind: 'terminal', title: 'Download the job files' },
            output: 'Exit code: 0\n<stdout>\n…',
            data: {
              success: true,
              exitCode: 0,
              stdout: `${stdout}\n`,
              stderr: 'warning: "passive" mode refused\n'
            },
            outputReference: { truncated: true, returnedBytes: 300, originalBytes: 900 }
          }}
        />
      )
    })
    await act(async () => {
      ;(container.querySelector('.tool-call-row') as HTMLButtonElement).click()
    })

    const streams = [...container.querySelectorAll('.command-result-stream')]
    expect(streams[0].textContent).toContain('RETR JOB0.LS OK')
    expect(streams[1].textContent).toContain('warning: "passive" mode refused')
    expect(container.textContent).not.toContain('\\n')
    await act(async () => {
      ;(container.querySelector('.command-result-bar .rich-tool-copy') as HTMLButtonElement).click()
    })
    expect(copied).toEqual([`${stdout}\n\nwarning: "passive" mode refused`])
  })
})
