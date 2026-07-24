export const artifactSandboxPreviewCode = `
import { Chart, registerables } from 'chart.js'

Chart.register(...registerables)

function App() {
  const canvasRef = React.useRef(null)
  const chartRef = React.useRef(null)
  const [count, setCount] = React.useState(0)
  const [simulateHover, setSimulateHover] = React.useState(false)

  React.useEffect(() => {
    if (!canvasRef.current || chartRef.current) return
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: ['2021', '2022', '2023', '2024', '2025'],
        datasets: [{
          label: 'Population',
          data: [393838, 402378, 410079, 412981, 413554],
          borderColor: theme.accent,
          backgroundColor: theme.accentMuted,
          tension: 0.3
        }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    })
    return () => chartRef.current?.destroy()
  }, [])

  return (
    <main className="bg-artifact-panel text-artifact-primary border border-artifact-border rounded-xl p-5 space-y-4">
      <style>{\`
        #hover-test { background: #f3f4f6; color: #111827; }
        #hover-test:hover,
        #hover-test.simulate-hover { background: #111827; color: #111827; }
      \`}</style>
      <header>
        <p className="text-artifact-muted text-xs uppercase tracking-widest">Theme runtime</p>
        <h1 className="text-xl font-semibold">Artifact sandbox regression preview</h1>
        <p className="text-artifact-secondary mt-1">Current mode: {theme.themeMode}</p>
      </header>
      <div style={{ height: 180 }}><canvas ref={canvasRef} /></div>
      <section className="grid grid-cols-2 gap-3">
        <button
          id="semantic-test"
          className="bg-artifact-accent text-artifact-accent-foreground hover:bg-artifact-hover hover:text-artifact-primary"
        >
          Semantic action {count}
        </button>
        <button
          id="hover-test"
          className={simulateHover ? 'simulate-hover' : ''}
          onClick={() => {
            setCount((value) => value + 1)
            setSimulateHover((value) => !value)
          }}
        >
          Broken generated hover
        </button>
      </section>
      <div
        id="static-test"
        style={{ background: '#111827', color: '#151c28', padding: 12, borderRadius: 8 }}
      >
        Severe dark-on-dark generated text
      </div>
    </main>
  )
}
`
