#!/usr/bin/env node
// Draws SideKick's robot and writes every brand asset from that one drawing: the vector masters
// (build/icon.svg, and build/icon-small.svg for 16-32 px), the runtime and tray PNGs, the
// Windows ICO, the macOS ICNS, the Microsoft Store tiles, and the peeking robot the app shows on
// an empty chat. The outputs are checked in and hash-pinned by scripts/brand-assets.test.cjs, so
// a release runner never renders or downloads icons.
// Run after changing the robot: node scripts/generate-brand-assets.cjs
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

// Neutral greys like the app's, so the lime LEDs and the red cape carry the colour.
const COLORS = {
  tile: '#1C1C1C',
  helmet: '#E6E6E6',
  shade: '#B3B3B3',
  visor: '#0F0F0F',
  led: '#C8FF3D',
  glint: '#2A2A2A',
  cape: '#F0525B',
  capeLining: '#B5303A'
}

function round(value) {
  return Number(value.toFixed(1))
}

/** A continuous-corner shape (a superellipse), the curve of modern app icon grids. */
function superellipse(cx, cy, rx, ry, n = 5, steps = 96) {
  const points = []
  for (let i = 0; i < steps; i += 1) {
    const t = (2 * Math.PI * i) / steps
    const c = Math.cos(t)
    const s = Math.sin(t)
    points.push(
      `${round(cx + rx * Math.sign(c) * Math.abs(c) ** (2 / n))} ` +
        `${round(cy + ry * Math.sign(s) * Math.abs(s) ** (2 / n))}`
    )
  }
  return `M${points.join(' L')} Z`
}

const TILE = superellipse(512, 512, 412, 412)

// The visor is a face screen with a hero mask's outline: a dip at the brow, lobes under the eyes,
// a notch at the nose. This is its right half from the brow, clockwise; the left half mirrors it.
const VISOR_START = [0, -84]
const VISOR_RIGHT = [
  [
    [30, -100],
    [70, -108],
    [120, -108]
  ],
  [
    [170, -108],
    [214, -100],
    [222, -60]
  ],
  [
    [230, -20],
    [228, 30],
    [210, 64]
  ],
  [
    [186, 104],
    [120, 112],
    [78, 96]
  ],
  [
    [46, 84],
    [24, 66],
    [0, 64]
  ]
]

// The cape, as offsets from the head's centre on the master's proportions: it fastens under the
// chin and billows up and back, as if the robot is flying in, one piece of fabric ending in a hem
// that waves in two soft scallops. Two creases follow the cloth, and it shades toward the neck,
// as if in the head's shadow. In the app, a cloth simulation redraws it as it moves.
const CAPE =
  'M40 200 C-100 284 -300 282 -440 200 C-474 172 -494 140 -505 116 C-517 92 -498 80 -509 56 ' +
  'C-519 32 -559 -3 -568 -26 C-578 -49 -583 -77 -566 -84 C-466 -66 -366 -26 -250 -4 Z'
const CAPE_FOLDS =
  'M-220 70 C-320 52 -430 34 -512 24 C-430 52 -320 74 -220 78 Z ' +
  'M-200 190 C-290 196 -375 180 -455 156 C-380 198 -290 214 -200 200 Z'
const CAPE_SHADE = { from: [0, 200], to: [-560, -40] }

/** Scales every coordinate of an absolute path: x by `sx`, y by `sy`. */
function scalePath(d, sx, sy) {
  let axis = 0
  return d.replace(/-?\d+(\.\d+)?/g, (n) => String(round(Number(n) * (axis++ % 2 ? sy : sx))))
}

function visorPath() {
  const d = [`M${VISOR_START[0]} ${VISOR_START[1]}`]
  for (const [c1, c2, end] of VISOR_RIGHT)
    d.push(`C${c1.join(' ')} ${c2.join(' ')} ${end.join(' ')}`)
  const ends = [VISOR_START, ...VISOR_RIGHT.map((segment) => segment[2])]
  for (let i = VISOR_RIGHT.length - 1; i >= 0; i -= 1) {
    const [c1, c2] = VISOR_RIGHT[i]
    const previous = ends[i]
    d.push(`C${-c2[0]} ${c2[1]} ${-c1[0]} ${c1[1]} ${-previous[0]} ${previous[1]}`)
  }
  return `${d.join(' ')} Z`
}

/**
 * The robot flying in from the right edge of its tile, a superhero's sidekick: a cape, a domino
 * mask with pointed tips, and a badge with a prompt chevron where the cape fastens. `small` is the
 * cut for 16-32 px: a bigger head, bolder eyes, a shorter antenna and no visor glint, so it still
 * reads as a robot when every part is a few pixels. `glyph` drops the tile and cuts the head with
 * a straight edge, for the app's own surfaces; its parts carry classes so CSS can theme and
 * animate them, and the cape sits in its own group so the app can move it.
 */
function robot({ small = false, glyph = false } = {}) {
  const cx = small ? 670 : 690
  const cy = 600
  const rx = small ? 280 : 262
  const ry = small ? 240 : 226
  const tilt = -8
  const stem = small ? 70 : 92
  const eye = small ? 84 : 70
  const sx = rx / 262
  const sy = ry / 226
  const part = (name) => (glyph ? ` class="peek-${name}"` : '')
  const parts = []
  // The app's robot is cut straight on the right, and has room below for its cape to hang.
  const clip = glyph ? `M0 0 H${Math.round(cx + rx * 0.78)} V1400 H0 Z` : TILE
  if (!glyph) parts.push(`<path d="${TILE}" fill="${COLORS.tile}"/>`)
  parts.push(`<clipPath id="sidekick-tile"><path d="${clip}"/></clipPath>`)
  parts.push(`<g clip-path="url(#sidekick-tile)"><g transform="rotate(${tilt} ${cx} ${cy})">`)
  // The full-size icon shades its cape toward the neck; the app's theme colours its own, and the
  // small cut keeps a plain one, since creases and shading are noise at 16 px.
  const shaded = !glyph && !small
  if (shaded) {
    const [x1, y1] = CAPE_SHADE.from
    const [x2, y2] = CAPE_SHADE.to
    parts.push(
      `<linearGradient id="sidekick-cape-shade" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
        `<stop offset="0" stop-color="${COLORS.capeLining}"/><stop offset="0.45" stop-color="${COLORS.cape}"/></linearGradient>`
    )
  }
  parts.push(
    `<g transform="translate(${cx} ${cy})"><g${part('cape-rig')}>`,
    `<path${part('cape')} d="${scalePath(CAPE, sx, sy)}" fill="${shaded ? 'url(#sidekick-cape-shade)' : COLORS.cape}"/>`
  )
  if (!small) {
    parts.push(
      `<path${part('cape-lining')} d="${scalePath(CAPE_FOLDS, sx, sy)}" fill="${COLORS.capeLining}" opacity="0.55"/>`
    )
  }
  parts.push('</g></g>')
  const top = cy - ry - stem
  parts.push(
    `<rect${part('shade')} x="${cx - 85}" y="${top}" width="30" height="${stem + 20}" rx="15" fill="${COLORS.shade}"/>`,
    `<circle${part('led')} cx="${cx - 70}" cy="${top}" r="${small ? 40 : 34}" fill="${COLORS.led}"/>`,
    `<rect${part('shade')} x="${cx - rx - 46}" y="${cy - 80}" width="70" height="160" rx="32" fill="${COLORS.shade}"/>`,
    `<path${part('helmet')} d="${superellipse(cx, cy, rx, ry, 4.2)}" fill="${COLORS.helmet}"/>`
  )
  // The badge where the cape fastens, a prompt chevron for the hero's emblem, and the domino
  // mask's pointed tips. Both are detail the small cut leaves out: at 16 px they are noise.
  const bx = round(cx - 40 * sx)
  const by = round(cy + 214 * sy)
  const br = 50
  if (!small) {
    parts.push(
      `<circle${part('badge')} cx="${bx}" cy="${by}" r="${br}" fill="${COLORS.led}"/>`,
      `<path${part('badge-mark')} d="M${round(bx - br * 0.3)} ${round(by - br * 0.42)} L${round(bx + br * 0.22)} ${by} L${round(bx - br * 0.3)} ${round(by + br * 0.42)}" fill="none" stroke="${COLORS.visor}" stroke-width="${round(br * 0.28)}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
  }
  parts.push(
    `<g transform="translate(${cx - 24} ${cy - 8})">`,
    `<path${part('visor')} d="${visorPath()}" fill="${COLORS.visor}"/>`
  )
  if (!small) {
    for (const k of [-1, 1]) {
      parts.push(
        `<path${part('visor')} d="M${k * 200} -100 L${k * 306} -116 L${k * 224} -36 Z" fill="${COLORS.visor}"/>`
      )
    }
    parts.push(
      `<path${part('glint')} d="M-176 -66 C-120 -86 -50 -88 -6 -70" fill="none" stroke="${COLORS.glint}" stroke-width="18" stroke-linecap="round"/>`
    )
  }
  for (const x of [-104, 104]) {
    parts.push(
      `<rect${part('eye')} x="${x - eye / 2}" y="${-8 - eye / 2}" width="${eye}" height="${eye}" rx="16" fill="${COLORS.led}"/>`
    )
  }
  parts.push('</g></g></g>')
  return parts.join('')
}

function iconSvg(cut) {
  // The masters keep the 2048 grid the release checks expect; the drawing uses a 1024 grid.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048 2048">' +
    `<g transform="scale(2)">${robot({ small: cut === 'small' })}</g></svg>\n`
  )
}

function windowsSvg(cut) {
  // Windows icons fill their frame rather than sitting on Apple's grid, so the tile grows to
  // nearly the full canvas there; otherwise it looks a size smaller than its neighbours.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">' +
    `<g transform="translate(512 512) scale(1.204) translate(-512 -512)">${robot({ small: cut === 'small' })}</g></svg>\n`
  )
}

// The peek's frame: the head where the icon has it, with room to the left for the cape to stream
// back in a gust and below for it to hang in still air.
const PEEK_FRAME = { left: 30, top: 224, width: 864, height: 1140 }

function peekSvg() {
  const { left, top, width, height } = PEEK_FRAME
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}">` +
    `${robot({ glyph: true })}</svg>\n`
  )
}

function renderPng(svg, width, height = width, scale = 1) {
  const { createCanvas, Image } = require('@napi-rs/canvas')
  const image = new Image()
  image.src = Buffer.from(svg)
  const canvas = createCanvas(width, height)
  const size = Math.round(Math.min(width, height) * scale)
  canvas
    .getContext('2d')
    .drawImage(image, Math.round((width - size) / 2), Math.round((height - size) / 2), size, size)
  return canvas.toBuffer('image/png')
}

/** An ICO whose entries are PNGs, which Windows has read since Vista. */
function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach(({ size, png }, index) => {
    const at = 6 + index * 16
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...entries.map((entry) => entry.png)])
}

/** An ICNS of PNG entries, as macOS reads them since 10.7. */
function icns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

// Sizes drawn from the small cut; everything larger uses the master.
const SMALL_CUT_MAX = 32

// Names electron-builder's AppX target reads from build/appx. The icon fills a square tile with a
// margin; wide tiles centre it. Tiles that show it under 64 px use the small cut.
const STORE_ASSETS = [
  { name: 'StoreLogo.png', width: 50, height: 50, scale: 1, cut: 'small' },
  { name: 'Square44x44Logo.png', width: 44, height: 44, scale: 1, cut: 'small' },
  { name: 'Square150x150Logo.png', width: 150, height: 150, scale: 0.7, cut: 'master' },
  { name: 'Wide310x150Logo.png', width: 310, height: 150, scale: 0.7, cut: 'master' },
  { name: 'LargeTile.png', width: 310, height: 310, scale: 0.7, cut: 'master' },
  { name: 'SmallTile.png', width: 71, height: 71, scale: 0.8, cut: 'small' },
  // The taskbar, Start's app list and Alt+Tab draw the 44 px logo on an accent-coloured plate
  // unless the package has unplated sizes, which they show bare, like the installer's icon.
  ...[16, 24, 32, 48, 256].map((size) => ({
    name: `Square44x44Logo.targetsize-${size}_altform-unplated.png`,
    width: size,
    height: size,
    scale: 1,
    cut: size <= SMALL_CUT_MAX ? 'small' : 'master',
    unplated: true
  }))
]

function main() {
  const write = (relativePath, contents) => {
    const target = path.join(root, relativePath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
    console.log(`Wrote ${relativePath}`)
  }
  const master = iconSvg('master')
  const small = iconSvg('small')
  write('build/icon.svg', master)
  write('build/icon-small.svg', small)
  write('src/renderer/src/assets/sidekick-peek.svg', peekSvg())
  write('resources/icon.png', renderPng(master, 1024))
  // The tray draws at 16 px, up to 48 on high-density screens.
  write('resources/tray.png', renderPng(windowsSvg('small'), 128))

  const cut = (size, svgFor) => (size <= SMALL_CUT_MAX ? svgFor('small') : svgFor('master'))
  write(
    'build/icon.ico',
    ico(
      [16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({
        size,
        png: renderPng(cut(size, windowsSvg), size)
      }))
    )
  )
  const macSvg = (variant) => (variant === 'small' ? small : master)
  write(
    'build/icon.icns',
    icns(
      [
        ['icp4', 16],
        ['ic11', 32, 16],
        ['icp5', 32],
        ['ic12', 64, 32],
        ['icp6', 64],
        ['ic07', 128],
        ['ic13', 256],
        ['ic08', 256],
        ['ic14', 512],
        ['ic09', 512],
        ['ic10', 1024]
      ].map(([type, pixels, points = pixels]) => ({
        type,
        png: renderPng(cut(points, macSvg), pixels)
      }))
    )
  )
  for (const asset of STORE_ASSETS) {
    const svg = asset.unplated ? windowsSvg(asset.cut) : asset.cut === 'small' ? small : master
    write(`build/appx/${asset.name}`, renderPng(svg, asset.width, asset.height, asset.scale))
  }
}

if (require.main === module) main()

module.exports = { STORE_ASSETS }
