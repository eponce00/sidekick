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
      const split = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Split')!
      split.click()
    })
    expect(container.querySelector('.rich-diff-split')).not.toBeNull()
    expect(container.querySelectorAll('.rich-diff-split-cell')).toHaveLength(2)
  })
})
