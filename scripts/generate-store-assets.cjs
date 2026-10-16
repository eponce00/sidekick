#!/usr/bin/env node
// Renders the Microsoft Store tile images from the vector master, build/icon.svg. The images
// are checked in like the other icon derivatives, so a release runner never renders them.
// Run after changing the icon: node scripts/generate-store-assets.cjs
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { createCanvas, Image } = require('@napi-rs/canvas')

const root = path.resolve(__dirname, '..')
const outputDirectory = path.join(root, 'build/appx')

// Names electron-builder's AppX target reads from build/appx. The icon fills a square tile with
// a margin; wide tiles centre it.
const STORE_ASSETS = [
  { name: 'StoreLogo.png', width: 50, height: 50, scale: 1 },
  { name: 'Square44x44Logo.png', width: 44, height: 44, scale: 1 },
  { name: 'Square150x150Logo.png', width: 150, height: 150, scale: 0.7 },
  { name: 'Wide310x150Logo.png', width: 310, height: 150, scale: 0.7 },
  { name: 'LargeTile.png', width: 310, height: 310, scale: 0.7 },
  { name: 'SmallTile.png', width: 71, height: 71, scale: 0.8 }
]

function render(svg, { width, height, scale }) {
  const image = new Image()
  image.src = svg
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  const size = Math.round(Math.min(width, height) * scale)
  context.drawImage(
    image,
    Math.round((width - size) / 2),
    Math.round((height - size) / 2),
    size,
    size
  )
  return canvas.toBuffer('image/png')
}

function main() {
  const svg = readFileSync(path.join(root, 'build/icon.svg'))
  mkdirSync(outputDirectory, { recursive: true })
  for (const asset of STORE_ASSETS) {
    writeFileSync(path.join(outputDirectory, asset.name), render(svg, asset))
    console.log(`Wrote build/appx/${asset.name}`)
  }
}

if (require.main === module) main()

module.exports = { STORE_ASSETS }
