import { defineRule } from '@oxlint/plugins'
import { isFunction, reactHookMatcher } from './state-calls.js'

const HOOKS = new Set(['useState', 'useReducer'])
const URL_IDS = new Set(['location', 'URLSearchParams', 'useSearchParams', 'useSearch'])

function walk(node, visit) {
  if (node == null || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit)
      continue
    }
    walk(value, visit)
  }
}

function isUrlRead(node) {
  if (node.type === 'Identifier' && URL_IDS.has(node.name)) {
    const parent = node.parent
    if (parent?.type === 'Property' && parent.key === node && !parent.computed) return false
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return false
    if (parent?.type === 'FunctionDeclaration' && parent.id === node) return false
    if (parent?.type === 'FunctionExpression' && parent.id === node) return false
    return true
  }
  if (node.type !== 'MemberExpression') return false
  const obj = node.object
  return (
    memberLocation(node) &&
    obj.type === 'Identifier' &&
    (obj.name === 'window' || obj.name === 'document')
  )
}

function memberLocation(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name === 'location'
  if (node.property.type === 'Literal' && node.property.value === 'location') return true
  return false
}

function sameFileFunction(program, name) {
  for (const node of program.body) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node
    const exported = node.type === 'ExportNamedDeclaration' ? node.declaration : null
    if (exported?.type === 'FunctionDeclaration' && exported.id?.name === name) return exported
    const decls =
      node.type === 'VariableDeclaration'
        ? node.declarations
        : exported?.type === 'VariableDeclaration'
          ? exported.declarations
          : null
    if (decls == null) continue
    for (const decl of decls) {
      if (decl.id?.type === 'Identifier' && decl.id.name === name && isFunction(decl.init)) return decl.init
    }
  }
  return null
}

function initializerArgs(call, hook) {
  if (hook === 'useReducer') return call.arguments.slice(1, 3)
  return call.arguments.slice(0, 1)
}

function initializerRoots(call, hook, program) {
  const roots = []
  for (const arg of initializerArgs(call, hook)) {
    if (arg == null) continue
    roots.push(arg)
    if (isFunction(arg)) continue
    if (arg.type === 'Identifier') {
      const fn = sameFileFunction(program, arg.name)
      if (fn != null) roots.push(fn)
      continue
    }
    if (arg.type === 'CallExpression' && arg.callee.type === 'Identifier') {
      const fn = sameFileFunction(program, arg.callee.name)
      if (fn != null) roots.push(fn)
    }
  }
  return roots
}

export const noUrlStateCopy = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow copying URL values into useState or useReducer',
    },
    schema: [],
    messages: {
      banned:
        'Read the value from the URL during render (or a `src/lib/use-*` hook that subscribes to it) instead of copying it into state.',
    },
  },

  create(context) {
    let hookOf = () => null
    let program = null

    return {
      Program(node) {
        program = node
        hookOf = reactHookMatcher(node, HOOKS)
      },

      CallExpression(node) {
        const hook = hookOf(node)
        if (hook == null || program == null) return
        for (const root of initializerRoots(node, hook, program)) {
          let flagged = false
          walk(root, (child) => {
            if (flagged || !isUrlRead(child)) return
            flagged = true
            context.report({ node: child, messageId: 'banned' })
          })
          if (flagged) return
        }
      },
    }
  },
})
