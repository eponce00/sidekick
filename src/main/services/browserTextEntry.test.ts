import { expect, it } from 'vitest'
import { enterBrowserText, type BrowserTextEntryDriver } from './browserTextEntry'

function fixture(failAtValidation = 0, verificationError = false) {
  const events: string[] = []
  let validations = 0
  const driver: BrowserTextEntryDriver = {
    click: async () => {
      events.push('click')
    },
    assertTarget: async () => {
      events.push('validate')
      if (++validations === failAtValidation) throw new Error('focus changed')
    },
    markPointer: () => {
      events.push('pointer')
    },
    sendKey: (event) => {
      events.push(`${event.type}:${event.keyCode}:${event.modifiers?.join('+') || ''}`)
    },
    insert: async () => {
      events.push('insert')
    },
    flush: async () => {
      events.push('flush')
    },
    verify: async () => {
      events.push('verify')
      if (verificationError) throw new Error('not verified')
    }
  }
  return { driver, events }
}

it.each(['win32', 'linux', 'darwin'] as const)(
  'orders native replacement and verification before submit on %s',
  async (platform) => {
    const { driver, events } = fixture()
    await enterBrowserText({ text: 'synthetic', clear: true, submit: true, platform }, driver)
    const modifier = platform === 'darwin' ? 'meta' : 'control'
    expect(events).toEqual([
      'click',
      'validate',
      'pointer',
      `keyDown:A:${modifier}`,
      `keyUp:A:${modifier}`,
      'flush',
      'validate',
      'keyDown:Backspace:',
      'keyUp:Backspace:',
      'flush',
      'validate',
      'insert',
      'flush',
      'verify',
      'keyDown:Enter:',
      'keyUp:Enter:',
      'flush'
    ])
  }
)

it.each([1, 2, 3])('does not insert or retry after focus validation %i fails', async (position) => {
  const { driver, events } = fixture(position)
  await expect(
    enterBrowserText({ text: 'sensitive', clear: true, submit: true, platform: 'win32' }, driver)
  ).rejects.toThrow('focus changed')
  expect(events).not.toContain('insert')
  expect(events).not.toContain('keyDown:Enter:')
  expect(events.filter((event) => event === 'click')).toHaveLength(1)
})

it('never submits or retries when exact input verification fails', async () => {
  const { driver, events } = fixture(0, true)
  await expect(
    enterBrowserText({ text: 'text', clear: true, submit: true, platform: 'win32' }, driver)
  ).rejects.toThrow('not verified')
  expect(events.filter((event) => event === 'insert')).toHaveLength(1)
  expect(events).not.toContain('keyDown:Enter:')
})

it('append mode sends no destructive keyboard events', async () => {
  const { driver, events } = fixture()
  await enterBrowserText({ text: 'more', clear: false, platform: 'linux' }, driver)
  expect(events).toEqual(['click', 'validate', 'pointer', 'insert', 'flush', 'verify'])
})

it('supports clear-only form filling without an empty insert dispatch', async () => {
  const { driver, events } = fixture()
  await enterBrowserText({ text: '', clear: true, platform: 'win32' }, driver)
  expect(events).not.toContain('insert')
  expect(events).toContain('keyDown:Backspace:')
})

it('reports value-free insertion acknowledgement without implying page receipt', async () => {
  const { driver } = fixture(0, true)
  const traces: unknown[] = []
  driver.failed = async (trace) => {
    traces.push(trace)
  }
  await expect(
    enterBrowserText(
      { text: 'private-value', clear: true, submit: true, platform: 'win32' },
      driver
    )
  ).rejects.toThrow('not verified')
  expect(traces).toEqual([
    {
      stage: 'verify',
      validationsPassed: 3,
      keysDispatched: 4,
      insertDispatched: true,
      insertAcknowledged: true,
      pageEventReceipt: 'unknown'
    }
  ])
  expect(JSON.stringify(traces)).not.toContain('private-value')
})

it('does not run failure diagnostics on successful input', async () => {
  const { driver } = fixture()
  let called = false
  driver.failed = async () => {
    called = true
  }
  await enterBrowserText({ text: 'ok', clear: true, platform: 'win32' }, driver)
  expect(called).toBe(false)
})

it('preserves the original insertion failure even if diagnostics fail', async () => {
  const { driver, events } = fixture()
  const failure = new Error('native insertion rejected')
  driver.insert = async () => {
    throw failure
  }
  driver.failed = async (trace) => {
    expect(trace).toMatchObject({
      stage: 'insert',
      insertDispatched: true,
      insertAcknowledged: false
    })
    throw new Error('diagnostic unavailable')
  }
  await expect(
    enterBrowserText({ text: 'private', clear: true, submit: true, platform: 'win32' }, driver)
  ).rejects.toBe(failure)
  expect(events).not.toContain('keyDown:Enter:')
})
