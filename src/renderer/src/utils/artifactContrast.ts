interface RgbaColor {
  red: number
  green: number
  blue: number
  alpha: number
}

interface InlineColorSnapshot {
  value: string
  priority: string
}

const MIN_ARTIFACT_CONTRAST = 2.25
const MAX_AUDITED_ELEMENTS = 600

export function parseCssColor(value: string): RgbaColor | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || trimmed === 'transparent') {
    return { red: 0, green: 0, blue: 0, alpha: 0 }
  }

  const hex = trimmed.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1
    }
  }

  const rgb = trimmed.match(/^rgba?\((.+)\)$/)?.[1]
  if (!rgb) return null
  const parts = rgb
    .replace('/', ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null

  return {
    red: Math.max(0, Math.min(255, parts[0])),
    green: Math.max(0, Math.min(255, parts[1])),
    blue: Math.max(0, Math.min(255, parts[2])),
    alpha: Math.max(0, Math.min(1, parts[3] ?? 1))
  }
}

function compositeColors(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 }

  return {
    red:
      (foreground.red * foreground.alpha +
        background.red * background.alpha * (1 - foreground.alpha)) /
      alpha,
    green:
      (foreground.green * foreground.alpha +
        background.green * background.alpha * (1 - foreground.alpha)) /
      alpha,
    blue:
      (foreground.blue * foreground.alpha +
        background.blue * background.alpha * (1 - foreground.alpha)) /
      alpha,
    alpha
  }
}

function relativeLuminance(color: RgbaColor): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }

  return channel(color.red) * 0.2126 + channel(color.green) * 0.7152 + channel(color.blue) * 0.0722
}

export function getContrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const opaqueForeground = compositeColors(foreground, background)
  const lighter = Math.max(relativeLuminance(opaqueForeground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(opaqueForeground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function effectiveBackground(element: Element, view: Window): RgbaColor {
  let result: RgbaColor = { red: 0, green: 0, blue: 0, alpha: 0 }
  let current: Element | null = element

  while (current && result.alpha < 0.999) {
    const layer = parseCssColor(view.getComputedStyle(current).backgroundColor)
    if (layer) result = compositeColors(result, layer)
    current = current.parentElement
  }

  if (result.alpha < 0.999) {
    const colorScheme = view.getComputedStyle(element.ownerDocument.documentElement).colorScheme
    const canvas = parseCssColor(colorScheme === 'light' ? '#ffffff' : '#12161b')!
    result = compositeColors(result, canvas)
  }

  return result
}

function hasDirectVisibleText(element: HTMLElement): boolean {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(element.tagName)) return true
  return [...element.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
  )
}

/**
 * Repairs only severe generated-code contrast failures. It deliberately leaves
 * normal design choices alone and can be disabled for an element subtree with
 * `data-sidekick-contrast="preserve"`.
 */
export function installArtifactContrastGuard(doc: Document = document): () => void {
  const view = doc.defaultView
  const body = doc.body
  if (!view || !body) return () => undefined

  const repaired = new Map<HTMLElement, InlineColorSnapshot>()
  let frame = 0

  const restore = (): void => {
    for (const [element, snapshot] of repaired) {
      element.style.setProperty('color', snapshot.value, snapshot.priority)
    }
    repaired.clear()
  }

  const audit = (): void => {
    frame = 0
    restore()

    const rootStyle = view.getComputedStyle(doc.documentElement)
    const candidateValues = [
      rootStyle.getPropertyValue('--text-primary').trim(),
      rootStyle.getPropertyValue('--on-accent').trim(),
      '#ffffff',
      '#000000'
    ].filter(Boolean)
    const candidates = candidateValues
      .map((value) => ({ value, color: parseCssColor(value) }))
      .filter((entry): entry is { value: string; color: RgbaColor } => Boolean(entry.color))

    let audited = 0
    for (const element of body.querySelectorAll<HTMLElement>('*')) {
      if (audited >= MAX_AUDITED_ELEMENTS) break
      if (!hasDirectVisibleText(element)) continue
      if (element.closest('[data-sidekick-contrast="preserve"]')) continue

      const style = view.getComputedStyle(element)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0 ||
        style.fontSize === '0px' ||
        style.webkitBackgroundClip === 'text'
      ) {
        continue
      }

      const foreground = parseCssColor(style.color)
      if (!foreground) continue
      const background = effectiveBackground(element, view)
      const currentRatio = getContrastRatio(foreground, background)
      audited += 1
      if (currentRatio >= MIN_ARTIFACT_CONTRAST) continue

      let best: { value: string; ratio: number } | null = null
      for (const candidate of candidates) {
        const ratio = getContrastRatio(candidate.color, background)
        if (!best || ratio > best.ratio) best = { value: candidate.value, ratio }
      }
      if (!best || best.ratio <= currentRatio) continue

      repaired.set(element, {
        value: element.style.getPropertyValue('color'),
        priority: element.style.getPropertyPriority('color')
      })
      element.style.setProperty('color', best.value, 'important')
    }
  }

  const scheduleAudit = (): void => {
    if (frame) view.cancelAnimationFrame(frame)
    frame = view.requestAnimationFrame(audit)
  }

  const observer = new view.MutationObserver(scheduleAudit)
  observer.observe(body, {
    attributes: true,
    attributeFilter: ['class', 'aria-selected', 'aria-pressed', 'data-state'],
    childList: true,
    characterData: true,
    subtree: true
  })
  const events = ['pointerover', 'pointerout', 'focusin', 'focusout'] as const
  for (const eventName of events) doc.addEventListener(eventName, scheduleAudit, true)
  doc.addEventListener('sidekick-artifact-themechange', scheduleAudit)
  scheduleAudit()

  return () => {
    if (frame) view.cancelAnimationFrame(frame)
    observer.disconnect()
    for (const eventName of events) doc.removeEventListener(eventName, scheduleAudit, true)
    doc.removeEventListener('sidekick-artifact-themechange', scheduleAudit)
    restore()
  }
}
