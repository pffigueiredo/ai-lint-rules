export type Venue = {
  id: string
  name: string
  city: string
  open: boolean
}

export type VenueDetails = Venue & {
  description: string
  hours: string
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseVenue(v: unknown): Venue | undefined {
  if (!isRecord(v)) return undefined
  const id = v['id']
  const name = v['name']
  const city = v['city']
  const open = v['open']
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof city !== 'string' || city.length === 0) return undefined
  if (typeof open !== 'boolean') return undefined
  return { id, name, city, open }
}

export function parseVenueList(body: unknown): Venue[] {
  if (!isRecord(body) || !Array.isArray(body['venues'])) throw new Error('shape')
  const out: Venue[] = []
  for (const item of body['venues']) {
    const venue = parseVenue(item)
    if (venue === undefined) throw new Error('shape')
    out.push(venue)
  }
  return out
}

export function parseVenueDetails(body: unknown): VenueDetails {
  const venue = parseVenue(body)
  if (venue === undefined || !isRecord(body)) throw new Error('shape')
  const description = body['description']
  const hours = body['hours']
  if (typeof description !== 'string' || typeof hours !== 'string') throw new Error('shape')
  return { ...venue, description, hours }
}
