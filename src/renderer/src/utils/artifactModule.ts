interface ReactObjectComponent {
  $$typeof: unknown
}

interface CallableArtifactComponent {
  (...args: never[]): unknown
}

function isRenderableComponent(
  value: unknown
): value is CallableArtifactComponent | ReactObjectComponent {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value)
  )
}

/**
 * Babel initializes CommonJS `module.exports` to an empty object even when the
 * generated code only declares `function App()`. Empty exports are not a React
 * component, so prefer actual default/named exports and then the lexical App.
 */
export function resolveArtifactComponent(
  moduleExports: unknown,
  fallbackApp: unknown
): CallableArtifactComponent | ReactObjectComponent | null {
  const exportsRecord =
    typeof moduleExports === 'object' && moduleExports !== null
      ? (moduleExports as Record<string, unknown>)
      : null
  const candidates = [exportsRecord?.default, exportsRecord?.App, moduleExports, fallbackApp]

  return candidates.find(isRenderableComponent) ?? null
}
