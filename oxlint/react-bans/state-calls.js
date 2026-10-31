const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])

export function isFunction(node) {
  return FUNCTION_TYPES.has(node?.type)
}

export function enclosingFunction(node) {
  let current = node.parent
  while (current && !isFunction(current)) {
    current = current.parent
  }
  return current ?? null
}

export function memberName(node) {
  if (node.type !== 'MemberExpression') return null
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value
  return null
}

export function keyName(property) {
  if (!property.computed && property.key.type === 'Identifier') return property.key.name
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value
  return null
}

function importedName(specifier) {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

/** Matches `useState(...)` imported from react under any local name, and `React.useState(...)`. */
export function useStateMatcher(program) {
  const locals = new Set()
  const namespaces = new Set()
  for (const node of program.body) {
    if (node.type !== 'ImportDeclaration' || node.source.value !== 'react') continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier') namespaces.add(specifier.local.name)
      else if (importedName(specifier) === 'useState') locals.add(specifier.local.name)
    }
  }
  return (call) => {
    const callee = call.callee
    if (callee.type === 'Identifier') return locals.has(callee.name)
    return (
      callee.type === 'MemberExpression' &&
      callee.object.type === 'Identifier' &&
      namespaces.has(callee.object.name) &&
      memberName(callee) === 'useState'
    )
  }
}

/** The setter variable of `const [value, setValue] = useState(...)`. */
export function setterVariable(sourceCode, declarator) {
  const setter = declarator.id.type === 'ArrayPattern' ? declarator.id.elements[1] : null
  if (setter?.type !== 'Identifier') return null
  return sourceCode.getDeclaredVariables(declarator).find((v) => v.name === setter.name) ?? null
}
