// The artifact the recording builds: a forecast for the demo weather station, written in the order
// SideKick's artifact skill asks for (App's layout first), so the chat shows it taking shape piece
// by piece. The edit swaps the daytime sky for the evening one, in place.

export const FORECAST = `import { motion } from 'framer-motion'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Sun, Moon, CloudSun, CloudRain, Cloud, Droplets, Wind, Gauge } from 'lucide-react'

const week = [
  { day: 'Mon', high: 18, low: 9, sky: Cloud },
  { day: 'Tue', high: 21, low: 11, sky: CloudSun },
  { day: 'Wed', high: 24, low: 13, sky: Sun },
  { day: 'Thu', high: 19, low: 12, sky: CloudRain },
  { day: 'Fri', high: 16, low: 10, sky: CloudRain },
  { day: 'Sat', high: 20, low: 11, sky: CloudSun },
  { day: 'Sun', high: 23, low: 12, sky: Sun }
]
const hours = Array.from({ length: 13 }, (_, i) => ({
  hour: \`\${6 + i}:00\`,
  temp: Math.round(13 + 11 * Math.sin((i / 12) * Math.PI))
}))
const heat = (t) => (t >= 22 ? 'var(--chart-5)' : t >= 19 ? 'var(--chart-3)' : 'var(--chart-2)')

export default function App() {
  return (
    <div className="space-y-4">
      <Hero />
      <Week />
      <Hourly />
      <Rings />
    </div>
  )
}

function Hero() {
  const temp = useCountUp(24)
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl p-6"
      style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--chart-1) 34%, var(--surface-2)), var(--surface-2) 65%)' }}
    >
      <motion.div
        className="absolute -right-6 -top-6 text-artifact-warning"
        animate={{ rotate: 360 }}
        transition={{ duration: 18, repeat: Infinity, ease: 'linear' }}
      >
        <Sun size={150} strokeWidth={1.2} />
      </motion.div>
      <div className="text-sm text-artifact-secondary">Backyard station · Wednesday</div>
      <div className="mt-1 text-7xl font-semibold tabular-nums">{temp}°</div>
      <div className="mt-1 text-artifact-secondary">Sunny, a light breeze from the west</div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Pill icon={Droplets} label="Humidity" value="48%" />
        <Pill icon={Wind} label="Wind" value="14 km/h" />
        <Pill icon={Gauge} label="Pressure" value="1018 hPa" />
      </div>
    </motion.div>
  )
}

function Pill({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm" style={{ background: 'color-mix(in srgb, var(--surface-1) 70%, transparent)' }}>
      <Icon size={15} className="text-artifact-muted" />
      <span className="text-artifact-muted">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

function Week() {
  return (
    <div className="grid grid-cols-7 gap-2">
      {week.map((d, i) => (
        <motion.div
          key={d.day}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06 }}
          className="flex flex-col items-center gap-2 rounded-xl bg-artifact-surface py-3"
        >
          <span className="text-xs text-artifact-muted">{d.day}</span>
          <d.sky size={22} style={{ color: heat(d.high) }} />
          <div className="flex h-16 w-2 items-end rounded-full" style={{ background: 'var(--surface-3)' }}>
            <motion.div
              className="w-2 rounded-full"
              style={{ background: heat(d.high) }}
              initial={{ height: 0 }}
              animate={{ height: \`\${((d.high - 8) / 18) * 100}%\` }}
              transition={{ delay: 0.2 + i * 0.06, type: 'spring', stiffness: 120 }}
            />
          </div>
          <span className="text-sm font-medium tabular-nums">{d.high}°</span>
        </motion.div>
      ))}
    </div>
  )
}

function Hourly() {
  return (
    <div className="rounded-xl bg-artifact-surface p-4">
      <div className="mb-2 text-sm text-artifact-secondary">Today, hour by hour</div>
      <div style={{ height: 170 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={hours} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="warm" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-3)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="var(--chart-3)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="hour" tickLine={false} axisLine={false} interval={2} />
            <YAxis width={32} tickLine={false} axisLine={false} unit="°" />
            <Tooltip />
            <Area type="monotone" dataKey="temp" stroke="var(--chart-3)" strokeWidth={2.5} fill="url(#warm)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function Rings() {
  const rings = [
    { label: 'UV index', value: 6, max: 11, color: 'var(--chart-5)' },
    { label: 'Air quality', value: 32, max: 100, color: 'var(--chart-2)' },
    { label: 'Rain chance', value: 10, max: 100, color: 'var(--chart-1)' }
  ]
  return (
    <div className="grid grid-cols-3 gap-2">
      {rings.map((r) => (
        <div key={r.label} className="flex items-center gap-3 rounded-xl bg-artifact-surface p-3">
          <svg width="46" height="46" viewBox="0 0 46 46">
            <circle cx="23" cy="23" r="19" fill="none" stroke="var(--surface-3)" strokeWidth="5" />
            <motion.circle
              cx="23" cy="23" r="19" fill="none" stroke={r.color} strokeWidth="5" strokeLinecap="round"
              transform="rotate(-90 23 23)" strokeDasharray={119.4}
              initial={{ strokeDashoffset: 119.4 }}
              animate={{ strokeDashoffset: 119.4 * (1 - r.value / r.max) }}
              transition={{ duration: 1.1, ease: 'easeOut' }}
            />
          </svg>
          <div>
            <div className="text-lg font-semibold tabular-nums">{r.value}</div>
            <div className="text-xs text-artifact-muted">{r.label}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function useCountUp(target) {
  const [value, setValue] = React.useState(0)
  React.useEffect(() => {
    let frame
    const start = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 900)
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return value
}
`

/** The evening sky: violet light, the moon instead of the sun, and the evening reading. */
export const EVENING_EDITS = [
  {
    old_text:
      'linear-gradient(135deg, color-mix(in srgb, var(--chart-1) 34%, var(--surface-2)), var(--surface-2) 65%)',
    new_text:
      'linear-gradient(135deg, color-mix(in srgb, var(--chart-4) 42%, var(--surface-2)), color-mix(in srgb, var(--chart-5) 14%, var(--surface-2)) 70%)'
  },
  {
    old_text: '<Sun size={150} strokeWidth={1.2} />',
    new_text: '<Moon size={150} strokeWidth={1.2} />'
  },
  { old_text: 'useCountUp(24)', new_text: 'useCountUp(17)' },
  { old_text: 'Backyard station · Wednesday', new_text: 'Backyard station · Wednesday evening' },
  { old_text: 'Sunny, a light breeze from the west', new_text: 'Clear skies, cooling after sunset' }
]
