import { describe, expect, it } from 'vitest'
import {
  calculateContextCapacity,
  calculateRequestBudget,
  calibratedRequestTokens,
  estimateConversationTokens,
  estimateTextTokens,
  replyLimitForRequest,
  resolveMaxOutputTokens
} from './contextBudget'

describe('calculateRequestBudget', () => {
  it('bounds image token estimates without counting base64 as text', () => {
    expect(
      estimateConversationTokens([{ role: 'user', content: '', images: ['https://x.test/a.png'] }])
    ).toBe(772)
    // Unreadable: the largest square any provider is sent, 2048 px at 28 px a token.
    expect(
      estimateConversationTokens([{ role: 'user', content: '', images: ['x'.repeat(300_000)] }])
    ).toBe(74 * 74 + 4)
  })

  it('prices an image by its pixel size as sent, not by the size of its file', () => {
    const png = (width: number, height: number, padding = 0): string => {
      const bytes = new Uint8Array(24 + padding)
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
      const view = new DataView(bytes.buffer)
      view.setUint32(16, width)
      view.setUint32(20, height)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return `data:image/png;base64,${btoa(binary)}`
    }
    const tokens = (image: string): number =>
      estimateConversationTokens([{ role: 'user', content: '', images: [image] }]) - 4

    // A 5K screenshot is sent at 2048 × 1152 at most: 74 × 42 squares.
    expect(tokens(png(5120, 2880))).toBe(74 * 42)
    expect(tokens(png(5120, 2880, 3 * 1024 * 1024))).toBe(74 * 42)
    expect(tokens(png(1280, 800))).toBe(46 * 29)
    expect(tokens(png(64, 48))).toBe(512)
  })

  it('compacts at the threshold share of the whole window, as Settings describes it', () => {
    const budget = calculateRequestBudget({
      messages: [],
      tools: [],
      contextLength: 180_000,
      reservedOutputTokens: 32_000,
      compactionThreshold: 0.7
    })

    expect(budget.safetyMarginTokens).toBe(3_600)
    expect(budget.effectiveInputLimit).toBe(144_400)
    expect(budget.compactionTriggerTokens).toBe(126_000)
  })

  it('never lets a high threshold eat the room kept for the reply', () => {
    const budget = calculateRequestBudget({
      messages: [],
      tools: [],
      contextLength: 180_000,
      reservedOutputTokens: 32_000,
      compactionThreshold: 0.95
    })

    expect(budget.compactionTriggerTokens).toBe(budget.effectiveInputLimit)
  })

  it('keeps room for a reply, not the whole of a large reply limit', () => {
    // A 260k local model set to write up to 100k: holding all of it back compacted every chat at
    // under half its window, and an 80% or 95% setting barely moved the point.
    const at = (threshold: number) =>
      calculateContextCapacity({
        contextLength: 260_000,
        reservedOutputTokens: 100_000,
        compactionThreshold: threshold
      })

    expect(at(0.8)).toEqual({
      contextLength: 260_000,
      reservedOutputTokens: 32_768,
      safetyMarginTokens: 5_200,
      effectiveInputLimit: 222_032,
      compactionTriggerTokens: 208_000
    })
    expect(at(0.95).compactionTriggerTokens).toBe(222_032)
    expect(at(0.5).compactionTriggerTokens).toBe(130_000)
  })

  it('cuts a reply limit to the room the window has left, never below a usable floor', () => {
    const budget = { contextLength: 260_000, safetyMarginTokens: 5_200 }
    expect(replyLimitForRequest(100_000, { ...budget, requestTokens: 40_000 })).toBe(100_000)
    expect(replyLimitForRequest(100_000, { ...budget, requestTokens: 208_000 })).toBe(46_800)
    expect(replyLimitForRequest(100_000, { ...budget, requestTokens: 260_000 })).toBe(1_024)
    expect(replyLimitForRequest(undefined, { ...budget, requestTokens: 1_000 })).toBeUndefined()
  })

  it('triggers before the usable input budget is exhausted', () => {
    const budget = calculateRequestBudget({
      messages: [{ role: 'user', content: 'x'.repeat(130_000 * 4) }],
      tools: [],
      contextLength: 180_000,
      reservedOutputTokens: 32_000,
      compactionThreshold: 0.7
    })

    expect(budget.requestTokens).toBeLessThan(budget.effectiveInputLimit)
    expect(budget.shouldCompact).toBe(true)
  })

  it('honors a configured output budget above the default ceiling, up to half the window', () => {
    expect(resolveMaxOutputTokens(180_000)).toBe(32_768)
    // A local reasoning model with a 260k window, set to 100k output, was held to 32,768.
    expect(resolveMaxOutputTokens(260_000, 100_000)).toBe(100_000)
    expect(resolveMaxOutputTokens(131_072, 100_000)).toBe(65_536)
  })

  it('lets a catalog maximum lower the default reply limit but never raise it', () => {
    // A catalog that says a model can write 160K must not reserve half of every chat for it.
    expect(resolveMaxOutputTokens(163_840, undefined, 163_840)).toBe(32_768)
    expect(resolveMaxOutputTokens(1_000_000, undefined, 128_000)).toBe(32_768)
    expect(resolveMaxOutputTokens(200_000, undefined, 8_192)).toBe(8_192)
    expect(resolveMaxOutputTokens(260_000, 100_000, 8_192)).toBe(100_000)
  })

  it('does not treat dense numeric JSON like ordinary prose', () => {
    const dense = JSON.stringify({
      coordinates: Array.from({ length: 4_000 }, (_, index) => [index / 100, -index / 100])
    })

    expect(estimateTextTokens(dense)).toBeGreaterThan(dense.length / 2)
    expect(estimateTextTokens('ordinary prose with several readable words')).toBeLessThan(20)
  })

  it('counts exactly as the word-splitting estimate it replaced', () => {
    // The previous estimate, kept here as the reference: one string per word, number, or symbol.
    const reference = (content: string): number => {
      if (!content) return 0
      let lexical = 0
      for (const part of content.match(/\s+|[A-Za-z_]+|\d+|[^\sA-Za-z_\d]/gu) ?? []) {
        if (/^\s+$/u.test(part)) continue
        if (/^[A-Za-z_]+$/u.test(part)) lexical += Math.ceil(part.length / 4)
        else if (/^\d+$/u.test(part)) lexical += Math.ceil(part.length / 3)
        else lexical += Array.from(part).length
      }
      return Math.max(Math.ceil(content.length / 4), lexical)
    }
    // Every class the tokenizer distinguishes, plus the edges of each: Unicode white space,
    // non-ASCII letters and digits, astral symbols, and unpaired surrogates.
    const pool = [
      'a',
      '_',
      'identifier_name',
      '7',
      '123456',
      ' ',
      '\r\n',
      '\u00a0',
      '\u2028',
      '\u3000',
      '\ufeff',
      '\u200b',
      '{',
      '"',
      'é',
      '中文',
      '٣',
      '１',
      '😀',
      '👩‍💻',
      '\ud83d',
      '\udc00\ud800'
    ]
    let seed = 7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let sample = 0; sample < 400; sample++) {
      let text = ''
      const pieces = Math.floor(random() * 60)
      for (let piece = 0; piece < pieces; piece++) text += pool[Math.floor(random() * pool.length)]
      expect(estimateTextTokens(text), JSON.stringify(text)).toBe(reference(text))
    }
    const transcript = JSON.stringify({
      role: 'tool',
      content: 'Exit code 1\nError: ENOENT: no such file, open "C:\\work\\a.ts" at line 42:17',
      tool_calls: [{ id: 'call_1', arguments: { path: 'src/main/index.ts', limit: 2_000 } }]
    })
    expect(estimateTextTokens(transcript)).toBe(reference(transcript))
  })

  it('applies a positive calibration learned from real provider usage', () => {
    const withoutCalibration = calculateRequestBudget({
      messages: [{ role: 'user', content: 'small estimated prompt' }],
      tools: [],
      contextLength: 8_192,
      reservedOutputTokens: 2_048,
      compactionThreshold: 0.8
    })
    const calibrated = calculateRequestBudget({
      messages: [{ role: 'user', content: 'small estimated prompt' }],
      tools: [],
      contextLength: 8_192,
      reservedOutputTokens: 2_048,
      compactionThreshold: 0.8,
      estimationBiasTokens: withoutCalibration.compactionTriggerTokens
    })

    expect(calibrated.requestTokens).toBeGreaterThan(withoutCalibration.requestTokens)
    expect(calibrated.shouldCompact).toBe(true)
  })

  it('lowers an estimate that runs over the real count, so compaction waits for the threshold', () => {
    // A local model's real prompt ran about 25% under SideKick's estimate; with the correction
    // clamped at zero, a chat set to compact at 80% compacted at about 66% of its window.
    const options = {
      messages: [{ role: 'user' as const, content: '{"key": [1, 2, 3]}, '.repeat(17_000) }],
      tools: [],
      contextLength: 260_000,
      reservedOutputTokens: 32_768,
      compactionThreshold: 0.8
    }
    const estimated = calculateRequestBudget(options)
    expect(estimated.shouldCompact).toBe(true)
    const real = Math.round(estimated.requestTokens * 0.75)
    const calibrated = calculateRequestBudget({
      ...options,
      estimationBiasTokens: real - estimated.requestTokens
    })
    expect(calibrated.requestTokens).toBe(real)
    expect(calibrated.shouldCompact).toBe(real >= calibrated.compactionTriggerTokens)
    expect(calibrated.shouldCompact).toBe(false)
  })

  it('never lets a calibration bring an estimate under half', () => {
    expect(calibratedRequestTokens(10_000, -9_000)).toBe(5_000)
    expect(calibratedRequestTokens(10_000, -2_000)).toBe(8_000)
    expect(calibratedRequestTokens(10_000, 3_000)).toBe(13_000)
    expect(calibratedRequestTokens(10_000, Number.NaN)).toBe(10_000)
  })
})
