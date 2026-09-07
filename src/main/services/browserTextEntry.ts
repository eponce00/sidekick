export interface BrowserTextKeyEvent {
  type: 'keyDown' | 'keyUp'
  keyCode: string
  modifiers?: Array<'control' | 'meta'>
}

export interface BrowserTextEntryFailureTrace {
  stage: 'click' | 'validate' | 'select_all' | 'clear' | 'insert' | 'flush' | 'verify' | 'submit'
  validationsPassed: number
  keysDispatched: number
  insertDispatched: boolean
  insertAcknowledged: boolean
  /** A fulfilled insertText call does not establish DOM event receipt. */
  pageEventReceipt: 'unknown'
}

/** Target resolution, coordinates, session locks and navigation guards stay with
 * the browser service. This boundary owns only the ordered native text gesture. */
export interface BrowserTextEntryDriver {
  click(): Promise<void>
  assertTarget(): Promise<void>
  markPointer(): void
  sendKey(event: BrowserTextKeyEvent): void
  insert(text: string): Promise<void>
  flush(): Promise<void>
  verify?(): Promise<void>
  failed?(trace: Readonly<BrowserTextEntryFailureTrace>): Promise<void>
}

export async function enterBrowserText(
  input: {
    text: string
    clear: boolean
    submit?: boolean
    insertEmpty?: boolean
    platform: NodeJS.Platform
  },
  driver: BrowserTextEntryDriver
): Promise<void> {
  const trace: BrowserTextEntryFailureTrace = {
    stage: 'click',
    validationsPassed: 0,
    keysDispatched: 0,
    insertDispatched: false,
    insertAcknowledged: false,
    pageEventReceipt: 'unknown'
  }
  const validate = async (): Promise<void> => {
    trace.stage = 'validate'
    await driver.assertTarget()
    trace.validationsPassed++
  }
  const sendKey = (event: BrowserTextKeyEvent): void => {
    driver.sendKey(event)
    trace.keysDispatched++
  }
  try {
    await driver.click()
    await validate()
    driver.markPointer()
    if (input.clear) {
      const modifiers: Array<'control' | 'meta'> = [
        input.platform === 'darwin' ? 'meta' : 'control'
      ]
      trace.stage = 'select_all'
      sendKey({ type: 'keyDown', keyCode: 'A', modifiers })
      sendKey({ type: 'keyUp', keyCode: 'A', modifiers })
      // Keyboard handlers may navigate or redirect focus. Validate after each
      // renderer round trip, before clearing and again before inserting text.
      await driver.flush()
      await validate()
      trace.stage = 'clear'
      sendKey({ type: 'keyDown', keyCode: 'Backspace' })
      sendKey({ type: 'keyUp', keyCode: 'Backspace' })
      await driver.flush()
      await validate()
    }
    if (input.text || input.insertEmpty) {
      trace.stage = 'insert'
      trace.insertDispatched = true
      await driver.insert(input.text)
      trace.insertAcknowledged = true
    }
    trace.stage = 'flush'
    await driver.flush()
    trace.stage = 'verify'
    await driver.verify?.()
    if (input.submit) {
      trace.stage = 'submit'
      sendKey({ type: 'keyDown', keyCode: 'Enter' })
      sendKey({ type: 'keyUp', keyCode: 'Enter' })
      await driver.flush()
    }
  } catch (error) {
    // Diagnostics must never replace the original error or trigger another gesture.
    try {
      await driver.failed?.({ ...trace })
    } catch {
      /* best effort */
    }
    throw error
  }
}
