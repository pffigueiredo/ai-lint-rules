import { defineRule } from '@oxlint/plugins'
import { useStateMatcher } from './state-calls.js'

const COMPARISONS = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=', 'in', 'instanceof'])

function holdsBoolean(node) {
  if (!node) return false
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'boolean'
    case 'UnaryExpression':
      return node.operator === '!'
    case 'BinaryExpression':
      return COMPARISONS.has(node.operator)
    case 'CallExpression':
      return node.callee.type === 'Identifier' && node.callee.name === 'Boolean'
    case 'ConditionalExpression':
      return holdsBoolean(node.consequent) || holdsBoolean(node.alternate)
    case 'ObjectExpression':
      return node.properties.some((property) => property.type === 'Property' && holdsBoolean(property.value))
    case 'ArrayExpression':
      return node.elements.some(holdsBoolean)
    case 'ArrowFunctionExpression':
      return node.expression && holdsBoolean(node.body)
    default:
      return false
  }
}

// ponytail: type references are not followed, so `useState<Flags>(initialFlags)` passes when both are
// declared elsewhere. A TypeScript compiler check (like tools/check-data.ts) would resolve them.
function typeHoldsBoolean(type) {
  if (!type) return false
  switch (type.type) {
    case 'TSBooleanKeyword':
      return true
    case 'TSLiteralType':
      return typeof type.literal?.value === 'boolean'
    case 'TSUnionType':
      return type.types.some(typeHoldsBoolean)
    case 'TSArrayType':
      return typeHoldsBoolean(type.elementType)
    case 'TSTypeLiteral':
      return type.members.some((member) => typeHoldsBoolean(member.typeAnnotation?.typeAnnotation))
    default:
      return false
  }
}

export const noBooleanState = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow booleans in React state, including boolean fields of an object state',
    },
    schema: [],
    messages: {
      banned:
        "Boolean state. Let the browser own open/closed (`<details>`, `popover`, `<dialog>`), the form own checkboxes (read FormData on submit), and TanStack Query own async status. Name anything else as a union: useState<'view' | 'editing'>('view').",
    },
  },

  create(context) {
    let isUseState = () => false

    return {
      Program(node) {
        isUseState = useStateMatcher(node)
      },

      CallExpression(node) {
        if (!isUseState(node)) return
        const type = (node.typeArguments ?? node.typeParameters)?.params?.[0]
        if (typeHoldsBoolean(type) || holdsBoolean(node.arguments[0])) {
          context.report({ node, messageId: 'banned' })
        }
      },
    }
  },
})
