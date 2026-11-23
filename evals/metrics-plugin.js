import { defineRule, eslintCompatPlugin } from '@oxlint/plugins'

const STATEMENTS = new Set([
  'BreakStatement',
  'ClassDeclaration',
  'ContinueStatement',
  'DebuggerStatement',
  'DoWhileStatement',
  'ExportAllDeclaration',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'ExpressionStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'FunctionDeclaration',
  'IfStatement',
  'ImportDeclaration',
  'LabeledStatement',
  'ReturnStatement',
  'SwitchStatement',
  'ThrowStatement',
  'TryStatement',
  'VariableDeclaration',
  'WhileStatement',
  'WithStatement',
])

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])

const BRANCH_STATEMENTS = new Set([
  'CatchClause',
  'ConditionalExpression',
  'DoWhileStatement',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'IfStatement',
  'WhileStatement',
])

const LOGICAL_ASSIGN = new Set(['&&=', '||=', '??='])

const SKIP = new Set([
  'comments',
  'end',
  'innerComments',
  'leadingComments',
  'loc',
  'parent',
  'range',
  'span',
  'start',
  'trailingComments',
])

function isDecision(node) {
  if (BRANCH_STATEMENTS.has(node.type)) return true
  if (node.type === 'LogicalExpression') return true
  if (node.type === 'AssignmentExpression') return LOGICAL_ASSIGN.has(node.operator)
  if (node.type === 'SwitchCase') return node.test != null
  return false
}

function measure(root) {
  let statements = 0
  let moduleComplexity = 1
  const visit = (node, inFn) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inFn)
      return
    }
    const type = node.type
    if (typeof type !== 'string') return
    if (STATEMENTS.has(type)) statements += 1
    if (!inFn && isDecision(node)) moduleComplexity += 1
    const next = inFn || FUNCTIONS.has(type)
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue
      visit(node[key], next)
    }
  }
  visit(root, false)
  return { statements, moduleComplexity }
}

const file = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Report statement count and module-scope cyclomatic complexity' },
    schema: [],
    messages: {
      metrics: 'statements {{statements}} moduleComplexity {{moduleComplexity}}',
    },
  },
  create(context) {
    return {
      'Program:exit'(node) {
        const { statements, moduleComplexity } = measure(node)
        context.report({
          node,
          messageId: 'metrics',
          data: { statements, moduleComplexity },
        })
      },
    }
  },
})

export default eslintCompatPlugin({
  meta: { name: 'metrics' },
  rules: { file },
})
