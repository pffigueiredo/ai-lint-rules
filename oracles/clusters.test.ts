import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MAX_CLUSTER_ZOOM, markersAt } from './clusters'

const places = fc.uniqueArray(
  fc.record({
    id: fc.stringMatching(/^[a-z]{1,8}$/),
    lng: fc.double({ min: -10, max: 30, noNaN: true }),
    lat: fc.double({ min: 35, max: 60, noNaN: true }),
  }),
  { selector: (p) => p.id, maxLength: 60 },
)
const zoom = fc.integer({ min: 0, max: 18 })

describe('markersAt: every place is on the map exactly once', () => {
  it('as a pin or inside one cluster, at any zoom', () => {
    fc.assert(
      fc.property(places, zoom, (all, z) => {
        const m = markersAt(all, z)
        const pinned = m.pins.map((p) => p.id)
        expect(new Set(pinned).size, 'no place is pinned twice').toBe(pinned.length)
        expect(pinned.length + m.clusters.reduce((s, c) => s + c.n, 0)).toBe(all.length)
        if (z > MAX_CLUSTER_ZOOM) expect([...pinned].sort()).toEqual(all.map((p) => p.id).sort())
      }),
      { numRuns: 500 },
    )
  })

  it('pins the open place once, adding it only when it is missing', () => {
    fc.assert(
      fc.property(places, zoom, fc.nat(), fc.boolean(), (all, z, pick, missing) => {
        const existing = all[pick % Math.max(all.length, 1)]
        const open = missing || !existing ? { id: 'open-place', lng: 2.17, lat: 41.38 } : existing
        const without = markersAt(all, z).pins.map((p) => p.id)
        const withOpen = markersAt(all, z, open).pins.map((p) => p.id)
        expect(withOpen).toEqual(all.includes(open) ? without : [...without, open.id])
      }),
      { numRuns: 500 },
    )
  })
})
