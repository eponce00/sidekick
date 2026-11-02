// Pages made to catch out automation, and the bench's own site, one check for each thing a browser tool should do.
// The Internet is a public site built for this. Nothing here signs in or sends anything out:
// uploads and downloads only go to the bench's site on this computer. A check returns a problem, or nothing if it passed.
const BENCH = `http://127.0.0.1:${process.env.BENCH_PORT || 4789}`
const INTERNET = 'https://the-internet.herokuapp.com'

const listed = (done) =>
  String(
    done.full?.semanticSnapshot ??
      done.full?.observation?.semanticSnapshot ??
      done.data?.semanticSnapshot ??
      ''
  )
const find = async (page, text) =>
  listed(await page.step('browser_observe', { find: text, include_screenshot: false }))
const read = async (page) => String((await page.step('browser_observe', { text: true })).full.text)
const url = async (page) =>
  (await page.step('browser_observe', { include_screenshot: false })).full.tab.url
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const expectText = async (page, pattern, what = '') => {
  const text = await read(page)
  return pattern.test(text)
    ? ''
    : `Expected ${pattern}${what ? ` ${what}` : ''}, but the page says: ${text.slice(0, 240).replace(/\s+/g, ' ')}`
}
const got = async (task) =>
  (await (await fetch(`${BENCH}/record`)).json()).filter((each) => each.task === task)
const clear = () => fetch(`${BENCH}/record/clear`)
const results = async (task) => (await got(task)).map((each) => each.value)
const result = async (task) => {
  await wait(250)
  return (await results(task)).at(-1)
}

const uploaded =
  (task, name = 'bench-small.txt') =>
  async () => {
    const entries = await got(task)
    return entries.some((each) => each.name === name && each.intact === true)
      ? ''
      : `The site received: ${JSON.stringify(entries).slice(0, 200)}`
  }

/** A file box the page has in plain sight. */
const uploadTo =
  (path, task, selector = 'input[type=file]', file = 'bench-small.txt') =>
  async (page) => {
    await clear()
    await page.open(`${BENCH}${path}`)
    await page.step('browser_upload', { paths: [file], selector })
    await wait(300)
    return uploaded(task, file)()
  }
/** A button that only asks for a file when it's pressed. */
const uploadByButton = (path, task, label) => async (page) => {
  await clear()
  await page.open(`${BENCH}${path}`)
  const clicked = await page.click(await page.ref(label, /button/))
  if (!clicked.data?.fileChooserOpened) return 'The click did not report a file chooser'
  await page.step('browser_upload', { paths: ['bench-small.txt'] })
  await wait(300)
  return uploaded(task)()
}

module.exports = {
  // The bench's own site: files, and controls that aren't plain ones.
  'bench-download': async (page) => {
    await page.open(`${BENCH}/`)
    await page.step('browser_download', {
      url: `${BENCH}/files/bench-small.txt`,
      destination: `got-${Date.now()}.txt`
    })
    return ''
  },
  'bench-upload-plain': uploadTo('/u/plain', 'plain'),
  'bench-upload-hidden': uploadByButton('/u/hidden', 'hidden', 'Choose a file'),
  'bench-upload-dynamic': uploadByButton('/u/dynamic', 'dynamic', 'Upload a document'),
  'bench-upload-drop': uploadTo('/u/drop', 'drop', '#zone'),
  'bench-upload-frame': async (page) => {
    await clear()
    await page.open(`${BENCH}/u/frame`)
    await page.step('browser_upload', {
      paths: ['bench-small.txt'],
      ref: await page.ref('Framed attachment')
    })
    await wait(300)
    return uploaded('frame')()
  },
  'bench-frame-field': async (page) => {
    await clear()
    await page.open(`${BENCH}/h/frame`)
    await page.step('browser_type', {
      ref: await page.ref('Your city', /textbox/),
      value: 'Lisbon'
    })
    await page.click(await page.ref('Save city', /button/))
    await wait(300)
    return (await got('frame-field')).some((each) => each.value === 'Lisbon')
      ? ''
      : 'The frame did not save the city'
  },
  'bench-shadow-dom': async (page) => {
    await clear()
    await page.open(`${BENCH}/h/shadow`)
    await page.step('browser_type', { ref: await page.ref('Your pet', /textbox/), value: 'Rex' })
    await page.click(await page.ref('Save pet', /button/))
    await wait(300)
    return (await got('shadow')).some((each) => each.value === 'Rex') ? '' : 'Rex was not saved'
  },
  'bench-rich-text': async (page) => {
    await clear()
    await page.open(`${BENCH}/h/editor`)
    await page.step('browser_type', {
      ref: await page.ref('Message', /textbox/),
      value: 'Hello there'
    })
    await page.click(await page.ref('Save message', /button/))
    await wait(300)
    return (await got('editor')).some((each) => each.value === 'Hello there')
      ? ''
      : 'The message was not saved'
  },
  'bench-date-field': async (page) => {
    await clear()
    await page.open(`${BENCH}/h/date`)
    await page.step('browser_fill_form', {
      fields: [{ kind: 'textbox', ref: await page.ref('Start date'), value: '2027-03-14' }]
    })
    await page.click(await page.ref('Save date', /button/))
    await wait(300)
    return (await got('date')).some((each) => each.value === '2027-03-14')
      ? ''
      : 'The date was not saved'
  },
  'bench-label-stands-for-field': async (page) => {
    await clear()
    await page.open(`${BENCH}/h/date`)
    await page.step('browser_type', {
      ref: await page.ref('Start date', /StaticText/),
      value: '2027-03-14'
    })
    await page.click(await page.ref('Save date', /button/))
    await wait(300)
    return (await got('date')).some((each) => each.value === '2027-03-14')
      ? ''
      : 'The date was not saved'
  },
  'bench-custom-menu': async (page) => {
    await clear()
    await page.open(`${BENCH}/h/menu`)
    await page.step('browser_select', { ref: await page.ref('Choose a plan'), values: ['Medium'] })
    await wait(300)
    return (await got('menu')).some((each) => each.value === 'Medium')
      ? ''
      : 'Medium was not chosen'
  },
  'bench-endless-list': async (page) => {
    await page.open(`${BENCH}/h/scroll`)
    for (let i = 0; i < 12; i++) {
      if (/secret word is walnut/.test(await find(page, 'secret word'))) return ''
      await page.step('browser_scroll', { delta_x: 0, delta_y: 2000 })
    }
    return 'Never reached item 137'
  },
  'bench-slow-page': async (page) => {
    await page.open(`${BENCH}/h/slow`)
    await page.step('browser_wait', { text: 'The report number is 4417' })
    return expectText(page, /4417/)
  },

  // The Internet.
  'internet-dynamic-controls': async (page) => {
    await page.open(`${INTERNET}/dynamic_controls`)
    await page.click(await page.ref('Remove', /button/))
    await page.step('browser_wait', { text: "It's gone!" })
    await page.click(await page.ref('Enable', /button/))
    await page.step('browser_wait', { text: "It's enabled!" })
    await page.step('browser_type', { selector: 'input[type=text]', value: 'typed after waiting' })
    const box = await page.page("document.querySelector('input[type=text]').value")
    return box === 'typed after waiting' ? '' : `The box has ${box}`
  },
  'internet-hover-reveals-link': async (page) => {
    await page.open(`${INTERNET}/hovers`)
    await page.step('browser_hover', { ref: await page.ref('User Avatar', /image/) })
    await page.click(await page.ref('View profile', /link/))
    return /\/users\/1/.test(await url(page)) ? '' : 'The profile link did not go to the first user'
  },
  'internet-drag-and-drop': async (page) => {
    await page.open(`${INTERNET}/drag_and_drop`)
    const box = await page.page(
      "(() => { const b = document.querySelector('#column-b').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()"
    )
    await page.step('browser_observe', {})
    await page.step('browser_hold', { selector: '#column-a', to_x: box[0], to_y: box[1] })
    const first = await page.page("document.querySelector('#column-a header').textContent")
    return first === 'B' ? '' : `Column A still says ${first}`
  },
  'internet-horizontal-slider': async (page) => {
    await page.open(`${INTERNET}/horizontal_slider`)
    const box = await page.page(
      "(() => { const b = document.querySelector('input[type=range]').getBoundingClientRect(); return [b.right - 2, b.y + b.height / 2] })()"
    )
    await page.step('browser_observe', {})
    await page.step('browser_hold', { selector: 'input[type=range]', to_x: box[0], to_y: box[1] })
    const value = await page.page("document.querySelector('#range').textContent")
    return Number(value) >= 4.5 ? '' : `The slider says ${value}`
  },
  'internet-dropdown-and-checkboxes': async (page) => {
    await page.open(`${INTERNET}/dropdown`)
    await page.step('browser_select', { selector: '#dropdown', values: ['Option 2'] })
    if ((await page.page("document.querySelector('#dropdown').value")) !== '2')
      return 'Option 2 not chosen'
    await page.step('browser_navigate', { action: 'url', url: `${INTERNET}/checkboxes` })
    await page.click(await page.ref('checkbox', /^- checkbox/))
    return (await page.page("document.querySelector('input[type=checkbox]').checked"))
      ? ''
      : 'The first box is not ticked'
  },
  'internet-javascript-alerts': async (page) => {
    await page.open(`${INTERNET}/javascript_alerts`)
    await page.click(await page.ref('Click for JS Alert', /button/))
    return expectText(page, /You successfully clicked an alert/, 'after the alert')
  },
  'internet-new-window': async (page) => {
    await page.open(`${INTERNET}/windows`)
    await page.click(await page.ref('Click Here', /link/))
    await wait(1000)
    const tabs = await page.step('browser_tabs', { action: 'list' })
    const all = tabs.full?.tabs ?? tabs.data?.tabs ?? []
    if (all.length < 2) return `Only ${all.length} tab after a link that opens a window`
    const opened = all.find((tab) => /new/.test(String(tab.url)))
    if (!opened) return `No new window among ${JSON.stringify(all.map((tab) => tab.url))}`
    await page.step('browser_tabs', { action: 'select', tab_id: opened.id })
    const problem = await expectText(page, /New Window/)
    if (problem) return problem
    await page.step('browser_tabs', { action: 'close', tab_id: opened.id })
    return ''
  },
  'internet-modal-in-the-way': async (page) => {
    await page.open(`${INTERNET}/entry_ad`)
    await wait(1500)
    const close = await find(page, 'Close')
    const ref = /ref=([^\s\]]+)/.exec(close)?.[1]
    if (ref) await page.click(ref)
    await page.click(await page.ref('click here', /link/))
    return ''
  },
  'internet-keyboard': async (page) => {
    await page.open(`${INTERNET}/key_presses`)
    await page.click(await page.ref('', /textbox/))
    await page.step('browser_press', { key: 'Tab' })
    return expectText(page, /You entered: TAB/)
  },
  'internet-frames': async (page) => {
    await page.open(`${INTERNET}/nested_frames`)
    return /MIDDLE|LEFT/.test(await find(page, 'MIDDLE'))
      ? ''
      : 'The text in the frames is not found'
  },
  'internet-shadow-text': async (page) => {
    await page.open(`${INTERNET}/shadowdom`)
    return /different text/i.test(await find(page, 'different text'))
      ? ''
      : 'The text in the shadow root is not found'
  },
  'internet-large-page': async (page) => {
    await page.open(`${INTERNET}/large`)
    return /50\.50/.test(await find(page, '50.50'))
      ? ''
      : 'The last cell of a huge table was not found'
  },

  // Traps, on the bench's own site so they can't change or go away.
  'trap-real-click-only': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/trusted`)
    await page.click(await page.ref('Press me', /button/))
    return (await result('trusted')) === 'real' ? '' : 'The button only answers a real click'
  },
  'trap-covered-button': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/covered`)
    const green = await page.ref('Green', /button/)
    await page.click(green)
    const again = await page.click(green).catch((error) => error)
    if (!(again instanceof Error) || !/covered by .*Blue/.test(again.message)) {
      return `Pressing the covered button was not refused: ${String(again?.message ?? 'it went through')}`
    }
    return (await results('covered')).includes('blue') ? 'The button on top got pressed' : ''
  },
  'trap-sticky-footer': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/sticky`)
    await page.click(await page.ref('Far down', /button/))
    return (await result('sticky')) === 'pressed'
      ? ''
      : 'The button under the footer was not pressed'
  },
  'trap-scrolling-box': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/scrollbox`)
    await page.click(await page.ref('Inside the box', /button/))
    return (await result('scrollbox')) === 'pressed' ? '' : 'The button in the box was not pressed'
  },
  'trap-moving-button': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/moving`)
    await page.click(await page.ref('Moving target', /button/))
    return (await result('moving')) === 'pressed' ? '' : 'The moving button was missed'
  },
  'trap-late-button': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/late`)
    await page.step('browser_wait', { text: 'Arrived late' })
    await page.click(await page.ref('Arrived late', /button/))
    return (await result('late')) === 'pressed' ? '' : 'The late button was not pressed'
  },
  'trap-typed-into-a-box': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/rename`)
    await page.step('browser_type', { ref: await page.ref('New name', /textbox/), value: 'Fresh' })
    await page.click(await page.ref('Old name', /button/))
    return (await result('rename')) === 'Fresh' ? '' : 'The button did not take the typed name'
  },
  'trap-replaced-under-the-pointer': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/swap`)
    await page.click(await page.ref('Count me', /link/)).catch(() => undefined)
    await page.click(await page.ref('Count me', /link/))
    return (await results('swap')).length
      ? ''
      : 'A link replaced as the pointer arrives could not be pressed'
  },
  'trap-opens-new-tab': async (page) => {
    await page.open(`${BENCH}/t/open`)
    await page.click(await page.ref('Open the report', /link/))
    await wait(800)
    const tabs = await page.step('browser_tabs', { action: 'list' })
    const all = tabs.full?.tabs ?? []
    const opened = all.find((tab) => /slow/.test(String(tab.url)))
    if (!opened)
      return `The new tab was not picked up: ${JSON.stringify(all.map((tab) => tab.url))}`
    await page.step('browser_tabs', { action: 'select', tab_id: opened.id })
    await page.step('browser_wait', { text: '4417' })
    return ''
  },
  'trap-dialogs': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/dialogs`)
    for (const name of ['Alert', 'Confirm', 'Prompt']) {
      await page.click(await page.ref(name, /button/))
    }
    await wait(300)
    const all = await results('dialogs')
    // Electron has no prompt() at all, so that one can't get past it in the built-in browser.
    const expected = process.env.PROBE_BROWSER === 'built_in' ? 2 : 3
    return all.length === expected ? '' : `Only got past ${JSON.stringify(all)}`
  },
  'trap-menu-that-navigates': async (page) => {
    await page.open(`${BENCH}/t/nav-menu`)
    const chosen = await page.step('browser_select', {
      ref: await page.ref('Go to', /combobox/),
      values: ['Home']
    })
    if (!/read back/.test(JSON.stringify(chosen.data))) return 'It went, but nothing said so'
    return /went=1/.test(await url(page)) ? '' : 'The menu did not go anywhere'
  },
  'trap-address-changes-before-page': async (page) => {
    await page.open(`${BENCH}/t/spa`)
    const clicked = await page.click(await page.ref('Next page', /link/))
    const seen = listed(clicked)
    return /The next page/.test(seen) && !/The first page/.test(seen)
      ? ''
      : `The click reported the page it left: ${seen.slice(0, 160)}`
  },
  'trap-thousands-of-elements': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/many`)
    await page.click(await page.ref('The last button', /button/))
    return (await result('many')) === 'pressed'
      ? ''
      : 'The last of thousands of elements was not pressed'
  },
  'trap-whole-form': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/form`)
    await page.step('browser_fill_form', {
      fields: [
        { kind: 'textbox', ref: await page.ref('Name', /textbox/), value: 'Ada' },
        { kind: 'select', ref: await page.ref('Size', /combobox/), values: ['Large'] },
        { kind: 'checkbox', ref: await page.ref('News', /checkbox/), checked: true },
        { kind: 'radio', ref: await page.ref('Cash', /radio/), checked: true }
      ]
    })
    await page.click(await page.ref('Save the form', /button/))
    await wait(300)
    const sent = JSON.parse((await result('form')) ?? '{}')
    return sent.name === 'Ada' &&
      sent.size === 'Large' &&
      sent.news === 'yes' &&
      sent.pay === 'cash'
      ? ''
      : `The form sent ${JSON.stringify(sent)}`
  },
  'trap-hidden-radio': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/hidden-input`)
    await page.click(await page.ref('Red paint', /radio/))
    return (await result('hidden-input')) === 'red' ? '' : 'The hidden radio was not chosen'
  },
  'trap-closed-shadow-root': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/closed-shadow`)
    await page.click(await page.ref('Inside closed', /button/))
    return (await result('closed')) === 'pressed'
      ? ''
      : 'The button in a closed shadow root was not pressed'
  },
  'trap-position-click-is-exact': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/canvas`)
    const look = await page.step('browser_observe', {})
    const picture = look.full.screenshot
    const scale = picture.width / look.full.viewport.width
    const box = await page.page(
      "[document.querySelector('canvas').getBoundingClientRect().x, document.querySelector('canvas').getBoundingClientRect().y]"
    )
    await page.step('browser_click', {
      x: (box[0] + 140) * scale,
      y: (box[1] + 100) * scale,
      screenshot_id: picture.id
    })
    await wait(200)
    const seen = JSON.parse((await result('canvas')) ?? '{}')
    const off = seen.from ? Math.hypot(seen.from[0] - 140, seen.from[1] - 100) : Infinity
    return off <= 2 ? '' : `The click landed ${off.toFixed(1)}px off: ${JSON.stringify(seen)}`
  },
  'trap-canvas-drag-is-exact': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/canvas`)
    const look = await page.step('browser_observe', {})
    const picture = look.full.screenshot
    const scale = picture.width / look.full.viewport.width
    const box = await page.page(
      "[document.querySelector('canvas').getBoundingClientRect().x, document.querySelector('canvas').getBoundingClientRect().y]"
    )
    await page.step('browser_hold', {
      x: (box[0] + 50) * scale,
      y: (box[1] + 50) * scale,
      to_x: (box[0] + 400) * scale,
      to_y: (box[1] + 220) * scale,
      screenshot_id: picture.id,
      duration_ms: 100
    })
    await wait(200)
    const seen = JSON.parse((await result('canvas')) ?? '{}')
    const off = seen.to ? Math.hypot(seen.to[0] - 400, seen.to[1] - 220) : Infinity
    return off <= 2 ? '' : `The drag ended ${off.toFixed(1)}px off: ${JSON.stringify(seen)}`
  },
  'trap-frame-on-another-address': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/frame-far`)
    // Unread, as it may hold a card form, and said so. Pressing by position still has to reach it.
    const look = await page.step('browser_observe', {})
    if (!/can't be read/.test(listed(look))) return "The page doesn't say the frame can't be read"
    const picture = look.full.screenshot
    const scale = picture.width / look.full.viewport.width
    const box = await page.page(
      "[document.querySelector('iframe').getBoundingClientRect().x, document.querySelector('iframe').getBoundingClientRect().y]"
    )
    await page.step('browser_click', {
      x: (box[0] + 20) * scale,
      y: (box[1] + 40) * scale,
      screenshot_id: picture.id
    })
    return ''
  },
  'trap-footer-over-a-button': async (page) => {
    await clear()
    await page.open(`${BENCH}/t/overlay-text`)
    const clicked = await page.click(await page.ref('Details', /button/))
    const said = JSON.stringify(clicked.data)
    return /on top/.test(said) ? '' : `Nothing said a cover took the click: ${said.slice(0, 200)}`
  },
  'trap-page-that-fails-to-load': async (page) => {
    await page.open(`${BENCH}/t/bad-link`)
    const failed = await page
      .step('browser_navigate', { action: 'url', url: 'https://nothing-here.invalid/' })
      .then(
        () => '',
        (error) => error.message
      )
    return /load|resolve|reach|ERR_/i.test(failed)
      ? ''
      : `A page that can't load was not reported: ${failed || 'it said it worked'}`
  },

  // Real pages, for what isn't about one control.
  'wikipedia-text-and-pictures': async (page) => {
    await page.open('https://en.wikipedia.org/wiki/Reno,_Nevada')
    const first = await page.step('browser_observe', { text: true })
    if (first.full.total <= 20000) return `Only ${first.full.total} characters of a long article`
    const next = await page.step('browser_observe', { text: true, text_from: 20000 })
    if (next.full.text === first.full.text || !next.full.text)
      return 'The next part of the text did not come'
    const whole = await page.step('browser_screenshot', { full_page: true })
    if (!whole.pictures.length) return 'No full page picture'
    const element = await page.step('browser_screenshot', { selector: '#firstHeading' })
    if (!element.pictures.length) return 'No picture of one element'
    const look = await page.step('browser_observe', {})
    if (!look.pictures.length) return 'No picture from a look'
    return ''
  },
  'wikipedia-back-and-forward': async (page) => {
    await page.open('https://en.wikipedia.org/wiki/Reno,_Nevada')
    await page.click(await page.ref('Sparks, Nevada', /link/))
    if (!/Sparks/.test(await url(page))) return 'The link did not go to Sparks'
    await page.step('browser_navigate', { action: 'back' })
    if (!/Reno/.test(await url(page))) return 'Back did not return to Reno'
    await page.step('browser_navigate', { action: 'forward' })
    if (!/Sparks/.test(await url(page))) return 'Forward did not go to Sparks'
    await page.step('browser_navigate', { action: 'reload' })
    return /Sparks/.test(await url(page)) ? '' : 'Reload lost the page'
  },
  'wikipedia-tabs-console-network-verify': async (page) => {
    await page.open('https://en.wikipedia.org/wiki/Reno,_Nevada')
    await page.step('browser_tabs', { action: 'new', url: 'https://en.wikipedia.org/wiki/Nevada' })
    const tabs = await page.step('browser_tabs', { action: 'list' })
    const all = tabs.full?.tabs ?? tabs.data?.tabs ?? []
    if (all.length !== 2) return `Expected 2 tabs, found ${all.length}`
    const first = all.find((tab) => /Reno/.test(String(tab.url)))
    await page.step('browser_tabs', { action: 'select', tab_id: first.id })
    const shown = await page.step('browser_observe', { text: true })
    if (!/Reno/.test(shown.full.title)) return 'Selecting did not show Reno'
    await page.step('browser_console', { level: 'all' })
    await page.step('browser_network', {})
    const verified = await page.step('browser_verify', {
      criterion: 'The article about Reno is showing'
    })
    return verified.pictures.length ? '' : 'Verify came back with no picture'
  },
  'wikipedia-batch': async (page) => {
    await page.open('https://en.wikipedia.org/wiki/Reno,_Nevada')
    const done = await page.step('browser_batch', {
      steps: [
        { tool: 'browser_scroll', delta_x: 0, delta_y: 1500 },
        { tool: 'browser_wait', milliseconds: 100 },
        { tool: 'browser_scroll', delta_x: 0, delta_y: -1500 },
        { tool: 'browser_navigate', action: 'url', url: 'https://en.wikipedia.org/wiki/Nevada' },
        { tool: 'browser_observe', find: 'Carson City', include_screenshot: false }
      ]
    })
    return /Carson City/.test(JSON.stringify(done.data))
      ? ''
      : 'The last step did not report what it found'
  },
  'pdf-opens': async (page) => {
    await page.open('https://arxiv.org/pdf/1706.03762')
    const look = await page.step('browser_observe', {})
    return look.pictures.length ? '' : 'No picture of the PDF'
  },
  'mdn-form-on-a-real-page': async (page) => {
    await page.open('https://developer.mozilla.org/en-US/search?q=fetch')
    await page.click(await page.ref('Search the site', /button/))
    await page.step('browser_type', {
      ref: await page.ref('Search', /textbox|searchbox|combobox/),
      value: 'promise'
    })
    return ''
  }
}
