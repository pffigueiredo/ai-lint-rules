class DefaultHandler {
  run(): string {
    return 'ok'
  }
}

export function createHandler(): DefaultHandler {
  return new DefaultHandler()
}

function padName(name: string): string {
  return name.trim()
}

export function label(name: string): string {
  return padName(name)
}

export function save(): string {
  throw new Error('not implemented')
}
