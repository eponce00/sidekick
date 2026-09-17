/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const stage = process.argv[2] || 'final'
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')

const has = (pattern, message) => assert.match(html, pattern, message)
const part = (name) =>
  has(new RegExp(`data-part=["']${name}["']`, 'i'), `Missing SVG part: ${name}`)

has(/<svg\b/i, 'The page must contain inline SVG')
has(/viewBox=["']0 0 1200 700["']/i, 'The SVG must use the requested coordinate system')
has(/role=["']img["']/i, 'The SVG must expose an image role')
has(/aria-labelledby=["'][^"']+["']/i, 'The SVG must have an accessible name')
has(/<title\b[^>]*>/i, 'The SVG must contain a title')
has(
  /background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i,
  'The page must use a solid white background'
)
has(/max-width\s*:\s*100%/i, 'The controller must scale down with its container')
assert.doesNotMatch(html, /(?:src|href)=["']https?:/i, 'External visual assets are not allowed')

for (const name of [
  'controller-shell',
  'left-stick',
  'right-stick',
  'dpad',
  'button-a',
  'button-b',
  'button-x',
  'button-y'
]) {
  part(name)
}

if (stage === 'final') {
  for (const name of [
    'left-bumper',
    'right-bumper',
    'xbox-button',
    'menu-button',
    'share-button'
  ]) {
    part(name)
  }
  has(/@media\b/i, 'The revision must include an explicit compact-screen layout')
  has(/id=["']controller-status["']/i, 'The page must expose interaction feedback')
  has(/addEventListener\s*\(\s*["']click["']/i, 'The controls must provide click feedback')
}

console.log(`SVG controller ${stage} contract passed`)
