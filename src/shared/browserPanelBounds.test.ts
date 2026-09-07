import { expect, it } from 'vitest'
import { clipBrowserPanelBounds } from './browserPanelBounds'

it('intersects panels clipped on either side without extending their opposite edge', () => {
  expect(clipBrowserPanelBounds({ x: -20, y: -10, width: 100, height: 60 }, 200, 100)).toEqual({
    x: 0,
    y: 0,
    width: 80,
    height: 50
  })
  expect(clipBrowserPanelBounds({ x: 90, y: 80, width: 100, height: 60 }, 120, 100)).toEqual({
    x: 90,
    y: 80,
    width: 30,
    height: 20
  })
})
it('unmounts offscreen, empty, nonfinite and subpixel panels', () => {
  for (const bounds of [
    { x: 210, y: 0, width: 100, height: 50 },
    { x: 0, y: 110, width: 100, height: 50 },
    { x: 0, y: 0, width: 0, height: 50 },
    { x: NaN, y: 0, width: 100, height: 50 },
    { x: 0.8, y: 0, width: 0.5, height: 50 }
  ])
    expect(clipBrowserPanelBounds(bounds, 200, 100)).toBeNull()
})
it('clips stale zoomed layout against current smaller host using inward rounding', () => {
  expect(clipBrowserPanelBounds({ x: 50.5, y: 10.2, width: 200, height: 100 }, 150, 90)).toEqual({
    x: 51,
    y: 11,
    width: 99,
    height: 79
  })
})
