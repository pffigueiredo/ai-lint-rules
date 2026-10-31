import { defineRule } from '@oxlint/plugins'
import { enclosingFunction, keyName, memberName, setterVariable, useStateMatcher } from './state-calls.js'

const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])
const QUERY_CALLBACKS = new Set(['onSuccess', 'onError', 'onSettled'])

function isPromiseCallback(node) {
  const call = node.parent
  return (
    call?.type === 'CallExpression' &&
    call.arguments.includes(node) &&
    PROMISE_METHODS.has(memberName(call.callee))
  )
}

function isQueryCallback(node) {
  const property = node.parent
  return property?.type === 'Property' && property.value === node && QUERY_CALLBACKS.has(keyName(property))
}

function runsAfterPromise(fn) {
  return fn.async || isPromiseCallback(fn) || isQueryCallback(fn)
}

function calledAfterPromise(identifier, owner) {
  let fn = enclosingFunction(identifier)
  while (fn && fn !== owner) {
    if (runsAfterPromise(fn)) return true
    fn = enclosingFunction(fn)
  }
  return false
}

export const noAsyncState = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow setting React state after a promise settles',
    },
    schema: [],
    messages: {
      banned:
        '`{{name}}` runs after a promise. Async status and results belong to TanStack Query: read `status`, `data` and `error` from useQuery/useMutation instead of copying them into state.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode
    let isUseState = () => false

    return {
      Program(node) {
        isUseState = useStateMatcher(node)
      },

      VariableDeclarator(node) {
        if (node.init?.type !== 'CallExpression' || !isUseState(node.init)) return
        const setter = setterVariable(sourceCode, node)
        if (!setter) return
        const owner = enclosingFunction(node)
        for (const reference of setter.references) {
          const identifier = reference.identifier
          const parent = identifier.parent
          const called = parent?.type === 'CallExpression' && parent.callee === identifier
          const passed = isPromiseCallback(identifier) || isQueryCallback(identifier)
          if (passed || (called && calledAfterPromise(identifier, owner))) {
            context.report({ node: identifier, messageId: 'banned', data: { name: setter.name } })
          }
        }
      },
    }
  },
})
