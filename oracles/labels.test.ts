import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { labeledPins, type Pin } from './labels'

/** The rule's own copy of the box size. Importing it from labels.ts would let a changed box pass. */
const LABEL_BOX = { width: 96, height: 16 }

/** Web Mercator pixels, written from the standard formula rather than imported from labels.ts. */
function px(lng: number, lat: number, zoom: number): [number, number] {
  const size = 256 * 2 ** zoom
  const rad = (lat * Math.PI) / 180
  return [((lng + 180) / 360) * size, ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * size]
}

function collide(a: Pin, b: Pin, zoom: number): boolean {
  const [ax, ay] = px(a.lng, a.lat, zoom)
  const [bx, by] = px(b.lng, b.lat, zoom)
  return Math.abs(ax - bx) < LABEL_BOX.width && Math.abs(ay - by) < LABEL_BOX.height
}

const pins = fc.uniqueArray(
  fc.record({
    id: fc.stringMatching(/^[a-z]{1,8}$/),
    name: fc.string({ minLength: 1, maxLength: 24 }),
    lng: fc.double({ min: -3.8, max: -3.6, noNaN: true }),
    lat: fc.double({ min: 40.35, max: 40.5, noNaN: true }),
    visited: fc.boolean(),
  }),
  { selector: (p) => p.id, maxLength: 30 },
)

describe('labeledPins: names never overlap, and none is hidden without a reason', () => {
  it('holds for any set of pins at any zoom', () => {
    fc.assert(
      fc.property(pins, fc.integer({ min: 8, max: 16 }), fc.option(fc.nat()), (all, zoom, pick) => {
        const keep = pick === null ? null : (all[pick % Math.max(all.length, 1)]?.id ?? null)
        const shown = labeledPins(all, zoom, keep)
        const labeled = all.filter((p) => shown.has(p.id))
        if (keep) expect(shown.has(keep), 'the open pin keeps its name').toBe(true)
        for (const a of labeled) {
          for (const b of labeled) {
            if (a !== b && a.id !== keep && b.id !== keep) {
              expect(collide(a, b, zoom), `${a.id} and ${b.id} overlap at zoom ${zoom}`).toBe(false)
            }
          }
        }
        for (const p of all.filter((x) => !shown.has(x.id))) {
          expect(labeled.some((l) => collide(p, l, zoom)), `${p.id} is hidden but overlaps nothing`).toBe(true)
        }
      }),
      { numRuns: 1000 },
    )
  })
})
