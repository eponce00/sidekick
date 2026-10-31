// TEMP: says what the app looks like when a sidebar lookup stalls.
async function diagnosedClick(page, application, title) {
  const locator = page.getByText(title, { exact: true }).first()
  const started = Date.now()
  const first = await locator
    .click({ timeout: 6000 })
    .then(() => 'clicked')
    .catch((error) => error.message.slice(0, 300))
  if (first === 'clicked') {
    console.log('SIDEKICK_DIAG ok', title, Date.now() - started)
    return
  }
  const stall = (promise, label) =>
    Promise.race([
      promise,
      new Promise((done) => setTimeout(() => done(`${label} stalled`), 5000))
    ]).catch((error) => `${label} error: ${String(error.message).slice(0, 200)}`)
  const sample = async (label) => {
    const state = await stall(
      page.evaluate(async (wanted) => {
        const frames = await new Promise((done) => {
          let count = 0
          const tick = () => {
            count++
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
          setTimeout(() => done(count), 500)
        })
        return {
          frames,
          visibility: document.visibilityState,
          focus: document.hasFocus(),
          inner: [innerWidth, innerHeight],
          url: location.href,
          ready: document.readyState,
          innerTextHas: document.body.innerText.includes(wanted),
          htmlHas: document.body.innerHTML.includes(wanted),
          conversations: (await window.api.conversations.list()).map((c) => c.title),
          text: document.body.innerText.slice(0, 500)
        }
      }, title),
      'evaluate'
    )
    const count = await stall(page.getByText(title, { exact: true }).count(), 'count')
    const win = await stall(
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({
          bounds: w.getBounds(),
          visible: w.isVisible(),
          focused: w.isFocused(),
          url: w.webContents.getURL(),
          crashed: w.webContents.isCrashed()
        }))
      ),
      'windows'
    )
    console.log('SIDEKICK_DIAG', label, title, JSON.stringify({ state, count, win }))
  }
  console.log('SIDEKICK_DIAG first click failed', title, first)
  await sample('stalled')
  const shot = await stall(
    page.screenshot({ timeout: 4000, type: 'jpeg', quality: 30 }).then((b) => b.toString('base64')),
    'screenshot'
  )
  console.log('SIDEKICK_SHOT', shot)
  await stall(
    application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0]?.show()
      BrowserWindow.getAllWindows()[0]?.focus()
    }),
    'focus'
  )
  await new Promise((done) => setTimeout(done, 1000))
  await sample('after focus')
  const second = await page
    .getByText(title, { exact: true })
    .first()
    .click({ timeout: 6000 })
    .then(() => 'clicked')
    .catch((error) => error.message.slice(0, 300))
  console.log('SIDEKICK_DIAG second click', title, second)
  await sample('after second')
  throw new Error(`Stalled looking for ${title}`)
}
module.exports = { diagnosedClick }
