// Opt-in failing regression for an unresolved ownership gap. No native GUI.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { EventEmitter } = require('node:events')
const { runInNewContext } = require('node:vm')
const { transformSync } = require('esbuild')

for (const eventKind of ['keyboard', 'mouse']) {
  test(
    `pending CDP mouse input must not exempt unrelated physical ${eventKind}`,
    {
      skip: process.env.SIDEKICK_INPUT_EXEMPTION_REPRO !== '1'
    },
    async () => {
      const module = { exports: {} }
      const source = readFileSync(
        join(__dirname, '../src/main/services/browserViewHost.ts'),
        'utf8'
      )
      runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
        module,
        exports: module.exports
      })
      const api = module.exports
      const contents = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false })
      const view = { webContents: contents, setBounds: () => {}, setVisible: () => {} }
      const parking = { contentView: { removeChildView: () => {} }, hide: () => {} }
      const host = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        contentView: { addChildView: () => {} }
      })
      let checked = 0
      api.registerBrowserView(view, parking)
      api.mountBrowserView(1, host, { x: 0, y: 0, width: 100, height: 100 }, () => {
        checked++
        return false
      })
      const physicalEvent = () => {
        let blocked = false
        const event = {
          preventDefault: () => {
            blocked = true
          }
        }
        if (eventKind === 'keyboard')
          contents.emit('before-input-event', event, { type: 'keyDown', key: 'x' })
        else
          contents.emit('before-mouse-event', event, {
            type: 'mouseDown',
            x: 90,
            y: 90,
            button: 'left'
          })
        return blocked
      }
      assert.equal(physicalEvent(), true, 'Ownership guard must work before the pending command')
      let finish
      // The injected gesture does not generate fixture events. These independently
      // emitted events model unrelated physical input while its acknowledgement stalls.
      const pending = api.browserDebuggerCommand(
        1,
        'Input.dispatchMouseEvent',
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      let during
      try {
        during = physicalEvent()
      } finally {
        finish()
        await pending
      }
      assert.equal(physicalEvent(), true, 'Guard must recover after acknowledgement')
      contents.emit('destroyed')
      console.info(JSON.stringify({ eventKind, guardChecks: checked, pendingEventBlocked: during }))
      assert.equal(
        during,
        true,
        'Pending synthetic command must not bypass unrelated physical input ownership'
      )
    }
  )
}
