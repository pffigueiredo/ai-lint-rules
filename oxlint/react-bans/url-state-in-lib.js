import { defineRule } from '@oxlint/plugins'
import { memberName } from './state-calls.js'

const LOCATION_ROOTS = new Set(['window', 'document', 'globalThis'])
const HISTORY_ROOTS = new Set(['window', 'globalThis'])

function isLibFile(filename) {
  if (typeof filename !== 'string' || filename === '') return false
  const n = filename.replaceAll('\\', '/')
  return n === 'src/lib' || n.endsWith('/src/lib') || /(^|\/)src\/lib\//.test(n)
}

function isKeyUse(node) {
  const parent = node.parent
  if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return true
  if (parent?.type === 'Property' && parent.key === node && !parent.computed) return true
  return false
}

function isUnshadowedGlobal(sourceCode, node) {
  if (node.type !== 'Identifier') return false
  if (sourceCode.isGlobalReference(node)) return true
  let scope = sourceCode.getScope(node)
  while (scope != null) {
    const variable = scope.set.get(node.name)
    if (variable !== undefined) {
      return variable.defs.length === 0 || variable.defs.every((d) => d.type === 'ImplicitGlobalVariable')
    }
    scope = scope.upper
  }
  return true
}

export const urlStateInLib = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow reading or writing the URL outside src/lib',
    },
    schema: [],
    messages: {
      banned:
        'URL state lives in a `src/lib/use-*` hook that reads with `useSyncExternalStore` and subscribes to `popstate`; call that hook here.',
    },
  },

  create(context) {
    if (isLibFile(context.physicalFilename)) return {}
    const sourceCode = context.sourceCode

    return {
      Identifier(node) {
        if (node.name !== 'location' && node.name !== 'history') return
        if (isKeyUse(node)) return
        if (!isUnshadowedGlobal(sourceCode, node)) return
        context.report({ node, messageId: 'banned' })
      },

      MemberExpression(node) {
        const name = memberName(node)
        const obj = node.object
        if (obj.type !== 'Identifier') return
        if (name === 'location' && LOCATION_ROOTS.has(obj.name)) {
          context.report({ node, messageId: 'banned' })
          return
        }
        if (name === 'history' && HISTORY_ROOTS.has(obj.name)) {
          context.report({ node, messageId: 'banned' })
        }
      },
    }
  },
})
