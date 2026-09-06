import { expect, it } from 'vitest'
import { normalizeAgentToolParameters } from './agentToolDefinitions'

it('keeps malformed URI escapes on the existing unresolved-reference fallback without crashing', () => {
  expect(
    normalizeAgentToolParameters({ properties: { value: { $ref: '#/$defs/%ZZ' } } }).properties
      ?.value
  ).toEqual({ type: 'object' })
})

it.each([
  ['#/$defs/a~1b', 'a/b'],
  ['#/$defs/a~0b', 'a~b'],
  ['#/$defs/~01', '~1'],
  ['#/$defs/a%20b', 'a b'],
  ['#%2F$defs%2Fitem', 'item'],
  ['#/$defs/', '']
])('resolves JSON Pointer tokens correctly: %s', (reference, key) => {
  const schema = normalizeAgentToolParameters({
    $defs: { [key]: { type: 'string' } },
    properties: { value: { $ref: reference } }
  })
  expect(schema.properties?.value.type).toBe('string')
})

it('keeps legacy and modern definition namespaces distinct', () => {
  const schema = normalizeAgentToolParameters({
    definitions: { Same: { type: 'string' } },
    $defs: { Same: { type: 'integer' } },
    properties: { legacy: { $ref: '#/definitions/Same' }, modern: { $ref: '#/$defs/Same' } }
  })
  expect(schema.properties?.legacy.type).toBe('string')
  expect(schema.properties?.modern.type).toBe('integer')
})

it('does not promote a percent-encoded leading fragment marker into a local reference', () => {
  const schema = normalizeAgentToolParameters({
    $defs: { item: { type: 'string' } },
    properties: { value: { $ref: '%23/$defs/item' } }
  })
  expect(schema.properties?.value).toEqual({ type: 'object' })
})

it.each(['#/$defs/a%2Fb', '#/$defs/a~2b', '#/$defs/%E0%A4%A'])(
  'does not reinterpret invalid or unsupported pointer paths as flat keys: %s',
  (reference) => {
    const schema = normalizeAgentToolParameters({
      $defs: { 'a/b': { type: 'string' }, 'a~2b': { type: 'string' } },
      properties: { value: { $ref: reference } }
    })
    expect(schema.properties?.value).toEqual({ type: 'object' })
  }
)

it('resolves explicitly owned prototype-like JSON keys but not inherited definitions', () => {
  const own = normalizeAgentToolParameters(
    JSON.parse(
      '{"$defs":{"__proto__":{"type":"string"}},"properties":{"value":{"$ref":"#/$defs/__proto__"}}}'
    )
  )
  expect(own.properties?.value.type).toBe('string')
  const inherited = normalizeAgentToolParameters({
    $defs: Object.create({ Item: { type: 'string' } }),
    properties: { value: { $ref: '#/$defs/Item' } }
  })
  expect(inherited.properties?.value.type).toBe('object')
})

it('does not resolve inherited members or emit inherited required property names', () => {
  const schema = normalizeAgentToolParameters({
    $defs: {},
    required: ['value', 'constructor'],
    properties: { value: { $ref: '#/$defs/constructor', type: 'string' } }
  })
  expect(schema.required).toEqual(['value'])
  expect(schema.properties?.value.type).toBe('string')
})
