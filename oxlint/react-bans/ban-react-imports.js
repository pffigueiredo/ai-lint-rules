import { defineRule } from '@oxlint/plugins'

function importedName(node) {
  return node.imported.type === 'Identifier' ? node.imported.name : node.imported.value
}

function propertyName(node) {
  if (node.property.type === 'Identifier' && !node.computed) {
    return node.property.name
  }
  if (node.property.type === 'Literal') {
    return node.property.value
  }
  return null
}

export function defineReactImportBan(opts) {
  return defineRule({
    meta: {
      type: 'problem',
      docs: {
        description: opts.description,
      },
      schema: [],
      messages: {
        banned: opts.message,
      },
    },

    create(context) {
      const reactNamespaces = new Set()
      const hooks = opts.hooks

      return {
        ImportSpecifier(node) {
          if (
            node.parent?.type === 'ImportDeclaration' &&
            node.parent.source.value === 'react' &&
            hooks.has(importedName(node))
          ) {
            context.report({
              node,
              messageId: 'banned',
              data: { name: importedName(node) },
            })
          }
        },

        ImportDefaultSpecifier(node) {
          if (node.parent?.type === 'ImportDeclaration' && node.parent.source.value === 'react') {
            reactNamespaces.add(node.local.name)
          }
        },

        ImportNamespaceSpecifier(node) {
          if (node.parent?.type === 'ImportDeclaration' && node.parent.source.value === 'react') {
            reactNamespaces.add(node.local.name)
          }
        },

        MemberExpression(node) {
          if (
            node.object.type === 'Identifier' &&
            reactNamespaces.has(node.object.name) &&
            hooks.has(propertyName(node))
          ) {
            context.report({
              node,
              messageId: 'banned',
              data: { name: propertyName(node) },
            })
          }
        },

        VariableDeclarator(node) {
          if (
            node.id.type !== 'ObjectPattern' ||
            node.init?.type !== 'Identifier' ||
            !reactNamespaces.has(node.init.name)
          ) {
            return
          }
          for (const property of node.id.properties) {
            if (
              property.type === 'Property' &&
              !property.computed &&
              property.key.type === 'Identifier' &&
              hooks.has(property.key.name)
            ) {
              context.report({
                node: property,
                messageId: 'banned',
                data: { name: property.key.name },
              })
            }
          }
        },

        ExportNamedDeclaration(node) {
          if (node.source?.value !== 'react') {
            return
          }
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ExportSpecifier') {
              const name =
                specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value
              if (hooks.has(name)) {
                context.report({
                  node: specifier,
                  messageId: 'banned',
                  data: { name },
                })
              }
            }
          }
        },
      }
    },
  })
}
