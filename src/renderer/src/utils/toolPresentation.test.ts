import { describe, expect, it } from 'vitest'
import {
  getCompactToolTitle,
  getToolApprovalLabel,
  getToolKind,
  getToolStatusLabel
} from './toolPresentation'

describe('tool presentation', () => {
  it('classifies built-in tools from stable names and legacy command strings', () => {
    expect(getToolKind({ name: 'read', command: 'read', title: 'Read' })).toBe('file-read')
    expect(getToolKind({ command: 'web_image_search("mountains")', title: 'Image search' })).toBe(
      'image-search'
    )
    expect(getToolKind({ command: 'npm test', title: 'Run tests' })).toBe('terminal')
    expect(getToolKind({ command: 'spawn_subagent', title: 'Sub-agent: audit' })).toBe('subagent')
    expect(
      getToolKind({ name: 'create_artifact', command: 'create_artifact', title: 'Creating page' })
    ).toBe('artifact')
    expect(getToolKind({ name: 'wait', command: 'wait', title: 'Wait 30s' })).toBe('wait')
  })

  it('provides concise state and approval copy', () => {
    expect(getToolStatusLabel('success')).toBe('Completed')
    expect(getToolStatusLabel('partial')).toBe('Partially completed')
    expect(getToolStatusLabel('error')).toBe('Failed')
    expect(getToolApprovalLabel({ accessLevel: 'confirm', approvalStatus: 'pending' })).toBe(
      'Approval needed'
    )
    expect(getToolApprovalLabel({ accessLevel: 'auto', approvalStatus: 'auto' })).toBeNull()
  })

  it('shortens web searches and reduces fetched pages to their domain', () => {
    const searchTitle = getCompactToolTitle({
      name: 'web_search',
      command: 'web_search("población Cuba 2024 2025 2026 and recent official statistics")',
      title: 'Searching: "población Cuba 2024 2025 2026 and recent official statistics"',
      status: 'success'
    })

    expect(searchTitle).toMatch(/^Searched “población Cuba/)
    expect(searchTitle).toBe('Searched “población Cuba 2024 2025 2026…”')
    expect(searchTitle.length).toBeLessThan(45)
    expect(
      getCompactToolTitle({
        name: 'web_fetch',
        command: 'web_fetch("https://worldpopulationreview.com/countries/cuba")',
        title: 'Fetching: https://worldpopulationreview.com/countries/cuba',
        status: 'success'
      })
    ).toBe('Read worldpopulationreview.com')
  })

  it('uses compact, consistent labels for the remaining built-in tool families', () => {
    expect(
      getCompactToolTitle({
        name: 'web_image_search',
        command: 'web_image_search("Cuba population chart")',
        title: 'Image search: "Cuba population chart"',
        status: 'running'
      })
    ).toBe('Finding images for “Cuba population chart”')
    expect(
      getCompactToolTitle({
        name: 'read',
        command: 'read',
        title: 'Reading /Users/demo/project/src/components/ChatPanel.tsx',
        input: { path: '/Users/demo/project/src/components/ChatPanel.tsx' },
        status: 'success'
      })
    ).toBe('Read …/components/ChatPanel.tsx')
    expect(
      getCompactToolTitle({
        name: 'search_workspace_files',
        command: 'search_workspace_files',
        title: 'Searching for tool-call-row',
        input: { regex: 'tool-call-row' },
        status: 'success'
      })
    ).toBe('Find “tool-call-row” in files')
    expect(
      getCompactToolTitle({
        command: 'spawn_subagent',
        title: 'Sub-agent: inspect the provider architecture',
        status: 'running'
      })
    ).toBe('Delegate · inspect the provider architecture')
    expect(
      getCompactToolTitle({
        command: 'context_compaction',
        title: 'Compacting context (threshold reached)',
        status: 'success'
      })
    ).toBe('Compact context')
    expect(
      getCompactToolTitle({
        name: 'shell',
        command: 'npm run check',
        title: 'Executing command',
        status: 'running'
      })
    ).toBe('Running command')
    expect(
      getCompactToolTitle({
        name: 'create_artifact',
        command: 'create_artifact',
        title: 'Creating dashboard',
        status: 'error'
      })
    ).toBe('Create dashboard')
    expect(
      getCompactToolTitle({
        name: 'wait',
        command: 'wait',
        title: 'Wait 30s',
        input: { seconds: 30, reason: 'Data agent is exporting files' },
        status: 'running'
      })
    ).toBe('Waiting 30s · Data agent is exporting files')
    expect(
      getCompactToolTitle({
        name: 'apply_patch',
        command: 'apply_patch',
        title: 'Applying project patch',
        status: 'running'
      })
    ).toBe('Applying project patch')
  })
})
