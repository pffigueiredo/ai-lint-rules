import { defineRule } from '@oxlint/plugins'
import { enclosingFunction, isFunction, keyName, memberName, setterVariable, useStateMatcher } from './state-calls.js'

const ITEM_METHODS = new Set(['every', 'filter', 'find', 'findLast', 'flatMap', 'forEach', 'map', 'some'])
const DRAFT_NAME = /^(initial|default)([A-Z_]|$)/

function within(node, outer) {
  return outer.start <= node.start && node.end <= outer.end
}

/** Each parameter binding of `fn`, with the prop key it reads: `{ venue }` binds `venue`, `props` binds the whole object. */
function paramBindings(fn) {
  const bindings = new Map()
  for (const param of fn.params) {
    const target = param.type === 'AssignmentPattern' ? param.left : param
    if (target.type === 'Identifier') {
      bindings.set(target.name, null)
      continue
    }
    if (target.type !== 'ObjectPattern') continue
    for (const property of target.properties) {
      if (property.type === 'RestElement') {
        if (property.argument.type === 'Identifier') bindings.set(property.argument.name, null)
        continue
      }
      const value = property.value.type === 'AssignmentPattern' ? property.value.left : property.value
      if (value.type === 'Identifier') bindings.set(value.name, keyName(property))
    }
  }
  return bindings
}

// ponytail: an item counts as an object only when the callback reads a property off it (`v.name`),
// so `days.map((d) => setDay(d))` passes. A typed version (TypeScript compiler script) would read the element type.
function readsPropertyOf(references) {
  return references.some((reference) => {
    const parent = reference.identifier.parent
    if (parent?.type !== 'MemberExpression' || parent.object !== reference.identifier) return false
    const grandparent = parent.parent
    return !(grandparent?.type === 'CallExpression' && grandparent.callee === parent)
  })
}

export const noStateCopies = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow React state that copies props or list items owned elsewhere',
    },
    schema: [],
    messages: {
      prop: "`{{name}}` is copied into state once and goes stale when it changes. Read it directly, or name the prop `initial…` / `default…` if it's a starting draft.",
      item: 'Storing the whole `{{name}}` copies a list item into state. Store its key (for example `{{name}}.id`) and look the item up during render.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode
    const setterCalls = new Set()
    const itemCallbacks = []
    let isUseState = () => false

    function checkInitializer(call) {
      const init = call.arguments[0]
      const owner = enclosingFunction(call)
      if (!init || !owner) return
      const bindings = paramBindings(owner)
      for (const variable of sourceCode.getDeclaredVariables(owner)) {
        if (!bindings.has(variable.name)) continue
        const key = bindings.get(variable.name)
        for (const reference of variable.references) {
          const identifier = reference.identifier
          if (!within(identifier, init)) continue
          const parent = identifier.parent
          const member = key == null && parent?.type === 'MemberExpression' && parent.object === identifier ? memberName(parent) : null
          if ([key ?? variable.name, member].some((n) => n != null && DRAFT_NAME.test(n))) continue
          const name = key ?? (member ? `${variable.name}.${member}` : variable.name)
          context.report({ node: identifier, messageId: 'prop', data: { name } })
        }
      }
    }

    return {
      Program(node) {
        isUseState = useStateMatcher(node)
      },

      VariableDeclarator(node) {
        if (node.init?.type !== 'CallExpression' || !isUseState(node.init)) return
        const setter = setterVariable(sourceCode, node)
        for (const reference of setter?.references ?? []) {
          const parent = reference.identifier.parent
          if (parent?.type === 'CallExpression' && parent.callee === reference.identifier) setterCalls.add(parent)
        }
      },

      CallExpression(node) {
        if (isUseState(node)) checkInitializer(node)
        const callback = node.arguments[0]
        if (ITEM_METHODS.has(memberName(node.callee)) && isFunction(callback) && callback.params[0]?.type === 'Identifier') {
          itemCallbacks.push(callback)
        }
      },

      'Program:exit'() {
        for (const callback of itemCallbacks) {
          const name = callback.params[0].name
          const item = sourceCode.getDeclaredVariables(callback).find((v) => v.name === name)
          if (!item || !readsPropertyOf(item.references)) continue
          for (const reference of item.references) {
            const parent = reference.identifier.parent
            if (parent?.type === 'CallExpression' && parent.arguments[0] === reference.identifier && setterCalls.has(parent)) {
              context.report({ node: reference.identifier, messageId: 'item', data: { name } })
            }
          }
        }
      },
    }
  },
})
