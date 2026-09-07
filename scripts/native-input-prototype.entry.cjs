// Investigation only: no production dispatch changes, retries, or OS-window focus.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { tmpdir } = require('node:os')
const { relative } = require('node:path')

if (process.env.SIDEKICK_NATIVE_INPUT_PROTOTYPE !== '1') app.exit(0)
const profile = process.env.SIDEKICK_NATIVE_INPUT_PROFILE
assert.ok(profile, 'Launch through run-native-input-prototype.cjs')
const inside = relative(tmpdir(), profile)
assert.ok(inside.startsWith('sidekick-input-prototype-') && !inside.includes('..'))
app.setPath('userData', profile)
app.on('window-all-closed', () => {})

const html = `<!doctype html><html><body><input id="target" value="seed" style="position:absolute;left:20px;top:20px;width:200px;height:30px"><script>
window.receipts={down:0,before:0,input:0,controlA:0};
target.addEventListener('mousedown',()=>receipts.down++);
target.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='a'&&e.ctrlKey)receipts.controlA++});
target.addEventListener('beforeinput',e=>{receipts.before++;if(window.veto)e.preventDefault()});
target.addEventListener('input',()=>receipts.input++);
</script></body></html>`

async function main() {
  await app.whenReady()
  const results = []
  let window
  try {
    for (const visibility of ['hidden', 'shown-inactive']) {
      for (const driver of ['native', 'cdp']) {
        for (const scenario of ['replace', 'beforeinput-veto', 'electron-key-veto']) {
          window = new BrowserWindow({
            show: false,
            focusable: false,
            x: -32000,
            y: -32000,
            width: 600,
            height: 400,
            webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
          })
          const contents = window.webContents
          const intercepted = { keyboard: 0, mouse: 0 }
          contents.on('before-input-event', (event) => {
            intercepted.keyboard++
            if (scenario === 'electron-key-veto') event.preventDefault()
          })
          contents.on('before-mouse-event', () => intercepted.mouse++)
          await contents.loadURL('data:text/html,' + encodeURIComponent(html))
          if (visibility === 'shown-inactive') window.showInactive()
          assert.equal(window.isFocused(), false, 'Prototype must not focus a native window')
          await contents.executeJavaScript(`window.veto=${scenario === 'beforeinput-veto'}`)
          contents.focus() // Same content-only focus request as the production text path.
          if (driver === 'cdp') contents.debugger.attach('1.3')
          const send = (method, params) => contents.debugger.sendCommand(method, params)
          const mouse = async (type) => {
            if (driver === 'native')
              contents.sendInputEvent({ type, x: 100, y: 35, button: 'left', clickCount: 1 })
            else
              await send('Input.dispatchMouseEvent', {
                type: {
                  mouseMove: 'mouseMoved',
                  mouseDown: 'mousePressed',
                  mouseUp: 'mouseReleased'
                }[type],
                x: 100,
                y: 35,
                button: type === 'mouseMove' ? 'none' : 'left',
                clickCount: 1
              })
          }
          const key = async (type, keyCode, control = false) => {
            if (driver === 'native')
              contents.sendInputEvent({ type, keyCode, modifiers: control ? ['control'] : [] })
            else
              await send('Input.dispatchKeyEvent', {
                type: type === 'keyDown' ? 'keyDown' : 'keyUp',
                key: keyCode === 'A' ? 'a' : keyCode,
                code: keyCode === 'A' ? 'KeyA' : keyCode,
                windowsVirtualKeyCode: keyCode === 'A' ? 65 : 8,
                modifiers: control ? 2 : 0
              })
          }
          if (driver === 'native') {
            void mouse('mouseMove')
            void mouse('mouseDown')
            void mouse('mouseUp')
          } else {
            await mouse('mouseMove')
            await mouse('mouseDown')
            await mouse('mouseUp')
          }
          await contents.executeJavaScript('0')
          if (driver === 'native') {
            void key('keyDown', 'A', true)
            void key('keyUp', 'A', true)
          } else {
            await key('keyDown', 'A', true)
            await key('keyUp', 'A', true)
          }
          await contents.executeJavaScript('0')
          if (driver === 'native') {
            void key('keyDown', 'Backspace')
            void key('keyUp', 'Backspace')
          } else {
            await key('keyDown', 'Backspace')
            await key('keyUp', 'Backspace')
          }
          await contents.executeJavaScript('0')
          if (driver === 'native') await contents.insertText('fixture')
          else await send('Input.insertText', { text: 'fixture' })
          const state = await contents.executeJavaScript(
            `({exactReplacement:target.value==='fixture',unchanged:target.value==='seed',appended:target.value==='seedfixture',focused:document.activeElement===target,documentFocused:document.hasFocus(),...receipts})`
          )
          assert.equal(window.isFocused(), false, 'Input must not activate the native window')
          results.push({ visibility, driver, scenario, ...state, intercepted })
          window.destroy()
          window = undefined
        }
      }
    }
    console.log('SIDEKICK_INPUT_PROTOTYPE=' + JSON.stringify(results))
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    // The parent removes the profile after this process releases Chromium locks.
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.message)
    app.exit(1)
  }
)
