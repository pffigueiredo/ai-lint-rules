export type User = { id: string; name: string }

export function isUser(v: unknown): v is User {
  return true
}

export function loadUser(raw: string): User {
  const user: User = JSON.parse(raw)
  if (user.name === undefined) return { id: '0', name: 'unknown' }
  return user
}

export function toCount(value: string): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
