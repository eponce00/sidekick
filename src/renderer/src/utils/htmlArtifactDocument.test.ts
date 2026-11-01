import { describe, expect, it } from 'vitest'
import { buildArtifactDocument, svgArtifactDocument } from './htmlArtifactDocument'

const HEAD = '<style id="sidekick-base">body{}</style>'

describe('HTML artifact document', () => {
  it('puts SideKick first in the head, so the artifact’s own styles come later and win', () => {
    const html = buildArtifactDocument(
      '<!doctype html><html><head><style id="generated">button{color:red}</style></head><body><button>Go</button></body></html>',
      HEAD
    )

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.indexOf('sidekick-base')).toBeLessThan(html.indexOf('id="generated"'))
    expect(html).toContain('<button>Go</button>')
  })

  it('gives a document without a doctype one, so it is not laid out in quirks mode', () => {
    const html = buildArtifactDocument('<html><body><p>Hello</p></body></html>', HEAD)

    expect(html).toMatch(/^<!DOCTYPE html>\n<html>\n<head><style id="sidekick-base">/)
    expect(html).toContain('<p>Hello</p>')
  })

  it('wraps a fragment in a document with a head', () => {
    const html = buildArtifactDocument('<p>Fragment</p><script>go()</script>', HEAD)

    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toMatch(/<head>\n<style id="sidekick-base">/)
    expect(html).toContain('<p>Fragment</p><script>go()</script>')
  })

  it('does not treat a replacement pattern in the head as one', () => {
    const html = buildArtifactDocument('<html><head></head><body></body></html>', "$&$'")
    expect(html).toContain("<head>\n$&$'")
  })

  it('shows an SVG artifact as a document of its own', () => {
    const html = svgArtifactDocument('  <svg viewBox="0 0 10 10"><rect /></svg>\n')

    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<body>\n<svg viewBox="0 0 10 10"><rect /></svg>\n</body>')
    expect(html).toContain('@layer sidekick')
  })
})
