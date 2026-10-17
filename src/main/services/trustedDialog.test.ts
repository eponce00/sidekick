import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
  nativeTheme: { shouldUseDarkColors: true }
}))

import { dialog } from 'electron'
import { showTrustedDialog, trustedDialogPage } from './trustedDialog'

const settingsOptions = {
  type: 'warning' as const,
  title: 'Confirm security-sensitive settings',
  message: 'Apply security-sensitive settings?',
  detail: 'Full access lets <b>agents</b> run without asking.',
  buttons: ['Cancel', 'Apply settings'],
  defaultId: 0,
  cancelId: 0
}

describe('SideKick-styled trusted dialog', () => {
  it('shows text as text, never as markup', () => {
    const page = trustedDialogPage(settingsOptions, 'dark')
    expect(page).toContain('Full access lets &lt;b&gt;agents&lt;/b&gt; run without asking.')
    expect(page).not.toContain('<b>agents</b>')
  })

  it('allows only its own script', () => {
    const page = trustedDialogPage(settingsOptions, 'light')
    const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]
    const hash = createHash('sha256').update(script).digest('base64')
    expect(page).toContain(`script-src 'sha256-${hash}'`)
    expect(page).toContain("default-src 'none'")
  })

  it('puts Cancel on the left, focuses the safe default, and marks the main action', () => {
    const page = trustedDialogPage(settingsOptions, 'dark')
    const buttons = [
      ...page.matchAll(
        /<button type="button" data-index="(\d)" class="([^"]*)"( autofocus)?>([^<]*)</g
      )
    ]
    expect(buttons.map((button) => [button[4], button[2], Boolean(button[3])])).toEqual([
      ['Cancel', '', true],
      ['Apply settings', 'primary', false]
    ])
  })

  it('marks the default as the main action when it is not Cancel', () => {
    const page = trustedDialogPage(
      { message: 'Install?', buttons: ['Restart and update', 'Later'], defaultId: 0, cancelId: 1 },
      'dark'
    )
    const buttons = [...page.matchAll(/data-index="(\d)" class="([^"]*)"/g)]
    expect(buttons.map((button) => [button[1], button[2]])).toEqual([
      ['1', ''],
      ['0', 'primary']
    ])
  })

  it('falls back to the system dialog without a visible window to attach to', async () => {
    await showTrustedDialog(null, settingsOptions)
    expect(dialog.showMessageBox).toHaveBeenCalledWith(settingsOptions)
  })
})
