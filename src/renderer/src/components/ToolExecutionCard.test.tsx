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

  it('renders a typed terminal command and bounded result details', async () => {
    await act(async () => {
      root.render(
        <ToolExecutionCard
          tool={{
            id: 'shell-1',
            title: 'Run checks',
            command: 'npm test',
            status: 'running',
            presentation: { kind: 'terminal', title: 'Run checks' },
            output: 'All checks passed'
          }}
        />
      )
    })

    expect(container.querySelector('.rich-tool-command')).toBeNull()
    await act(async () => {
      const button = container.querySelector('.tool-call-row') as HTMLButtonElement
      button.click()
    })
    expect(container.querySelector('.rich-tool-command')?.textContent).toContain('npm test')
    expect(container.querySelector('.rich-tool-output')?.textContent).toContain('All checks passed')
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

    expect(container.querySelector('.command-result-exit')?.textContent).toBe('Exit code 0')
    const streams = [...container.querySelectorAll('.command-result-stream')]
    expect(streams.map((stream) => stream.getAttribute('aria-label'))).toEqual(['stdout', 'stderr'])
    expect(streams[0].textContent).toContain('RETR JOB0.LS OK')
    expect(streams[0].textContent).toContain('… 20 lines omitted …')
    expect(streams[1].textContent).toContain('warning: "passive" mode refused')
    expect(container.textContent).not.toContain('\\n')
    expect(container.querySelector('.tool-execution-detail')?.textContent).toContain(
      "The agent was shown a shortened copy: 300 of 900 bytes. The command's own output was complete."
    )
    await act(async () => {
      ;(container.querySelector('.command-result-bar .rich-tool-copy') as HTMLButtonElement).click()
    })
    expect(copied).toEqual([`${stdout}\n\nwarning: "passive" mode refused`])
  })

  it('renders unified diffs and workspace-change totals', async () => {
    await act(async () => {
      root.render(
        <ToolExecutionCard
          tool={{
            id: 'diff-1',
            title: 'Update App.tsx',
            command: 'apply_patch',
            status: 'running',
            presentation: { kind: 'diff', title: 'Update App.tsx' },
            data: { diff: '@@ -1 +1 @@\n-old\n+new' },
            changes: [{ path: 'src/App.tsx', kind: 'update' }]
          }}
        />
      )
    })

    expect(container.querySelector('.rich-diff-block')).toBeNull()
    await act(async () => {
      const button = container.querySelector('.tool-call-row') as HTMLButtonElement
      button.click()
    })
    expect(container.querySelector('.rich-diff-block')?.textContent).toContain('+new')
    expect(container.querySelector('.rich-diff-footer')?.textContent).toContain('1 file')
    await act(async () => {
      const split = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Split'
      )!
      split.click()
    })
    expect(container.querySelector('.rich-diff-split')).not.toBeNull()
    expect(container.querySelectorAll('.rich-diff-split-cell')).toHaveLength(2)
  })
})
