import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  installArtifactProtocol,
  registerArtifactScheme
} from '../src/main/bootstrap/artifactProtocol'
import { ArtifactInspector } from '../src/main/services/artifactInspector'
import type { InspectedArtifactType } from '../src/shared/artifactInspection'

// Renders real artifacts through the same inspection path create_artifact
// uses, with a real Electron window and the real artifact runtime, and writes
// each capture to disk for a person to look at.

const RESULT_PREFIX = 'SIDEKICK_ARTIFACT_INSPECTOR_SMOKE='

interface SmokeCase {
  name: string
  type: InspectedArtifactType
  code: string
  expect: 'rendered' | 'error'
  minHeight?: number
  maxHeight?: number
}

const CASES: SmokeCase[] = [
  {
    name: 'react-card',
    type: 'react',
    expect: 'rendered',
    code: `export default function App() {
  return (
    <div className="p-6 rounded-2xl bg-artifact-surface text-artifact-primary">
      <p className="text-sm text-artifact-muted">Reno, NV</p>
      <p className="text-5xl font-semibold mt-1">72°F</p>
      <p className="mt-2">Sunny with a light breeze</p>
    </div>
  )
}`
  },
  {
    name: 'react-fetches-data',
    type: 'react',
    expect: 'rendered',
    code: `import { useEffect, useState } from 'react'
export default function App() {
  const [temp, setTemp] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    fetch('https://api.open-meteo.com/v1/forecast?latitude=39.5296&longitude=-119.8138&current=temperature_2m&temperature_unit=fahrenheit')
      .then((r) => r.json())
      .then((d) => setTemp(d.current.temperature_2m))
      .catch((e) => setError(String(e)))
  }, [])
  return (
    <div className="p-6 text-artifact-primary">
      <p className="text-sm text-artifact-muted">Live from Open-Meteo</p>
      <p className="text-5xl font-semibold">{error ? 'Failed: ' + error : temp === null ? 'Loading…' : temp + '°F'}</p>
    </div>
  )
}`
  },
  {
    name: 'react-tall',
    type: 'react',
    expect: 'rendered',
    code: `export default function App() {
  return (
    <div className="p-6 space-y-4 text-artifact-primary">
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="h-16 rounded-xl bg-artifact-surface px-4 py-3">Row {index + 1}</div>
      ))}
      <button className="px-4 py-2 rounded-lg bg-artifact-accent text-white">Controls at the bottom</button>
    </div>
  )
}`
  },
  {
    name: 'react-throws',
    type: 'react',
    expect: 'error',
    code: `export default function App() {
  const data = undefined
  return <div>{data.current.temperature}</div>
}`
  },
  {
    name: 'html-page',
    type: 'html',
    expect: 'rendered',
    code: `<div style="padding:24px;font-family:sans-serif"><h1>HTML artifact</h1><p>Rendered for inspection.</p></div>`
  },
  {
    name: 'svg-drawing',
    type: 'svg',
    expect: 'rendered',
    code: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" rx="16" fill="#1f6feb"/><text x="120" y="68" font-size="28" text-anchor="middle" fill="white">SVG</text></svg>`
  },
  {
    name: 'html-portrait-canvas',
    type: 'html',
    expect: 'rendered',
    minHeight: 600,
    code: `<canvas id="game" width="420" height="600" style="width:100%;max-width:420px"></canvas>
<script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#70c5ce'; ctx.fillRect(0, 0, 420, 600);
ctx.fillStyle = '#ffdb53'; ctx.beginPath(); ctx.arc(110, 275, 21, 0, Math.PI * 2); ctx.fill();
</script>`
  },
  {
    name: 'react-responsive-chart',
    type: 'react',
    expect: 'rendered',
    maxHeight: 320,
    code: `import { useEffect, useRef } from 'react'
import { Chart, registerables } from 'chart.js'
Chart.register(...registerables)
export default function App() {
  const ref = useRef(null)
  useEffect(() => {
    const chart = new Chart(ref.current, {
      type: 'bar',
      data: { labels: ['A', 'B'], datasets: [{ data: [2, 5] }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false }
    })
    return () => chart.destroy()
  }, [])
  return <canvas ref={ref} />
}`
  }
]

registerArtifactScheme()
// The inspection window is the only window here; closing it must not quit.
app.on('window-all-closed', () => undefined)
app.on('render-process-gone', (_event, _contents, details) =>
  process.stderr.write(`render-process-gone: ${JSON.stringify(details)}\n`)
)

app.whenReady().then(async () => {
  const outputDirectory =
    process.env['SIDEKICK_ARTIFACT_SMOKE_OUT'] || join(process.cwd(), 'artifact-smoke')
  mkdirSync(outputDirectory, { recursive: true })
  await installArtifactProtocol()
  const inspector = new ArtifactInspector()
  const results: Array<Record<string, unknown>> = []
  for (const item of CASES) {
    const startedAt = Date.now()
    try {
      const inspection = await inspector.inspect({
        type: item.type,
        title: item.name,
        code: item.code
      })
      let imagePath: string | undefined
      if (inspection.image) {
        imagePath = join(outputDirectory, `${item.name}.jpg`)
        writeFileSync(imagePath, Buffer.from(inspection.image.base64, 'base64'))
      }
      results.push({
        name: item.name,
        expected: item.expect,
        status: inspection.status,
        pass:
          inspection.status === item.expect &&
          Boolean(inspection.image) &&
          (item.minHeight === undefined || inspection.height >= item.minHeight) &&
          (item.maxHeight === undefined || inspection.height <= item.maxHeight),
        height: inspection.height,
        warnings: inspection.warnings,
        errors: inspection.errors,
        chatFrameHeight: inspection.chatFrameHeight,
        size: inspection.image ? `${inspection.image.width}x${inspection.image.height}` : null,
        imageBytes: inspection.image
          ? Buffer.from(inspection.image.base64, 'base64').byteLength
          : 0,
        imagePath,
        ms: Date.now() - startedAt
      })
    } catch (error) {
      results.push({
        name: item.name,
        pass: false,
        thrown: String(error),
        ms: Date.now() - startedAt
      })
    }
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(results)}\n`)
  app.exit(results.every((result) => result.pass) ? 0 : 1)
})
