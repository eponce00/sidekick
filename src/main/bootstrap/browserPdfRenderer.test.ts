import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const viewport = { width: 612, height: 792 }
  const render = vi.fn(() => ({ promise: Promise.resolve() }))
  const getViewport = vi.fn(() => viewport)
  const getPage = vi.fn(async () => ({ getViewport, render }))
  const destroy = vi.fn(async () => {})
  const getDocument = vi.fn((_options: { data: Uint8Array }) => ({
    promise: Promise.resolve({ numPages: 1, getPage }),
    destroy
  }))
  const createCanvas = vi.fn(() => ({
    getContext: vi.fn(() => ({})),
    toBuffer: vi.fn(() => Buffer.from('synthetic-png'))
  }))
  return { viewport, render, getViewport, getPage, destroy, getDocument, createCanvas }
})

vi.mock('electron', () => ({ app: { getAppPath: () => '/fixture' } }))
vi.mock('fs', () => ({
  existsSync: () => true,
  promises: { readFile: vi.fn(async () => Buffer.from('synthetic-input')) }
}))
vi.mock('url', () => ({ pathToFileURL: () => ({ href: 'pdfjs-dist/legacy/build/pdf.mjs' }) }))
vi.mock('module', () => ({ createRequire: () => () => ({ createCanvas: fixture.createCanvas }) }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: fixture.getDocument,
  AnnotationMode: { DISABLE: 0 }
}))

import { renderBrowserPdfPage } from './browserPdfRenderer'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.viewport.width = 612
  fixture.viewport.height = 792
})

describe('native PDF render allocation budget', () => {
  it('copies source bytes before PDF.js can transfer its input buffer', async () => {
    const source = new Uint8Array([1, 2, 3])
    await renderBrowserPdfPage(source, 1, 2)
    const received = fixture.getDocument.mock.calls[0]?.[0] as unknown as { data: Uint8Array }
    expect(received.data).not.toBe(source)
    structuredClone(received.data, { transfer: [received.data.buffer] })
    expect([...source]).toEqual([1, 2, 3])
  })
  it.each([
    [Infinity, 792],
    [NaN, 792],
    [-1, 792],
    [0, 792],
    [612, Infinity],
    [16_385, 1],
    [1, 16_385],
    [8_000, 5_001],
    [8_000.1, 5_000],
    [16_384.1, 1],
    [Number.MAX_VALUE, 2]
  ])('rejects viewport %s by %s before native canvas allocation', async (width, height) => {
    Object.assign(fixture.viewport, { width, height })
    await expect(renderBrowserPdfPage(Buffer.from('synthetic-input'), 1, 2)).rejects.toThrow(
      /PDF page render/
    )
    expect(fixture.createCanvas).not.toHaveBeenCalled()
    expect(fixture.render).not.toHaveBeenCalled()
    expect(fixture.destroy).toHaveBeenCalledOnce()
  })

  it('preserves valid viewport geometry and renders exactly once', async () => {
    Object.assign(fixture.viewport, { width: 612.25, height: 792.5 })
    expect(await renderBrowserPdfPage(Buffer.from('synthetic-input'), 1, 2)).toEqual(
      Buffer.from('synthetic-png')
    )
    expect(fixture.createCanvas).toHaveBeenCalledWith(613, 793)
    expect(fixture.getViewport).toHaveBeenCalledWith({ scale: 2 })
    expect(fixture.render).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: fixture.viewport })
    )
    expect(fixture.destroy).toHaveBeenCalledOnce()
  })

  it.each([0, -1, NaN, Infinity])(
    'rejects invalid scale %s before loading PDF bytes',
    async (scale) => {
      await expect(renderBrowserPdfPage(Buffer.from('synthetic-input'), 1, scale)).rejects.toThrow(
        'finite positive'
      )
      expect(fixture.getDocument).not.toHaveBeenCalled()
      expect(fixture.createCanvas).not.toHaveBeenCalled()
    }
  )

  it.each([
    [16_384, 1],
    [1, 16_384],
    [8_000, 5_000]
  ])('accepts budget boundary %s by %s without resizing', async (width, height) => {
    Object.assign(fixture.viewport, { width, height })
    await renderBrowserPdfPage(Buffer.from('synthetic-input'), 1, 2)
    expect(fixture.createCanvas).toHaveBeenCalledWith(width, height)
    expect(fixture.render).toHaveBeenCalledOnce()
    expect(fixture.destroy).toHaveBeenCalledOnce()
  })

  it('destroys the PDF loading task when native allocation fails for an otherwise valid page', async () => {
    fixture.createCanvas.mockImplementationOnce(() => {
      throw new Error('synthetic allocation failure')
    })
    await expect(renderBrowserPdfPage(Buffer.from('synthetic-input'), 1, 2)).rejects.toThrow(
      'synthetic allocation failure'
    )
    expect(fixture.render).not.toHaveBeenCalled()
    expect(fixture.destroy).toHaveBeenCalledOnce()
  })
})
