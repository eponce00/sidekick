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
import { installArtifactContrastGuard } from './utils/artifactContrast'
import { resolveArtifactComponent } from './utils/artifactModule'
import {
  applyArtifactTheme,
  getArtifactFallbackTheme,
  type ArtifactTheme
} from './utils/artifactTheme'
import './styles/artifactSandbox.css'

Chart.register(...registerables)
installArtifactContrastGuard(document)

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
          style: { color: '#f44', padding: 8, fontSize: 13 }
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

function postToParent(msg: Record<string, unknown>): void {
  window.parent.postMessage(msg, '*')
}

function reportHeight(): void {
  const root = document.getElementById('root')
  if (!root) return
  const rootRectHeight = Math.ceil(root.getBoundingClientRect().height)
  const height = Math.max(
    root.scrollHeight,
    rootRectHeight,
    root.offsetHeight,
    document.body.scrollHeight,
    document.body.offsetHeight,
    document.documentElement.scrollHeight,
    document.documentElement.offsetHeight
  )
  postToParent({ type: 'resize', height })
}

const resizeObserver = new ResizeObserver(() => reportHeight())

function updateTheme(theme: ArtifactTheme): ArtifactTheme {
  if (activeTheme) Object.assign(activeTheme, theme)
  else activeTheme = { ...theme }
  applyArtifactTheme(document, activeTheme)
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
    postToParent({
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
      postToParent({ type: 'error', error: 'Transpilation returned empty code' })
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
      postToParent({ type: 'error', error: 'Artifact must define a component named "App".' })
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
      postToParent({ type: 'error', error: err.message })
    }

    activeComponent = AppComponent as React.ElementType
    activeErrorHandler = handleError
    renderActiveComponent()

    resizeObserver.disconnect()
    resizeObserver.observe(container)
    resizeObserver.observe(document.body)

    // Some layouts/charts settle after the initial render tick.
    requestAnimationFrame(() => {
      reportHeight()
      requestAnimationFrame(reportHeight)
    })
    setTimeout(reportHeight, 150)
    setTimeout(reportHeight, 500)

    setTimeout(() => {
      if (!errorReported) {
        postToParent({ type: 'success' })
        reportHeight()
      }
    }, 800)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    postToParent({ type: 'error', error: msg })
  }
}

window.addEventListener('error', (event) => {
  postToParent({ type: 'error', error: event.message || 'Uncaught error' })
})
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason)
  postToParent({ type: 'error', error: msg })
})

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  if (event.data?.type === 'render') {
    void renderCode(event.data.code, event.data.theme)
  } else if (event.data?.type === 'theme-update' && event.data.theme) {
    updateTheme(event.data.theme)
    renderActiveComponent()
    requestAnimationFrame(reportHeight)
  }
})

postToParent({ type: 'ready' })

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('artifact-preview')) {
  const mode =
    new URLSearchParams(window.location.search).get('theme') === 'light' ? 'light' : 'dark'
  void import('./dev/artifactSandboxPreview').then(({ artifactSandboxPreviewCode }) =>
    renderCode(artifactSandboxPreviewCode, getArtifactFallbackTheme(mode))
  )
}
