export type Pin = { id: string; name: string; lng: number; lat: number; visited: boolean }

/** The label box, in screen pixels, that two names may not share. */
const LABEL_BOX = { width: 96, height: 16 }

function mapPx(lng: number, lat: number, zoom: number): [number, number] {
  const size = 256 * 2 ** zoom
  const sin = Math.sin((lat * Math.PI) / 180)
  return [((lng + 180) / 360) * size, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size]
}

/**
 * Which pins show their name at `zoom`. Greedy: visited pins first, then shorter names, and a name is
 * hidden when its box would overlap one already shown. `keep` (the open pin) always shows.
 */
export function labeledPins(pins: Pin[], zoom: number, keep: string | null): Set<string> {
  const shown: [number, number][] = []
  const out = new Set<string>()
  const order = [...pins].sort((a, b) => Number(b.visited) - Number(a.visited) || a.name.length - b.name.length)
  for (const pin of order) {
    const [x, y] = mapPx(pin.lng, pin.lat, zoom)
    const overlaps = shown.some(
      ([sx, sy]) => Math.abs(sx - x) < LABEL_BOX.width && Math.abs(sy - y) < LABEL_BOX.height,
    )
    if (keep !== pin.id && overlaps) continue
    shown.push([x, y])
    out.add(pin.id)
  }
  return out
}
