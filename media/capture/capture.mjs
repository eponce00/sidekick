// Records the real app working through the scenes, as one video plus the moments each scene starts
// and ends, which the Remotion compositions cut from. Run `npm run build` in the repository first.
//
// Frames come straight from Chromium's screencast at twice the window's size, so text stays sharp
// when a composition zooms in; Playwright's own recorder is limited to a low bitrate.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, ROOT, SCALE, WINDOW } from './app.mjs'
import { startFakeModel } from './fake-model.mjs'
import { PROMPTS, SCENES } from './scenes.mjs'

const MEDIA = join(ROOT, 'media')
const CLIPS = join(MEDIA, 'public', 'clips')
const FRAMES = join(MEDIA, '.frames-capture')
const FPS = 30
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })
mkdirSync(CLIPS, { recursive: true })

const model = await startFakeModel({ model: 'sidekick-demo', scenes: SCENES })
const { app, page } = await launchApp({ modelUrl: model.url })
const pause = (ms) => page.waitForTimeout(ms)
await pause(1500)

// --- Screencast -------------------------------------------------------------------------------
const cdp = await page.context().newCDPSession(page)
const frames = []
let startedAt = 0
// Marks go by the clock since the first frame: frames come only when the screen changes.
let firstFrameWall = 0
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const at = metadata.timestamp * 1000
  startedAt ||= at
  firstFrameWall ||= Date.now()
  const file = `f${String(frames.length).padStart(6, '0')}.jpg`
  writeFileSync(join(FRAMES, file), Buffer.from(data, 'base64'))
  frames.push({ file, at: (at - startedAt) / 1000 })
  void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
})
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 92,
  maxWidth: WINDOW.width * SCALE,
  maxHeight: WINDOW.height * SCALE,
  everyNthFrame: 1
})
await pause(600)

const marks = {}
const mark = (name) => {
  marks[name] = firstFrameWall ? (Date.now() - firstFrameWall) / 1000 : 0
  console.log(`${name} at ${marks[name].toFixed(1)}s`)
}

async function type(text) {
  const box = page.locator('textarea').first()
  await box.click()
  await page.keyboard.type(text, { delay: 28 })
  await pause(350)
  await page.keyboard.press('Enter')
}

/** Waits until `count` messages show and the last has finished, then lets it settle. */
async function untilReplied(count, settleMs = 1800) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('.message').length >= count &&
      /Worked for/.test([...document.querySelectorAll('.message')].at(-1)?.innerText ?? ''),
    count,
    { timeout: 120_000 }
  )
  await pause(settleMs)
}

// The chat gets the whole width; the side panel comes back for its own scene.
await page
  .getByRole('button', { name: 'Fold the panel to its rail' })
  .click()
  .catch(() => undefined)
await pause(800)

// --- The agent at work: reads, runs the tests, fixes the bug, runs them again -----------------
await page.getByText('weather-station', { exact: true }).first().hover()
await pause(400)
await page.getByRole('button', { name: 'New chat in weather-station' }).click({ force: true })
await pause(1000)
mark('agentStart')
await type(PROMPTS.agent)
await untilReplied(2)
mark('agentEnd')
await page
  .getByRole('button', { name: 'View changes' })
  .last()
  .click()
  .catch(() => undefined)
await pause(2600)
mark('diffEnd')

// --- Work split across chats that report back -------------------------------------------------
mark('teamStart')
await type(PROMPTS.team)
await page.waitForFunction(() => /both follow-ups are done/.test(document.body.innerText), null, {
  timeout: 180_000
})
await pause(2200)
mark('teamEnd')

// --- The side panel: a terminal of your own in the project, and the apps a new tab offers -----
mark('panelStart')
await page.getByRole('button', { name: 'Open Terminal' }).click()
await pause(900)
await page.getByRole('button', { name: 'New terminal' }).first().click()
await pause(1800)
// Once the prompt is up.
await page
  .waitForFunction(
    () => /PS .*>/.test(document.querySelector('.xterm-rows')?.textContent ?? ''),
    null,
    {
      timeout: 20_000
    }
  )
  .catch(() => undefined)
await pause(1200)
// In one go, as a paste: typed key by key, PowerShell's history suggestions redraw the line.
await page.keyboard.insertText('node test.js')
await pause(300)
await page.keyboard.press('Enter')
await page
  .waitForFunction(
    () => /passing|failing/.test(document.querySelector('.xterm-rows')?.textContent ?? ''),
    null,
    { timeout: 20_000 }
  )
  .catch(() => undefined)
await pause(2400)
await page
  .getByRole('button', { name: 'New tab' })
  .first()
  .click()
  .catch(() => undefined)
await pause(2400)
mark('panelEnd')
await page
  .getByRole('button', { name: 'Fold the panel to its rail' })
  .click()
  .catch(() => undefined)
await pause(900)

// --- An artifact taking shape while it is written, then changed in place ----------------------
await page.getByRole('button', { name: 'New standalone chat' }).click({ force: true })
await pause(1000)
mark('artifactStart')
await type(PROMPTS.artifact)
await untilReplied(2)
mark('artifactEnd')
await type(PROMPTS.edit)
await untilReplied(4, 600)
// The chat follows the end of the reply; the changed sky is at the artifact's top, so scroll up
// to it the way a reader would.
await page.mouse.move(WINDOW.width * 0.55, WINDOW.height * 0.45)
for (let step = 0; step < 14; step++) {
  await page.mouse.wheel(0, -40)
  await pause(30)
}
await pause(3000)
mark('editEnd')

// --- The theme follows a choice ----------------------------------------------------------------
mark('lightStart')
await page.getByRole('button', { name: 'Switch to light mode' }).click()
await pause(2600)
mark('lightEnd')
await page.getByRole('button', { name: 'Switch to dark mode' }).click()
await pause(1200)
mark('end')

// --- Check: an empty Browser keeps the panel narrow, and a page widens it --------------------
const panelWidth = () => page.evaluate(() => document.querySelector('.activity-panel')?.style.width)
await page.getByRole('button', { name: 'Open Browser activity' }).click()
await pause(1500)
const emptyWidth = await panelWidth()
const address = page.getByPlaceholder(/Search or enter/)
await address.click()
await address.fill('https://example.com')
await address.press('Enter')
await pause(4000)
console.log(`Browser panel: empty ${emptyWidth}, with a page ${await panelWidth()}`)

await cdp.send('Page.stopScreencast')
await app.close()
model.close()

// --- Frames to a constant-rate video -----------------------------------------------------------
const list = frames
  .map((frame, index) => {
    const next = frames[index + 1]?.at ?? frame.at + 1 / FPS
    return `file '${frame.file}'\nduration ${Math.max(1 / FPS, next - frame.at).toFixed(4)}`
  })
  .join('\n')
writeFileSync(join(FRAMES, 'frames.txt'), `${list}\nfile '${frames.at(-1).file}'\n`)
writeFileSync(join(CLIPS, 'session.json'), JSON.stringify(marks, null, 2) + '\n')
// Remotion ships ffmpeg for its platform beside its compositor.
const compositor = readdirSync(join(MEDIA, 'node_modules', '@remotion')).find((name) =>
  name.startsWith('compositor-')
)
const ffmpeg = join(
  MEDIA,
  'node_modules',
  '@remotion',
  compositor,
  process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
)
execFileSync(
  ffmpeg,
  [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    'frames.txt',
    '-r',
    String(FPS),
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '14',
    '-preset',
    'slow',
    join(CLIPS, 'session.mp4')
  ],
  { cwd: FRAMES, stdio: 'inherit' }
)
rmSync(FRAMES, { recursive: true, force: true })
console.log(`Saved ${frames.length} frames as media/public/clips/session.mp4`)
