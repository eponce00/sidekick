import { describe, expect, it } from 'vitest'
import { resolveArtifactComponent } from './artifactModule'

describe('artifact module component resolution', () => {
  it('uses a lexical App when Babel leaves empty CommonJS exports', () => {
    const App = (): null => null

    expect(resolveArtifactComponent({}, App)).toBe(App)
  })

  it('supports default, named, and direct CommonJS component exports', () => {
    const DefaultApp = (): null => null
    const NamedApp = (): null => null
    const CommonJsApp = (): null => null

    expect(resolveArtifactComponent({ default: DefaultApp }, null)).toBe(DefaultApp)
    expect(resolveArtifactComponent({ App: NamedApp }, null)).toBe(NamedApp)
    expect(resolveArtifactComponent(CommonJsApp, null)).toBe(CommonJsApp)
  })

  it('rejects arbitrary objects as React component types', () => {
    expect(resolveArtifactComponent({ default: { chart: true } }, null)).toBeNull()
  })
})
