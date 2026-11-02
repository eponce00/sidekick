// What the agent should be able to do on real sites, one check for each, driven by probe.cjs with no model. Read only:
// nothing here signs in, buys, posts or saves. A check returns a problem to report, nothing when it passed, or a
// message starting BLOCKED when a site stopped it with a human check, which is never to be solved.
const look = async (page) => {
  const done = await page.step('browser_observe', { include_screenshot: false })
  return done.full ?? done.data
}
const humanCheck = async (page) => {
  const seen = await look(page)
  return seen.humanVerification ? `BLOCKED by a human check at ${seen.tab.url.slice(0, 80)}` : ''
}
const url = async (page) => (await look(page)).tab.url
const expectUrl = async (page, pattern) => {
  const now = await url(page)
  return pattern.test(now) ? '' : `Expected ${pattern} but the page is at ${now}`
}
const read = async (page) => (await page.step('browser_observe', { text: true })).full.text
const has = async (page, text) => (await read(page)).toLowerCase().includes(text.toLowerCase())

module.exports = {
  'github-tabs-and-file': async (page) => {
    const latest = await (
      await fetch('https://api.github.com/repos/microsoft/playwright/releases/latest')
    ).json()
    await page.open('https://github.com/microsoft/playwright/releases')
    if (!(await has(page, latest.name))) return `The page doesn't show release ${latest.name}`
    // What the click reports has to be the page it went to, not the one it left.
    const clicked = await page.click(await page.ref('Pull requests', /link/))
    const listed = JSON.stringify(clicked.full?.observation?.semanticSnapshot ?? clicked.data)
    if (/Assets \d/.test(listed) || !/Closed|Filter/.test(listed)) {
      return `The click reported the old page: ${listed.slice(0, 200)}`
    }
    let problem = await expectUrl(page, /\/pulls/)
    if (problem) return problem
    await page.step('browser_navigate', {
      action: 'url',
      url: 'https://github.com/microsoft/playwright/blob/main/package.json'
    })
    problem = (await has(page, '"version"')) ? '' : 'package.json is not showing'
    return problem
  },
  'google-search-tabs-menu': async (page) => {
    await page.open('https://www.google.com')
    await page.step('browser_type', {
      ref: await page.ref('Search', /combobox|textbox|searchbox/),
      value: 'intel arc pro b60 review',
      submit: true
    })
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    let problem = await expectUrl(page, /\/search/)
    if (problem) return problem
    await page.click(await page.ref('News', /link/))
    problem = await expectUrl(page, /tbm=nws|udm=/)
    if (problem) return problem
    await page.click(await page.ref('Tools', /button/))
    await page.click(await page.ref('Recent'))
    await page.click(await page.ref('Past month'))
    return expectUrl(page, /qdr:m/)
  },
  'openrouter-slider-drag': async (page) => {
    await page.open('https://openrouter.ai/models')
    await page.click(await page.ref('Prompt pricing', /heading|button/i))
    const handle = await page.ref('Maximum filter value', /slider/)
    const left = await page.page(
      'document.querySelector(\'input[aria-label="Minimum filter value"]\').getBoundingClientRect().x + 6'
    )
    const y = await page.page(
      'document.querySelector(\'input[aria-label="Maximum filter value"]\').getBoundingClientRect().y + 6'
    )
    await page.step('browser_observe', {})
    await page.step('browser_hold', { ref: handle, to_x: left, to_y: y })
    const problem = await expectUrl(page, /max_price=0\b/)
    if (problem) return problem
    // Each row here has two links to the same place, one laid over the other.
    await page.click(await page.ref('(free)', /link/))
    return expectUrl(page, /openrouter\.ai\/[^/]+\/[^/?]+/)
  },
  'artificialanalysis-tab-zoom': async (page) => {
    await page.open('https://artificialanalysis.ai/models')
    await page.click(await page.ref('Blended Price', /button|tab/i))
    const problem = await expectUrl(page, /pricing=blended-price/)
    if (problem) return problem
    await page.step('browser_observe', {})
    const zoomed = await page.step('browser_screenshot', {
      region: { x: 100, y: 100, width: 400, height: 200 }
    })
    return zoomed.pictures.length ? '' : 'The zoom came back with no picture'
  },
  'reddit-sort-and-post': async (page) => {
    await page.open('https://www.reddit.com/r/LocalLLaMA/')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    await page.step('browser_navigate', {
      action: 'url',
      url: 'https://www.reddit.com/r/LocalLLaMA/top/?t=week'
    })
    await page.click(await page.ref('comments', /link/))
    return expectUrl(page, /\/comments\//)
  },
  'youtube-filter-menu': async (page) => {
    await page.open('https://www.youtube.com/results?search_query=intel+arc+pro+b60')
    await page.click(await page.ref('Search filters', /button/))
    await page.click(await page.ref('This year', /link "This year"/))
    await new Promise((done) => setTimeout(done, 3000))
    return expectUrl(page, /[?&]sp=/)
  },
  'ebay-sold-filter': async (page) => {
    await page.open('https://www.ebay.com/sch/i.html?_nkw=intel+arc+pro+b60')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    await page.click(await page.ref('Sold Items'))
    await new Promise((done) => setTimeout(done, 1500))
    return expectUrl(page, /LH_Sold=1/)
  },
  'amazon-filter-and-sort': async (page) => {
    await page.open('https://www.amazon.com/s?k=usb+c+cable+6ft')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    await page.click(await page.ref('4 Stars', /link/))
    let problem = await expectUrl(page, /rh=/)
    if (problem) return problem
    await page.step('browser_select', {
      selector: '#s-result-sort-select',
      values: ['Price: Low to High']
    })
    problem = await expectUrl(page, /s=price-asc/)
    return problem
  },
  'amazon-price-history': async (page) => {
    await page.open('https://www.amazon.com/dp/B0GVGFW7MB')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    await page.click(await page.ref('Price history'))
    await page.click(await page.ref('3M'))
    await page.click(await page.ref('1Y'))
    return ''
  },
  'zillow-filter': async (page) => {
    await page.open('https://www.zillow.com/reno-nv/')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    // It can put up its human check a moment after the page has loaded.
    const beds = await page.ref('Beds', /button/).catch(() => '')
    if (!beds) return (await humanCheck(page)) || 'No Beds filter on the page'
    await page.click(beds)
    await page.click(await page.ref('3+'))
    await page.click(await page.ref('Apply', /button/))
    return expectUrl(page, /searchQueryState|beds|3-_beds/)
  },
  'airbnb-dates-and-guests': async (page) => {
    await page.open('https://www.airbnb.com/s/Reno--NV/homes')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    await page.click(await page.ref('Check in', /button/))
    const days = await page.step('browser_observe', {
      find: 'Available',
      include_screenshot: false
    })
    const lines = String(days.data?.semanticSnapshot ?? '').split('\n')
    const day = lines.map((line) => /ref=([^\s\]]+)/.exec(line)?.[1]).filter(Boolean)
    if (day.length < 12) return `Only ${day.length} days offered in the date picker`
    await page.click(day[8])
    await page.click(day[10])
    const chosen = await page.step('browser_observe', {
      find: 'Check in',
      include_screenshot: false
    })
    return /Any week/.test(chosen.data.semanticSnapshot)
      ? `The dates did not take: ${chosen.data.semanticSnapshot.slice(0, 200)}`
      : ''
  },
  'tesla-configurator': async (page) => {
    await page.open('https://www.tesla.com/model3/design')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    const radio = await page.ref('Performance', /radio/)
    await page.click(radio)
    await new Promise((done) => setTimeout(done, 1000))
    const seen = await page.step('browser_observe', {
      find: 'Performance',
      include_screenshot: false
    })
    return /radio[^\n]*Performance[^\n]*checked=true/.test(seen.data.semanticSnapshot) ||
      (await has(page, '54,990'))
      ? ''
      : `The option did not end up chosen: ${seen.data.semanticSnapshot.slice(0, 300)}`
  },
  'tesla-hidden-radio': async (page) => {
    await page.open('https://www.tesla.com/model3/design')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    // The section only loads once it's been scrolled to.
    await page.step('browser_scroll', { delta_x: 0, delta_y: 900 })
    const paint = await page.ref('Pearl White', /radio/).catch(() => '')
    if (!paint) return 'No Pearl White paint on the page'
    await page.click(paint)
    await new Promise((done) => setTimeout(done, 1000))
    const seen = await page.step('browser_observe', {
      find: 'Pearl White',
      include_screenshot: false
    })
    return /radio[^\n]*checked=true/.test(seen.data.semanticSnapshot)
      ? ''
      : `The paint did not end up chosen: ${seen.data.semanticSnapshot.slice(0, 300)}`
  },
  'batch-menu-and-choice': async (page) => {
    await page.open('https://www.google.com/search?q=intel+arc+pro+b60&tbm=nws')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    const tools = await page.ref('Tools', /button/)
    const done = await page.step('browser_batch', {
      steps: [
        { tool: 'browser_click', ref: tools },
        { tool: 'browser_wait', condition: { type: 'time', ms: 300 } },
        { tool: 'browser_observe', find: 'Recent', include_screenshot: false }
      ]
    })
    return /Recent/.test(JSON.stringify(done.data))
      ? ''
      : 'The batch did not find the menu it opened'
  },
  'read-page-text': async (page) => {
    await page.open('https://www.wikipedia.org/')
    const first = await page.step('browser_observe', { text: true })
    return /English/.test(first.data.text) && first.data.total > 100
      ? ''
      : `Unexpected text: ${String(first.data.text).slice(0, 200)}`
  },
  'x-live-scroll': async (page) => {
    await page.open('https://x.com/search?q=intel%20arc%20b60&f=live')
    const blocked = await humanCheck(page)
    if (blocked) return blocked
    const start = await read(page)
    for (let i = 0; i < 3; i++) await page.step('browser_scroll', { delta_x: 0, delta_y: 1200 })
    return (await read(page)) !== start ? '' : 'Scrolling did not change what the feed shows'
  }
}
