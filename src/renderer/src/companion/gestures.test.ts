import { describe, expect, it } from 'vitest'
import { swipeOffset } from './gestures'

describe('swipeOffset', () => {
  it('follows a sheet dragged down and the drawer dragged left', () => {
    expect(swipeOffset('down', 4, 60)).toBe(60)
    expect(swipeOffset('left', -90, 10)).toBe(90)
  })

  it('ignores drags the other way and drags that are mostly across', () => {
    expect(swipeOffset('down', 0, -40)).toBe(0)
    expect(swipeOffset('left', 30, 0)).toBe(0)
    expect(swipeOffset('down', 50, 20)).toBe(0)
    expect(swipeOffset('left', -20, 60)).toBe(0)
  })
})
