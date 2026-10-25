import { describe, expect, it, vi } from 'vitest'
import { BROWSER_DEVICE_PRESETS } from '../../shared/browserDevices'
import { browserDeviceMenuTemplate } from './browserDeviceMenu'

const checked = (template: ReturnType<typeof browserDeviceMenuTemplate>): string[] =>
  template.filter((item) => item.checked).map((item) => String(item.label))

describe('browser device menu', () => {
  it('checks only the size in use, with no radio groups Electron would pre-check', () => {
    const preset = BROWSER_DEVICE_PRESETS.find(({ id }) => id === 'laptop-l')!
    const template = browserDeviceMenuTemplate(
      { ...preset, id: preset.id, source: 'user' },
      vi.fn()
    )
    expect(checked(template)).toEqual([`${preset.label}    ${preset.width} × ${preset.height}`])
    expect(template.some((item) => item.type === 'radio')).toBe(false)
  })

  it('checks Responsive when no size is fixed, and chooses what is clicked', () => {
    const choose = vi.fn()
    const template = browserDeviceMenuTemplate(null, choose)
    expect(checked(template)).toEqual(['Responsive (fit the panel)'])
    const phone = template.find((item) => String(item.label).startsWith('iPhone SE'))!
    phone.click?.({} as never, undefined, {} as never)
    expect(choose).toHaveBeenCalledWith('iphone-se')
  })

  it('shows a size the agent set as the checked, unselectable entry', () => {
    const template = browserDeviceMenuTemplate(
      { id: 'custom', label: '1000 × 700', width: 1000, height: 700, source: 'agent' },
      vi.fn()
    )
    expect(checked(template)).toEqual(['1000 × 700, set by the agent'])
  })

  it('leads with the page’s zoom and its steps', () => {
    const step = vi.fn()
    const template = browserDeviceMenuTemplate(null, vi.fn(), { percent: 100, step })
    expect(template[0]).toMatchObject({ label: 'Zoom 100%', enabled: false })
    const item = (label: string) => template.find((entry) => entry.label === label)!
    expect(item('Actual size').enabled).toBe(false)
    item('Zoom in').click?.({} as never, undefined, {} as never)
    expect(step).toHaveBeenCalledWith('in')
    expect(
      browserDeviceMenuTemplate(null, vi.fn(), { percent: 300, step }).find(
        (entry) => entry.label === 'Zoom in'
      )?.enabled
    ).toBe(false)
  })
})
