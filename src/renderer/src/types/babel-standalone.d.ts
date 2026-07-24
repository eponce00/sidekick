declare module '@babel/standalone' {
  interface TransformOptions {
    presets?: string[]
    plugins?: string[]
    filename?: string
    sourceType?: 'module' | 'script' | 'unambiguous'
    ast?: boolean
    code?: boolean
    comments?: boolean
    compact?: boolean | 'auto'
    minified?: boolean
    sourceMaps?: boolean | 'inline' | 'both'
  }

  interface TransformResult {
    code: string | null
    map: object | null
    ast: object | null
  }

  export function transform(code: string, options?: TransformOptions): TransformResult
  export function transformFromAst(
    ast: object,
    code?: string,
    options?: TransformOptions
  ): TransformResult
  export function registerPreset(name: string, preset: object): void
  export function registerPlugin(name: string, plugin: object): void
  export const availablePresets: { [key: string]: object }
  export const availablePlugins: { [key: string]: object }
}
