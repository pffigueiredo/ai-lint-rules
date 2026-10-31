import { defineRule } from '@oxlint/plugins'
import { BANNED_FEATURE_HOOKS } from './banned-hooks.js'

const MESSAGE =
  'Do not re-export React `{{name}}`. Feature code must not import banned hooks through a local barrel.'
const STAR_MESSAGE =
  'Do not `export * from "react"`. That re-exports banned hooks into feature import paths.'

function importedName(node) {
  return node.imported.type === 'Identifier' ? node.imported.name : node.imported.value
}

function exportedLocalName(specifier) {
  return specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value
}

function reportBannedIdentifier(context, node, bannedLocals) {
  if (node.type !== 'Identifier') {
    return
  }
  const hookName = bannedLocals.get(node.name)
  if (hookName) {
    context.report({
      node,
      messageId: 'banned',
      data: { name: hookName },
    })
  }
}

export const noBannedReactReexport = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow re-exporting banned React hooks from local modules',
    },
    schema: [],
    messages: {
      banned: MESSAGE,
      star: STAR_MESSAGE,
    },
  },

  create(context) {
    const bannedLocals = new Map()

    return {
      ImportSpecifier(node) {
        if (node.parent?.type !== 'ImportDeclaration' || node.parent.source.value !== 'react') {
          return
        }
        const hookName = importedName(node)
        if (BANNED_FEATURE_HOOKS.has(hookName)) {
          bannedLocals.set(node.local.name, hookName)
        }
      },

      ExportAllDeclaration(node) {
        if (node.source?.value === 'react') {
          context.report({ node, messageId: 'star' })
        }
      },

      ExportDefaultDeclaration(node) {
        reportBannedIdentifier(context, node.declaration, bannedLocals)
      },

      ExportNamedDeclaration(node) {
        if (node.source?.value === 'react') {
          for (const specifier of node.specifiers) {
            if (specifier.type !== 'ExportSpecifier') continue
            const name = exportedLocalName(specifier)
            if (BANNED_FEATURE_HOOKS.has(name)) {
              context.report({
                node: specifier,
                messageId: 'banned',
                data: { name },
              })
            }
          }
          return
        }

        if (node.source) {
          return
        }

        if (node.declaration?.type === 'VariableDeclaration') {
          for (const declarator of node.declaration.declarations) {
            if (declarator.init) {
              reportBannedIdentifier(context, declarator.init, bannedLocals)
            }
          }
        }

        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ExportSpecifier') continue
          const localName = exportedLocalName(specifier)
          const hookName = bannedLocals.get(localName)
          if (hookName) {
            context.report({
              node: specifier,
              messageId: 'banned',
              data: { name: hookName },
            })
          }
        }
      },
    }
  },
})
