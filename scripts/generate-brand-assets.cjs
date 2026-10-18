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

const COLORS = {
  tile: '#191B22',
  helmet: '#E6E9F0',
  shade: '#B4BBC9',
  visor: '#0B0C10',
  led: '#C8FF3D',
  glint: '#23262F'
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
 * The robot leaning in from the right edge of its tile. `small` is the cut for 16-32 px: a bigger
 * head, bolder eyes, a shorter antenna and no visor glint, so it still reads as a robot when
 * every part is a few pixels. `glyph` drops the tile and cuts the head with a straight edge, for
 * the app's own surfaces; its parts carry classes so CSS can theme and animate them.
 */
function robot({ small = false, glyph = false } = {}) {
  const cx = small ? 670 : 690
  const cy = 600
  const rx = small ? 280 : 262
  const ry = small ? 240 : 226
  const tilt = -8
  const stem = small ? 70 : 92
  const eye = small ? 84 : 70
  const part = (name) => (glyph ? ` class="peek-${name}"` : '')
  const parts = []
  const clip = glyph ? `M0 0 H${Math.round(cx + rx * 0.78)} V1024 H0 Z` : TILE
  if (!glyph) parts.push(`<path d="${TILE}" fill="${COLORS.tile}"/>`)
  parts.push(`<clipPath id="sidekick-tile"><path d="${clip}"/></clipPath>`)
  parts.push(`<g clip-path="url(#sidekick-tile)"><g transform="rotate(${tilt} ${cx} ${cy})">`)
  const top = cy - ry - stem
  parts.push(
    `<rect${part('shade')} x="${cx - 85}" y="${top}" width="30" height="${stem + 20}" rx="15" fill="${COLORS.shade}"/>`,
    `<circle${part('led')} cx="${cx - 70}" cy="${top}" r="${small ? 40 : 34}" fill="${COLORS.led}"/>`,
    `<rect${part('shade')} x="${cx - rx - 46}" y="${cy - 80}" width="70" height="160" rx="32" fill="${COLORS.shade}"/>`,
    `<path${part('helmet')} d="${superellipse(cx, cy, rx, ry, 4.2)}" fill="${COLORS.helmet}"/>`,
    `<g transform="translate(${cx - 24} ${cy - 8})">`,
    `<path${part('visor')} d="${visorPath()}" fill="${COLORS.visor}"/>`
  )
  if (!small) {
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

function peekSvg() {
  const cx = 690
  const rx = 262
  const ry = 226
  const left = cx - rx - 70
  const top = 600 - ry - 150
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${Math.round(rx * 1.78 + 70)} ${ry * 2 + 190}">` +
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

// Names electron-builder's AppX target reads from build/appx. The icon fills a square tile with a
// margin; wide tiles centre it. Tiles that show it under 64 px use the small cut.
const STORE_ASSETS = [
  { name: 'StoreLogo.png', width: 50, height: 50, scale: 1, cut: 'small' },
  { name: 'Square44x44Logo.png', width: 44, height: 44, scale: 1, cut: 'small' },
  { name: 'Square150x150Logo.png', width: 150, height: 150, scale: 0.7, cut: 'master' },
  { name: 'Wide310x150Logo.png', width: 310, height: 150, scale: 0.7, cut: 'master' },
  { name: 'LargeTile.png', width: 310, height: 310, scale: 0.7, cut: 'master' },
  { name: 'SmallTile.png', width: 71, height: 71, scale: 0.8, cut: 'small' }
]

// Sizes drawn from the small cut; everything larger uses the master.
const SMALL_CUT_MAX = 32

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
    const svg = asset.cut === 'small' ? small : master
    write(`build/appx/${asset.name}`, renderPng(svg, asset.width, asset.height, asset.scale))
  }
}

if (require.main === module) main()

module.exports = { STORE_ASSETS }
