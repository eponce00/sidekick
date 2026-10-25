import React, { Component as ReactComponent } from 'react'
import ReactDOM from 'react-dom/client'
import * as Babel from '@babel/standalone'
import { Chart, registerables } from 'chart.js'
import * as Recharts from 'recharts'
import * as FramerMotion from 'framer-motion'
import * as LucideReact from 'lucide-react'
import * as lodash from 'lodash'
import * as mathjs from 'mathjs'
import L from 'leaflet'
import * as ReactLeaflet from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import * as d3 from 'd3'
import * as dateFns from 'date-fns'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import { installArtifactContrastGuard } from './utils/artifactContrast'
import {
  listenToHost,
  postToHost,
  reportErrorsToHost,
  reportPointerToHost,
  watchContentHeight
} from './utils/artifactFrameChannel'
import { resolveArtifactComponent } from './utils/artifactModule'
import {
  applyArtifactTheme,
  getArtifactFallbackTheme,
  type ArtifactTheme
} from './utils/artifactTheme'
import './styles/artifactTokens.css'
import './styles/artifactBase.css'
import artifactBaseCss from './styles/artifactBase.css?raw'

Chart.register(...registerables)
installArtifactContrastGuard(document)

// Tailwind's reset is not in a cascade layer, so it would undo SideKick's base layer for buttons,
// fields and headings. Given again as Tailwind's own base layer, the same rules land after its
// reset and before its utilities. Without Tailwind (offline), this element is ignored.
const tailwindBase = document.createElement('style')
tailwindBase.setAttribute('type', 'text/tailwindcss')
tailwindBase.textContent = artifactBaseCss.replace(/@layer\s+sidekick\s*\{/, '@layer base {')
document.head.appendChild(tailwindBase)

// ---------------------------------------------------------------------------
// Library map: package name -> pre-loaded module
// Babel's commonjs transform converts imports to require() calls.
// We provide a custom require() that resolves from this map.
// ---------------------------------------------------------------------------

// Mark modules with __esModule so Babel's interop helpers work correctly
// (e.g., `import Default from 'react'` resolves to `require('react').default`)
function asEsModule<T extends object>(mod: T): T & { __esModule: true; default: T } {
  return {
    ...mod,
    __esModule: true as const,
    default: mod
  }
}

const ReactModule = { ...React, __esModule: true as const, default: React }

const LIBS: Record<string, unknown> = {
  react: ReactModule,
  'react-dom': { __esModule: true, default: ReactDOM, createRoot: ReactDOM.createRoot },
  'react-dom/client': { __esModule: true, default: ReactDOM, createRoot: ReactDOM.createRoot },
  recharts: asEsModule(Recharts),
  'chart.js': { __esModule: true, default: Chart, Chart, registerables },
  'chart.js/auto': { __esModule: true, default: Chart, Chart },
  chartjs: { __esModule: true, default: Chart, Chart },
  'framer-motion': asEsModule(FramerMotion),
  'lucide-react': asEsModule(LucideReact),
  lodash: { __esModule: true, default: lodash, ...lodash },
  'lodash-es': { __esModule: true, default: lodash, ...lodash },
  mathjs: asEsModule(mathjs),
  'math.js': asEsModule(mathjs),
  leaflet: { __esModule: true, default: L, ...L },
  'react-leaflet': asEsModule(ReactLeaflet),
  d3: asEsModule(d3),
  'date-fns': asEsModule(dateFns)
}

const SUPPORTED_IMPORTS = Object.keys(LIBS)

// ---------------------------------------------------------------------------
// CDN fallback — unknown packages are fetched from esm.sh before execution
// ---------------------------------------------------------------------------

const cdnCache = new Map<string, unknown>()

async function loadFromCDN(packageId: string): Promise<unknown> {
  if (cdnCache.has(packageId)) return cdnCache.get(packageId)!
  // ?bundle inlines all deps into one self-contained ES module
  const resp = await fetch(`https://esm.sh/${packageId}?bundle&target=es2022`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
  const text = await resp.text()
  const blob = new Blob([text], { type: 'text/javascript' })
  const blobUrl = URL.createObjectURL(blob)
  try {
    const mod = await (import(/* @vite-ignore */ blobUrl) as Promise<Record<string, unknown>>)
    const wrapped: Record<string, unknown> = {
      ...mod,
      __esModule: true,
      default: mod.default ?? mod
    }
    cdnCache.set(packageId, wrapped)
    LIBS[packageId] = wrapped
    return wrapped
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * Scans code for any imports not already in LIBS, pre-fetches them from esm.sh.
 * Returns the package IDs that could NOT be loaded (network error or 404).
 */
async function prefetchCDNImports(code: string): Promise<string[]> {
  const pattern = /(?:import\s[^'"]*from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  const seen = new Set<string>()
  for (const m of code.matchAll(pattern)) {
    const id = m[1]
    if (id && !id.startsWith('.') && !id.startsWith('node:') && !LIBS[id]) seen.add(id)
  }
  if (seen.size === 0) return []

  const failed: string[] = []
  await Promise.allSettled(
    [...seen].map(async (id) => {
      try {
        await loadFromCDN(id)
        console.log(`[Sandbox] CDN loaded: ${id}`)
      } catch (e) {
        console.warn(`[Sandbox] CDN failed for "${id}":`, e)
        failed.push(id)
      }
    })
  )
  return failed
}

function sandboxRequire(id: string): unknown {
  const mod = LIBS[id]
  if (mod) return mod
  throw new Error(`Module "${id}" is not available. Pre-bundled: ${SUPPORTED_IMPORTS.join(', ')}`)
}

// ---------------------------------------------------------------------------
// Error Boundary
// ---------------------------------------------------------------------------

interface EBProps {
  children?: React.ReactNode
  onError: (err: Error) => void
}
interface EBState {
  hasError: boolean
  error: Error | null
}

class SandboxErrorBoundary extends ReactComponent<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error): void {
    this.props.onError(error)
  }
  render(): React.ReactNode {
    if (this.state.hasError) {
      return React.createElement(
        'div',
        {
          style: { color: 'var(--color-error)', fontSize: 'var(--content-text)' }
        },
        `Runtime Error: ${this.state.error?.message || 'Unknown'}`
      )
    }
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

let reactRoot: ReactDOM.Root | null = null
let activeTheme: ArtifactTheme | null = null
let activeComponent: React.ElementType | null = null
let activeErrorHandler: ((err: Error) => void) | null = null

const contentHeight = watchContentHeight(document, (height) =>
  postToHost({ type: 'resize', height })
)
const reportHeight = contentHeight.measure

function updateTheme(theme: ArtifactTheme): ArtifactTheme {
  if (activeTheme) Object.assign(activeTheme, theme)
  else activeTheme = { ...theme }
  applyArtifactTheme(document, activeTheme)
  // Canvas charts cannot read CSS variables, so Chart.js gets the theme as its defaults.
  Chart.defaults.color = activeTheme.textSecondary
  Chart.defaults.borderColor = activeTheme.border
  Chart.defaults.font.family = activeTheme.fontSans
  document.dispatchEvent(new Event('sidekick-artifact-themechange'))
  return activeTheme
}

function renderActiveComponent(): void {
  if (!reactRoot || !activeComponent || !activeErrorHandler) return
  reactRoot.render(
    React.createElement(
      SandboxErrorBoundary,
      { onError: activeErrorHandler },
      React.createElement(activeComponent)
    )
  )
}

async function renderCode(code: string, theme?: ArtifactTheme): Promise<void> {
  if (theme) updateTheme(theme)

  // Pre-fetch any imports not in pre-bundled LIBS. Successful CDN fetches are
  // stored in LIBS so sandboxRequire resolves them normally.
  const unavailable = await prefetchCDNImports(code)
  if (unavailable.length > 0) {
    postToHost({
      type: 'error',
      error:
        `Could not load package${unavailable.length > 1 ? 's' : ''} from CDN: ${unavailable.join(', ')}. ` +
        `Pre-bundled (always available): ${SUPPORTED_IMPORTS.join(', ')}`
    })
    return
  }

  try {
    // Babel handles EVERYTHING: JSX → createElement, imports → require(), exports → module.exports
    const transpiled = Babel.transform(code, {
      presets: ['react'],
      plugins: ['transform-modules-commonjs'],
      filename: 'artifact.tsx'
    }).code

    if (!transpiled) {
      postToHost({ type: 'error', error: 'Transpilation returned empty code' })
      return
    }

    // Provide require + module/exports so Babel's CommonJS output works,
    // plus common globals for code that skips imports entirely.
    const wrappedCode = `
var React = require('react').default || require('react');
var { Fragment, useState, useEffect, useMemo, useRef, useCallback, useReducer, useContext, createContext, memo, forwardRef, lazy, Suspense } = React;
var Recharts = require('recharts');
var { LineChart, Line, BarChart, Bar, PieChart, Pie, AreaChart, Area, ScatterChart, Scatter, RadarChart, Radar, RadialBarChart, RadialBar, ComposedChart, Treemap, Funnel, FunnelChart, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell, LabelList, Brush, ReferenceLine, ReferenceArea, ReferenceDot } = Recharts;
var Chart = require('chart.js').default || require('chart.js').Chart;
var framerMotion = require('framer-motion');
var motion = framerMotion.motion;
var lucideReact = require('lucide-react');
var _ = require('lodash').default || require('lodash');
var math = require('mathjs');
var Leaflet = require('leaflet');
var ReactLeaflet = require('react-leaflet');
var theme = __theme__;

${transpiled}

return __resolveArtifactComponent(
  typeof module !== 'undefined' ? module.exports : undefined,
  typeof App !== 'undefined' ? App : undefined
);
`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleObj: any = { exports: {} }
    const factory = new Function(
      'require',
      'module',
      'exports',
      '__theme__',
      '__resolveArtifactComponent',
      wrappedCode
    )
    const AppComponent = factory(
      sandboxRequire,
      moduleObj,
      moduleObj.exports,
      activeTheme || theme || {},
      resolveArtifactComponent
    )

    if (!AppComponent || (typeof AppComponent !== 'function' && typeof AppComponent !== 'object')) {
      postToHost({ type: 'error', error: 'Artifact must define a component named "App".' })
      return
    }

    const container = document.getElementById('root')!
    if (!reactRoot) {
      reactRoot = ReactDOM.createRoot(container)
    }

    let errorReported = false
    const handleError = (err: Error): void => {
      if (errorReported) return
      errorReported = true
      postToHost({ type: 'error', error: err.message })
    }

    activeComponent = AppComponent as React.ElementType
    activeErrorHandler = handleError
    renderActiveComponent()

    // Later layout, such as charts settling, reaches the chat through the content observer.
    reportHeight()

    setTimeout(() => {
      if (!errorReported) {
        postToHost({ type: 'success' })
        reportHeight()
      }
    }, 800)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    postToHost({ type: 'error', error: msg })
  }
}

reportErrorsToHost()
reportPointerToHost()

listenToHost((command) => {
  if (command.type === 'render') {
    void renderCode(command.code, command.theme)
  } else {
    updateTheme(command.theme)
    renderActiveComponent()
    reportHeight()
  }
})

postToHost({ type: 'ready' })

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('artifact-preview')) {
  const mode =
    new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark'
  void import('./dev/artifactSandboxPreview').then(({ artifactSandboxPreviewCode }) =>
    renderCode(artifactSandboxPreviewCode, getArtifactFallbackTheme(mode))
  )
}
