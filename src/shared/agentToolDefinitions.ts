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
  const localDefinition = (reference: string): unknown => {
    // RFC 6901: decode the URI fragment before splitting pointer tokens, then
    // decode ~1 before ~0. Keep the existing direct-definition-only subset.
    let pointer: string
    if (!reference.startsWith('#')) return undefined
    try {
      pointer = decodeURIComponent(reference.slice(1))
    } catch {
      return undefined
    }
    const match = /^\/(\$defs|definitions)\/([^/]*)$/.exec(pointer)
    if (!match || /~(?:[^01]|$)/.test(match[2]) || !Object.hasOwn(root, match[1])) return undefined
    const definitions = schemaRecord(root[match[1]])
    const name = match[2].replace(/~1/g, '/').replace(/~0/g, '~')
    return Object.hasOwn(definitions, name) ? definitions[name] : undefined
  }
  const resolving = new Set<string>()

  const normalize = (value: unknown, depth: number): Record<string, unknown> => {
    const normalized = collect(value, depth)
    if (!normalized.type && !normalized.anyOf && !normalized.oneOf) normalized.type = 'object'
    return normalized
  }

  /** The supported keywords of one schema, without the default type a merged branch must not add. */
  const collect = (value: unknown, depth: number): Record<string, unknown> => {
    if (depth > 20) return { type: 'object', description: 'Schema depth was bounded by SideKick.' }
    const source = schemaRecord(value)
    const reference = typeof source.$ref === 'string' ? source.$ref : ''
    if (reference && !resolving.has(reference)) {
      const target = localDefinition(reference)
      if (target) {
        resolving.add(reference)
        const resolved = collect(target, depth + 1)
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
    const properties = new Map(
      Object.entries(schemaRecord(source.properties)).map(([name, schema]) => [
        name,
        normalize(schema, depth + 1)
      ])
    )
    const required = new Set(
      Array.isArray(source.required)
        ? source.required.filter((name): name is string => typeof name === 'string')
        : []
    )
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(source[keyword])) {
        normalized[keyword] = source[keyword].map((schema) => normalize(schema, depth + 1))
      }
    }
    // A value must match every allOf branch, so the branches merge into this schema, which many
    // model APIs read better than allOf. Its own keywords win over a branch's.
    for (const branch of Array.isArray(source.allOf) ? source.allOf : []) {
      const part = collect(branch, depth + 1)
      for (const [name, schema] of Object.entries(schemaRecord(part.properties))) {
        if (!properties.has(name)) properties.set(name, schema as Record<string, unknown>)
      }
      for (const name of Array.isArray(part.required) ? part.required : []) required.add(name)
      for (const [key, keyword] of Object.entries(part)) {
        if (key !== 'properties' && key !== 'required' && !Object.hasOwn(normalized, key)) {
          normalized[key] = keyword
        }
      }
    }
    if (properties.size) {
      normalized.type = 'object'
      normalized.properties = Object.fromEntries(properties)
      if (Array.isArray(source.required) || required.size) {
        normalized.required = [...required].filter((name) => properties.has(name))
      }
    }
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

function exactEditDefinition(name: 'Edit' | 'search_replace' | 'edit'): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description:
        'Replace exact text in a project file. Read the relevant file first. old_string must match one location unless replace_all is true; keep it to the lines that change plus enough context to be unique. If an edit reports multiple matches, retry once with more surrounding context. If old_string is not found, copy the differing lines the error shows from the current file. Use the write tool to create or intentionally replace a complete file.',
      parameters: {
        type: 'object',
        required: ['file_path', 'old_string', 'new_string'],
        properties: {
          file_path: filePath,
          old_string: {
            type: 'string',
            description: 'Exact current file text to replace.'
          },
          new_string: {
            type: 'string',
            description: 'Replacement text; it must differ from old_string.'
          },
          replace_all: {
            type: 'boolean',
            description:
              'Optional, default false: change one uniquely identified occurrence. Set true only when every occurrence should change.'
          }
        }
      }
    }
  }
}

function writeDefinition(name: 'Write' | 'write'): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description:
        'Create a new project file or intentionally replace an existing file with complete content. Read an existing target first; SideKick rejects stale or missing read receipts and no-op writes. Use the edit tool for localized changes.',
      parameters: {
        type: 'object',
        required: ['file_path', 'content'],
        properties: {
          file_path: filePath,
          content: { type: 'string', description: 'Complete desired file content.' }
        }
      }
    }
  }
}

function deleteDefinition(): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a project file only when its intended final state is absent. It need not be read first. Never delete a file merely to work around a failed edit or before recreating the same path.',
      parameters: {
        type: 'object',
        required: ['file_path'],
        properties: { file_path: filePath }
      }
    }
  }
}

function applyPatchDefinition(): AgentToolDefinition {
  return {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: `Apply one verified, potentially multi-file patch using the canonical Codex patch grammar. The entire patch is parsed and checked before any file is written. Any empty patch, stale or ambiguous hunk, invalid path, skipped hunk, or no-op fails the complete call. Read existing targets in this run before the first edit, even if their contents appear in earlier conversation history. Use one Update File section per existing file with hunks in source order. For full rewrites, replace exact current contents in one update hunk; never delete and add the same path. Do not recreate unchanged lines from memory.

Format:
*** Begin Patch
*** Add File: path/to/new.ts
+new content
*** Update File: path/to/existing.ts
@@
 context line
-old line
+new line
 context line
*** Delete File: path/to/obsolete.ts
*** End Patch

Update hunks are context-based, not line-number based. Start each hunk with a bare @@ line as shown; optionally use @@ followed by actual existing function/class text to locate it. Never use unified-diff line numbers or a closing @@. Read every existing target first; SideKick rejects stale or missing run-scoped read receipts. Every hunk line must begin with a space, +, or -. Add-file content lines must begin with +. Paths must be project-relative. Use *** Move to: new/path immediately after an Update File header to rename while editing. A final *** End of File line requires that hunk to match the actual file end.`,
      parameters: {
        type: 'object',
        required: ['patch'],
        properties: {
          patch: {
            type: 'string',
            description:
              'Complete canonical patch text. Prefixes consume one character: -export targets export; - export targets a source line with a leading space. Do not add separator spaces. Existing CRLF/LF endings are preserved automatically.'
          }
        }
      }
    }
  }
}

export function editingToolDefinitions(dialect: EditingDialect): AgentToolDefinition[] {
  if (dialect === 'apply-patch') return [applyPatchDefinition()]
  if (dialect === 'claude-edit') {
    return [exactEditDefinition('Edit'), writeDefinition('Write'), deleteDefinition()]
  }
  if (dialect === 'search-replace') {
    return [exactEditDefinition('search_replace'), writeDefinition('write'), deleteDefinition()]
  }
  return [exactEditDefinition('edit'), writeDefinition('write'), deleteDefinition()]
}

/** Canonical bounded project reader used by every provider and run surface. */
export function workspaceReadToolDefinitions(): AgentToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read',
        description:
          'Read a project-relative UTF-8 file or list a directory. File output is line-numbered and bounded; continue with start_line. Directory output is bounded; continue with cursor. A PDF returns its text by page, with images of scanned or illustrated pages when you can see them; continue with pages. Absolute paths and paths outside the project are rejected.',
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
            glob: { type: 'string', description: 'Optional directory glob such as **/*.tsx.' },
            pages: {
              type: 'string',
              description:
                'For PDFs, pages such as 3, 2-5 or 1,4-6. A few named pages are shown as images.'
            }
          }
        }
      }
    }
  ]
}

export function workspaceToolDefinitions(dialect: EditingDialect): AgentToolDefinition[] {
  return [...workspaceReadToolDefinitions(), ...editingToolDefinitions(dialect)]
}
