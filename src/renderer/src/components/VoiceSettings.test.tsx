// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({ level: () => 0.5, stop: vi.fn(async () => undefined) }))
const captureMicrophone = vi.hoisted(() => vi.fn(async () => capture))

vi.mock('../services/voice/microphone', () => ({
  captureMicrophone,
  listAudioDevices: async (kind: 'audioinput' | 'audiooutput') =>
    kind === 'audioinput'
      ? [{ deviceId: 'usb', label: 'USB Microphone' }]
      : [{ deviceId: 'desk', label: 'Desk Speakers' }]
}))

import { VoiceSettings } from './VoiceSettings'
import { selectOptions } from './Select.testing'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  captureMicrophone.mockClear()
  capture.stop.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function row(label: string): HTMLElement {
  const match = Array.from(container.querySelectorAll<HTMLElement>('.settings-row')).find(
    (candidate) => candidate.querySelector('.settings-row-label')?.textContent === label
  )
  expect(match, `${label} row`).toBeDefined()
  return match!
}

it('hides the device choices while voice is off', async () => {
  await act(async () => root.render(<VoiceSettings enabled={false} onEnabledChange={vi.fn()} />))
  expect(container.querySelector('h3')?.textContent).toBe('Voice')
  expect(container.textContent).toContain('Dictation and read-aloud')
  expect(container.textContent).not.toContain('Microphone')
})

it('gives each device row an icon, a labelled select, and its own test button', async () => {
  await act(async () => root.render(<VoiceSettings enabled onEnabledChange={vi.fn()} />))

  for (const [label, test] of [
    ['Microphone', 'Test microphone'],
    ['Speaker', 'Play a sample']
  ]) {
    const device = row(label)
    expect(device.querySelector('.settings-row-icon svg'), `${label} icon`).not.toBeNull()
    const select = device.querySelector('.ui-select')!
    expect(device.querySelector('label')?.htmlFor).toBe(select.id)
    const button = device.querySelector(`button[aria-label="${test}"]`)
    expect(button?.classList.contains('settings-secondary-action')).toBe(true)
    expect(button?.querySelector('svg')).not.toBeNull()
  }
  const microphones = await selectOptions(
    row('Microphone').querySelector<HTMLElement>('.ui-select')!
  )
  expect(microphones.find((option) => option.value === 'usb')?.label).toBe('USB Microphone')
})

it('tests the chosen microphone with a level meter under the row, then stops it', async () => {
  await act(async () => root.render(<VoiceSettings enabled onEnabledChange={vi.fn()} />))
  const microphone = row('Microphone')

  await act(async () =>
    microphone.querySelector<HTMLButtonElement>('button[aria-label="Test microphone"]')!.click()
  )
  expect(captureMicrophone).toHaveBeenCalledWith(expect.any(Function), '')
  expect(microphone.querySelector('.settings-row-detail [aria-label="Input level"]')).not.toBeNull()

  const stop = microphone.querySelector<HTMLButtonElement>(
    'button[aria-label="Stop microphone test"]'
  )!
  expect(stop.textContent).toBe('Stop')
  await act(async () => stop.click())
  expect(capture.stop).toHaveBeenCalledOnce()
  expect(microphone.querySelector('[aria-label="Input level"]')).toBeNull()
})
