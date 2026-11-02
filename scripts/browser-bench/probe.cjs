// Calls the Chrome tools directly, with no model. Needs a development instance started with SIDEKICK_TOOL_PROBE=4790.
//   node scripts/browser-bench/probe.cjs <tool> '<json arguments>'    one call
//   node scripts/browser-bench/probe.cjs run [name ...]               the checks in checks.cjs and checks-tricky.cjs
// Set PROBE_BROWSER=built_in for SideKick's own browser rather than Chrome.
// Each check says what a page must end up showing, read from the page rather than from a tool's own report.
const fs = require('fs')
const path = require('path')

const PORT = process.env.SIDEKICK_TOOL_PROBE || 4790
const BROWSER = process.env.PROBE_BROWSER || 'chrome'
const FILES = path.join(require('os').tmpdir(), 'sidekick-browser-probe', 'files')
const OUT = process.env.PROBE_OUT || path.join(require('os').tmpdir(), 'sidekick-probe')
fs.mkdirSync(OUT, { recursive: true })

let picture = 0
async function call(name, args = {}, chat = 'chat') {
  const answer = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    body: JSON.stringify({ name, args, chat })
  })
  const { ms, trace, result } = await answer.json()
  let data
  try {
    data = JSON.parse(result.modelContent)
  } catch {
    data = result.modelContent
  }
  const pictures = (result.media ?? []).map((media) => {
    const file = path.join(OUT, `${++picture}.${(media.mimeType ?? 'image/png').split('/')[1]}`)
    const { path: from, data: bytes, base64 } = media.source ?? {}
    if (from) fs.copyFileSync(from, file)
    else fs.writeFileSync(file, Buffer.from(bytes ?? base64 ?? '', 'base64'))
    return file
  })
  return { ms, trace, ok: result.status === 'success', data, full: result.data, pictures }
}

/** One browser, one chat: what a check needs, and a record of how each step went. */
function session(chat) {
  const steps = []
  const step = async (name, args) => {
    const done = await call(name, args, chat)
    steps.push({ name, ms: done.ms, ok: done.ok })
    if (!done.ok) throw new Error(`${name} failed: ${JSON.stringify(done.data).slice(0, 400)}`)
    return done
  }
  const snapshot = (done) =>
    String(
      done.full?.semanticSnapshot ??
        done.full?.observation?.semanticSnapshot ??
        done.data?.semanticSnapshot ??
        ''
    )
  return {
    steps,
    step,
    open: (url) => step('browser_open', { url, browser: BROWSER }),
    /** The ref of the first element with this in it, across the whole page. */
    ref: async (find, line = /./) => {
      const found = snapshot(await step('browser_observe', { find }))
        .split('\n')
        .find((each) => line.test(each) && /ref=/.test(each))
      if (!found) throw new Error(`Nothing with ${JSON.stringify(find)} on the page`)
      return /ref=([^\s\]]+)/.exec(found)[1]
    },
    click: (ref) => step('browser_click', { ref }),
    page: async (expression) => (await step('browser_evaluate', { expression })).data?.value,
    done: () => step('browser_close', {}).catch(() => undefined)
  }
}

async function run(only) {
  const checks = { ...require('./checks.cjs'), ...require('./checks-tricky.cjs') }
  // What the uploads send, which the bench's site knows the contents of.
  fs.mkdirSync(FILES, { recursive: true })
  fs.writeFileSync(path.join(FILES, 'bench-small.txt'), 'bench file contents\n')
  const site = await fetch(`http://127.0.0.1:${process.env.BENCH_PORT || 4789}/`).catch(() => null)
  if (!site) require('./site.cjs')
  const results = []
  for (const [name, check] of Object.entries(checks)) {
    if (only.length && !only.some((each) => name.startsWith(each))) continue
    const started = Date.now()
    // A chat of its own each time, as a stopped one stays stopped until its reply ends.
    const page = session(`${name}-${started}`)
    let problem = ''
    try {
      problem = (await check(page)) || ''
    } catch (error) {
      problem = error.message
    }
    await page.done()
    const slowest = [...page.steps].sort((a, b) => b.ms - a.ms)[0]
    results.push({ name, problem: /^BLOCKED/.test(problem) ? '' : problem })
    console.log(
      `${/^BLOCKED/.test(problem) ? 'skip' : problem ? 'FAIL' : 'pass'}  ${name}  ${((Date.now() - started) / 1000).toFixed(1)}s, ${page.steps.length} steps, slowest ${slowest?.name} ${((slowest?.ms ?? 0) / 1000).toFixed(1)}s${problem ? `\n      ${problem.slice(0, 500)}` : ''}`
    )
  }
  const passed = results.filter((each) => !each.problem).length
  console.log(`${passed} of ${results.length} passed`)
  process.exit(passed === results.length ? 0 : 1)
}

if (require.main !== module) {
  // Used from another script.
} else if (process.argv[2] === 'run') run(process.argv.slice(3))
else {
  call(process.argv[2], JSON.parse(process.argv[3] || '{}')).then((done) =>
    console.log(JSON.stringify(done, null, 1).slice(0, Number(process.env.PROBE_CHARS || 6000)))
  )
}

module.exports = { call, session }
