import type { EditingDialect } from './workspaceMutations'

export interface AgentToolParameterProperty {
  type: string
  description?: string
  enum?: string[]
  items?: Record<string, unknown>
  properties?: Record<string, AgentToolParameterProperty>
  required?: string[]
  [key: string]: unknown
}

export interface AgentToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      required?: string[]
      properties?: Record<string, AgentToolParameterProperty>
      [key: string]: unknown
    }
  }
}

function schemaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Produces a portable provider-facing subset of JSON Schema for MCP tools.
 * Local references are resolved because several model APIs reject $defs/$ref,
 * while SideKick's runtime validator must see the same effective contract.
 */
export function normalizeAgentToolParameters(
  input: unknown
): AgentToolDefinition['function']['parameters'] {
  const root = schemaRecord(input)
  const definitions = {
    ...schemaRecord(root.definitions),
    ...schemaRecord(root.$defs)
  }
  const resolving = new Set<string>()

  const normalize = (value: unknown, depth: number): Record<string, unknown> => {
    if (depth > 20) return { type: 'object', description: 'Schema depth was bounded by SideKick.' }
    const source = schemaRecord(value)
    const reference = typeof source.$ref === 'string' ? source.$ref : ''
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(reference)
    if (match && !resolving.has(reference)) {
      const target = definitions[decodeURIComponent(match[1])]
      if (target) {
        resolving.add(reference)
        const resolved = normalize(target, depth + 1)
        resolving.delete(reference)
        return resolved
      }
    }

    const normalized: Record<string, unknown> = {}
    const rawType = source.type
    const supportedTypes = Array.isArray(rawType)
      ? rawType.filter((type): type is string => typeof type === 'string' && type !== 'null')
      : typeof rawType === 'string'
        ? [rawType]
        : []
    if (supportedTypes.length === 1) normalized.type = supportedTypes[0]
    else if (supportedTypes.length > 1) normalized.anyOf = supportedTypes.map((type) => ({ type }))
    if (typeof source.description === 'string') normalized.description = source.description
    if (Array.isArray(source.enum)) normalized.enum = source.enum
    else if ('const' in source) normalized.enum = [source.const]
    for (const key of [
      'minimum',
      'maximum',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'minLength',
      'maxLength',
      'pattern',
      'minItems',
      'maxItems'
    ]) {
      if (typeof source[key] === 'number' || typeof source[key] === 'string') {
        normalized[key] = source[key]
      }
    }
    if (source.items) normalized.items = normalize(source.items, depth + 1)
    const properties = schemaRecord(source.properties)
    if (Object.keys(properties).length) {
      normalized.type = 'object'
      normalized.properties = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, normalize(schema, depth + 1)])
      )
      if (Array.isArray(source.required)) {
        normalized.required = source.required.filter(
          (name): name is string => typeof name === 'string' && name in properties
        )
      }
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(source[keyword])) {
        normalized[keyword] = source[keyword].map((schema) => normalize(schema, depth + 1))
      }
    }
    if (!normalized.type && !normalized.anyOf && !normalized.oneOf) normalized.type = 'object'
    return normalized
  }

  const normalized = normalize(root, 0)
  return {
    ...normalized,
    type: 'object',
    properties: schemaRecord(normalized.properties) as Record<string, AgentToolParameterProperty>
  } as AgentToolDefinition['function']['parameters']
}

const filePath: AgentToolParameterProperty = {
  type: 'string',
  description: 'Path relative to the project root.'
}

function applyPatchDefinition(): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: `Apply one verified, potentially multi-file patch using the canonical Codex patch grammar. The entire patch is parsed and checked before any file is written. Any empty patch, stale or ambiguous hunk, invalid path, skipped hunk, or no-op fails the complete call.

Format:
*** Begin Patch
*** Add File: path/to/new.ts
+new content
*** Update File: path/to/existing.ts
@@ optional function or class marker
 context line
-old line
+new line
 context line
*** Delete File: path/to/obsolete.ts
*** End Patch

Update hunks are context-based, not line-number based. Read every existing target first; SideKick rejects stale or missing run-scoped read receipts. Every hunk line must begin with a space, +, or -. Add-file content lines must begin with +. Paths must be project-relative. Use *** Move to: new/path immediately after an Update File header to rename while editing.`,
      parameters: {
        type: 'object',
        required: ['patch'],
        properties: {
          patch: { type: 'string', description: 'Complete canonical patch text.' }
        }
      }
    }
  }
}

export function editingToolDefinitions(dialect: EditingDialect): AgentToolDefinition[] {
  // ToolRuntimeV2 intentionally exposes one editing contract to every provider.
  // Keep the argument while callers migrate away from provider-specific dialect selection.
  void dialect
  return [applyPatchDefinition()]
}

/** Canonical bounded project reader used by every provider and run surface. */
export function workspaceReadToolDefinitions(): AgentToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read',
        description:
          'Read a project-relative UTF-8 file or list a directory. File output is line-numbered and bounded; continue with start_line. Directory output is bounded; continue with cursor. Absolute paths and paths outside the project are rejected.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: filePath,
            start_line: {
              type: 'number',
              minimum: 1,
              description: 'For files, optional 1-based inclusive start line.'
            },
            end_line: {
              type: 'number',
              minimum: 1,
              description: 'For files, optional 1-based inclusive end line.'
            },
            cursor: {
              type: 'number',
              minimum: 0,
              description: 'For directories, zero-based continuation cursor.'
            },
            max_entries: {
              type: 'number',
              minimum: 1,
              maximum: 1000,
              description: 'For directories, maximum returned entries.'
            },
            glob: { type: 'string', description: 'Optional directory glob such as **/*.tsx.' }
          }
        }
      }
    }
  ]
}

export function workspaceToolDefinitions(dialect: EditingDialect): AgentToolDefinition[] {
  return [...workspaceReadToolDefinitions(), ...editingToolDefinitions(dialect)]
}
