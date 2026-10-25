/**
 * The Babel plugin that prepares a draft to grow in place. Each top-level component is registered
 * under its name, so a newer draft's `Card` is the same React component as the last one's and only
 * what changed in it is redrawn; and every name the draft uses before defining it is declared, as
 * a placeholder component or an empty value, so the part that uses it shows as a placeholder
 * instead of the whole draft failing. Values placed among elements pass through a check that
 * renders a value still to come as nothing.
 */

// Babel's own types are not a dependency of the renderer; the plugin touches only what it needs.
/* eslint-disable @typescript-eslint/no-explicit-any */
type BabelApi = { types: any }

export const DRAFT_COMPONENT = '__draftComponent'
export const DRAFT_PLACEHOLDER = '__DraftPlaceholder'
export const DRAFT_HOLE = '__draftHole'
export const DRAFT_CHILD = '__draftChild'

const isComponentName = (name: string): boolean => /^[A-Z]/.test(name)

/**
 * @param provided Names the code may use without defining them: the sandbox's prelude and the
 *   page's globals.
 */
export function draftTransformPlugin(provided: (name: string) => boolean) {
  return ({ types: t }: BabelApi) => {
    const register = (name: string, value: any): any =>
      t.callExpression(t.identifier(DRAFT_COMPONENT), [t.stringLiteral(name), value])
    const isFunction = (node: any): boolean =>
      t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)
    return {
      visitor: {
        JSXExpressionContainer(path: any) {
          if (t.isJSXEmptyExpression(path.node.expression)) return
          if (!t.isJSXElement(path.parent) && !t.isJSXFragment(path.parent)) return
          if (
            t.isCallExpression(path.node.expression) &&
            t.isIdentifier(path.node.expression.callee, { name: DRAFT_CHILD })
          )
            return
          path.node.expression = t.callExpression(t.identifier(DRAFT_CHILD), [path.node.expression])
        },
        Program: {
          enter(path: any) {
            for (const statement of path.get('body')) {
              const declaration =
                statement.isExportNamedDeclaration() || statement.isExportDefaultDeclaration()
                  ? statement.get('declaration')
                  : statement
              if (!declaration?.node) continue
              if (declaration.isFunctionDeclaration()) {
                const name = declaration.node.id?.name
                if (name && isComponentName(name)) {
                  statement.insertAfter(
                    t.expressionStatement(
                      t.assignmentExpression(
                        '=',
                        t.identifier(name),
                        register(name, t.identifier(name))
                      )
                    )
                  )
                }
              } else if (declaration.isVariableDeclaration()) {
                for (const declarator of declaration.node.declarations) {
                  const name = t.isIdentifier(declarator.id) ? declarator.id.name : ''
                  if (name && isComponentName(name) && isFunction(declarator.init)) {
                    declarator.init = register(name, declarator.init)
                  }
                }
              }
            }
            const missing = Object.keys(path.scope.globals).filter(
              (name) => !provided(name) && !path.scope.hasBinding(name)
            )
            // Used as an element, a missing name is a component; otherwise a value, such as data.
            const elements = new Set<string>()
            path.traverse({
              JSXOpeningElement(element: any) {
                if (t.isJSXIdentifier(element.node.name)) elements.add(element.node.name.name)
              }
            })
            if (missing.length) {
              path.unshiftContainer(
                'body',
                t.variableDeclaration(
                  'var',
                  missing.map((name) =>
                    t.variableDeclarator(
                      t.identifier(name),
                      t.identifier(elements.has(name) ? DRAFT_PLACEHOLDER : DRAFT_HOLE)
                    )
                  )
                )
              )
            }
          }
        }
      }
    }
  }
}
