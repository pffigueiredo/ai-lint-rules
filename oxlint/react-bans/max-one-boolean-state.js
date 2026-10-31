import { defineRule } from '@oxlint/plugins'
import { enclosingFunction, useStateMatcher } from './state-calls.js'

function isBooleanState(call) {
  const type = (call.typeArguments ?? call.typeParameters)?.params?.[0]
  if (type?.type === 'TSBooleanKeyword') return true
  const init = call.arguments[0]
  if (!init) return false
  if (init.type === 'Literal') return typeof init.value === 'boolean'
  if (init.type === 'UnaryExpression') return init.operator === '!'
  return init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'Boolean'
}

export const maxOneBooleanState = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Allow at most one boolean useState per component or hook',
    },
    schema: [],
    messages: {
      banned:
        "A second boolean state. Two booleans allow four combinations; model them as one union instead, for example useState<'idle' | 'editing' | 'confirming'>('idle').",
    },
  },

  create(context) {
    const counts = new Map()
    let program = null
    let isUseState = () => false

    return {
      Program(node) {
        program = node
        isUseState = useStateMatcher(node)
      },

      CallExpression(node) {
        if (!isUseState(node) || !isBooleanState(node)) return
        const owner = enclosingFunction(node) ?? program
        const seen = counts.get(owner) ?? 0
        counts.set(owner, seen + 1)
        if (seen > 0) context.report({ node, messageId: 'banned' })
      },
    }
  },
})
