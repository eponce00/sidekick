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
import { closeArtifactDraft } from './utils/artifactDraft'
import {
  DRAFT_CHILD,
  DRAFT_COMPONENT,
  DRAFT_HOLE,
  DRAFT_PLACEHOLDER,
  draftTransformPlugin
} from './utils/artifactDraftTransform'
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

/** Recharts series that animate as they appear and as their data changes. */
const ANIMATED_SERIES = [
  'Area',
  'Bar',
  'Funnel',
  'Line',
  'Pie',
  'Radar',
  'RadialBar',
  'Sankey',
  'Scatter',
  'SunburstChart',
  'Treemap'
] as const

/**
 * Charts that appear already drawn. A draft redraws its charts as more code arrives, and a version
 * replacing one the user already sees should not draw its charts in again: in either, an entrance
 * animation replays, unfinished, every time. Set before the artifact's code first runs.
 */
function stillCharts(): void {
  const still: Record<string, unknown> = { ...Recharts }
  for (const name of ANIMATED_SERIES) {
    const Series = (Recharts as Record<string, unknown>)[name] as React.ElementType | undefined
    if (!Series) continue
    const StillSeries = (props: Record<string, unknown>): React.ReactElement =>
      React.createElement(Series, { ...props, isAnimationActive: false })
    StillSeries.displayName = name
    still[name] = StillSeries
  }
  LIBS.recharts = asEsModule(still)
  Chart.defaults.animation = false
}

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

const PRELUDE = `
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
`

// Names the code may use without defining them: the prelude's, and the page's own globals.
const PRELUDE_NAMES = new Set([
  'require',
  'module',
  'exports',
  ...[...PRELUDE.matchAll(/var\s+(?:\{([^}]*)\}|(\w+))/g)].flatMap((match) =>
    (match[1] ?? match[2]!).split(',').map((name) => name.trim())
  )
])
const providedToCode = (name: string): boolean => PRELUDE_NAMES.has(name) || name in window

/** Where a draft uses a component it has not defined yet. */
function DraftPlaceholder(): React.ReactElement {
  return React.createElement('div', {
    className: 'sidekick-draft-placeholder',
    'aria-hidden': true
  })
}

let reactRoot: ReactDOM.Root | null = null
let activeTheme: ArtifactTheme | null = null
let activeComponent: React.ElementType | null = null
let activeErrorHandler: ((err: Error) => void) | null = null
/** A frame runs either the finished artifact or drafts of it, decided by its first command. */
let frameMode: 'run' | 'draft' | null = null

const PRESETS = [
  'react',
  ['typescript', { isTSX: true, allExtensions: true }]
] as unknown as string[]

/**
 * The artifact's component. Its code runs in a scope of its own inside the prelude's, so it may
 * declare names the prelude also provides, such as `theme` or `Tooltip`, without a syntax error.
 * Models often write TypeScript in a component; its types are dropped, not rejected. (Babel's
 * typings only know presets by name, though it takes a name with options too.)
 */
function compileArtifact(code: string, draft: boolean): React.ElementType | null {
  const prepared = draft
    ? Babel.transform(code, {
        presets: PRESETS,
        plugins: [draftTransformPlugin(providedToCode)] as unknown as string[],
        filename: 'artifact.tsx'
      }).code
    : code
  const transpiled = Babel.transform(prepared ?? '', {
    presets: draft ? [] : PRESETS,
    plugins: ['transform-modules-commonjs'],
    filename: 'artifact.tsx'
  }).code
  if (!transpiled) throw new Error('Transpilation returned empty code')
  const factory = new Function(
    'require',
    'module',
    'exports',
    '__theme__',
    '__resolveArtifactComponent',
    DRAFT_COMPONENT,
    DRAFT_PLACEHOLDER,
    DRAFT_HOLE,
    DRAFT_CHILD,
    `${PRELUDE}
return (function () {
${transpiled}
return __resolveArtifactComponent(
  typeof module !== 'undefined' ? module.exports : undefined,
  typeof App !== 'undefined' ? App : undefined
);
})();`
  )
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  const component = factory(
    sandboxRequire,
    moduleObj,
    moduleObj.exports,
    activeTheme || {},
    resolveArtifactComponent,
    draftComponent,
    DraftPlaceholder,
    draftHole,
    draftChild
  )
  return component && (typeof component === 'function' || typeof component === 'object')
    ? (component as React.ElementType)
    : null
}

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

function root(): ReactDOM.Root {
  reactRoot ??= ReactDOM.createRoot(document.getElementById('root')!)
  return reactRoot
}

function renderActiveComponent(): void {
  if (frameMode === 'draft') {
    renderDraftComponent()
    return
  }
  if (!activeComponent || !activeErrorHandler) return
  root().render(
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
    const AppComponent = compileArtifact(code, false)
    if (!AppComponent) {
      postToHost({ type: 'error', error: 'Artifact must define a component named "App".' })
      return
    }

    let errorReported = false
    const handleError = (err: Error): void => {
      if (errorReported) return
      errorReported = true
      postToHost({ type: 'error', error: err.message })
    }

    activeComponent = AppComponent
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

// ---------------------------------------------------------------------------
// Drafts: the artifact taking shape while the model writes it
// ---------------------------------------------------------------------------

// Each draft is compiled anew, but its components stay the same React components from one draft
// to the next, registered by name; React then changes only what the newer code changed, so what is
// already shown stays exactly where it is. A part that cannot run yet keeps what it last showed,
// in place, or a still placeholder, while the rest of the draft renders.

let draftSource = ''
let draftKey = 0
let draftRoot: React.ElementType | null = null
const latestParts = new Map<string, React.ElementType>()
const shownParts = new Map<string, React.ElementType>()
const draftParts = new Map<string, React.ElementType>()
const DRAFT_PART = Symbol('sidekick-draft-part')

const ARRAY_RESULTS = new Set(['map', 'filter', 'flatMap', 'slice', 'concat', 'sort', 'reverse'])

/**
 * A value the draft uses before defining it, such as data still to come: empty as a list, blank
 * as text, and itself again when read from or called.
 */
// A function, so the proxy can be called and constructed.
const draftHole: unknown = new Proxy(
  function hole() {
    return undefined
  },
  {
    get(_target, key) {
      if (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf') return () => ''
      if (key === Symbol.iterator) return () => [][Symbol.iterator]()
      if (key === 'length') return 0
      if (typeof key === 'string' && ARRAY_RESULTS.has(key)) return () => []
      return draftHole
    },
    apply: () => draftHole,
    construct: () => draftHole as object,
    has: () => false
  }
)

/** A value placed among elements: one still to come renders as nothing. */
function draftChild(value: unknown): unknown {
  if (value === draftHole) return null
  return Array.isArray(value) ? value.map(draftChild) : value
}

/** Runs one version of a part: a plain call, so the part's state stays with the part. */
function DraftVersion({
  render,
  props
}: {
  render: (props: Record<string, unknown>) => React.ReactNode
  props: Record<string, unknown>
}): React.ReactNode {
  return render(props)
}

function makeDraftPart(name: string): React.ElementType {
  class DraftPart extends ReactComponent<
    Record<string, unknown>,
    { failedAt: number; hooksChanged: boolean }
  > {
    static displayName = name
    state = { failedAt: -1, hooksChanged: false }
    private mount = 0
    private attemptAt = -1
    private attempt = 0
    static getDerivedStateFromError(error: unknown): { failedAt: number; hooksChanged: boolean } {
      return {
        failedAt: draftKey,
        hooksChanged: /hook/i.test(error instanceof Error ? error.message : String(error))
      }
    }
    componentDidCatch(): void {
      // A part that cannot run yet is expected; the next draft usually completes it.
    }
    componentDidMount(): void {
      this.shown()
    }
    componentDidUpdate(): void {
      this.shown()
    }
    private shown(): void {
      if (this.state.failedAt !== draftKey) shownParts.set(name, latestParts.get(name)!)
    }
    render(): React.ReactNode {
      const version = (render: React.ElementType | undefined): React.ReactNode =>
        render
          ? React.createElement(DraftVersion, {
              key: this.mount,
              render: render as (props: Record<string, unknown>) => React.ReactNode,
              props: this.props
            })
          : React.createElement(DraftPlaceholder)
      if (this.state.failedAt !== draftKey) return version(latestParts.get(name))
      if (this.attemptAt !== draftKey) {
        this.attemptAt = draftKey
        this.attempt = 0
      }
      this.attempt += 1
      // First, what it showed before, in the same place: same state, same elements, nothing moves.
      if (this.attempt === 1 && !this.state.hooksChanged) return version(shownParts.get(name))
      // A draft that added or removed a hook cannot reuse the state before it: once, start afresh.
      if (this.attempt <= 2) {
        this.mount += 1
        return version(latestParts.get(name))
      }
      return version(shownParts.get(name))
    }
  }
  ;(DraftPart as unknown as Record<symbol, boolean>)[DRAFT_PART] = true
  return DraftPart
}

/** Registers a component of the draft by name and gives back the part that runs it. */
function draftComponent(name: string, component: unknown): unknown {
  const candidate = component as { prototype?: { isReactComponent?: unknown } } & Record<
    symbol,
    unknown
  >
  if (
    typeof component !== 'function' ||
    candidate[DRAFT_PART] ||
    candidate.prototype?.isReactComponent
  )
    return component
  latestParts.set(name, component as React.ElementType)
  let part = draftParts.get(name)
  if (!part) {
    part = makeDraftPart(name)
    draftParts.set(name, part)
  }
  return part
}

function enterDraftMode(): void {
  frameMode = 'draft'
  stillCharts()
  // A draft only shows: its requests never return, so it waits in its loading state instead of
  // asking the network for every draft, and nothing in it moves, flashes or fades: new parts
  // simply appear where they belong.
  window.fetch = () => new Promise<Response>(() => undefined)
  XMLHttpRequest.prototype.send = () => undefined
  FramerMotion.MotionGlobalConfig.skipAnimations = true
  const style = document.createElement('style')
  style.textContent = `
*, *::before, *::after { transition: none !important; animation: none !important; }
.sidekick-draft-placeholder {
  min-height: 2.5rem;
  border-radius: var(--radius-md, 10px);
  background: var(--surface-2);
  opacity: 0.6;
}`
  document.head.appendChild(style)
}

function renderDraftComponent(): void {
  if (draftRoot) root().render(React.createElement(draftRoot))
}

function renderDraft(code: string, theme: ArtifactTheme): void {
  updateTheme(theme)
  const closed = closeArtifactDraft(code)
  if (!closed || closed === draftSource) return
  draftSource = closed
  let component: React.ElementType | null
  try {
    component = compileArtifact(closed, true)
  } catch {
    // Not runnable yet; the last draft that ran stays.
    return
  }
  if (!component) return
  draftKey += 1
  draftRoot = draftComponent('App', component) as React.ElementType
  renderDraftComponent()
}

reportErrorsToHost(() => frameMode !== 'draft')
reportPointerToHost()

listenToHost((command) => {
  if (command.type === 'draft') {
    if (frameMode === null) enterDraftMode()
    if (frameMode === 'draft') renderDraft(command.code, command.theme)
  } else if (command.type === 'render') {
    if (frameMode === 'draft') return
    frameMode = 'run'
    if (command.still) stillCharts()
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
  frameMode = 'run'
  void import('./dev/artifactSandboxPreview').then(({ artifactSandboxPreviewCode }) =>
    renderCode(artifactSandboxPreviewCode, getArtifactFallbackTheme(mode))
  )
}
