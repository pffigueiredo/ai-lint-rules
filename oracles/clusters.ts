import Supercluster, { type PointFeature } from 'supercluster'

export type Place = { id: string; lng: number; lat: number }
export type Cluster = { id: number; n: number; lng: number; lat: number }
export type Markers = { pins: Place[]; clusters: Cluster[] }

/** Above this zoom every place is its own pin. */
export const MAX_CLUSTER_ZOOM = 13
const WORLD: [number, number, number, number] = [-180, -85, 180, 85]

function feature(place: Place): PointFeature<Place> {
  return { type: 'Feature', properties: place, geometry: { type: 'Point', coordinates: [place.lng, place.lat] } }
}

/** `open` is the place on screen: it stays pinned even when it isn't in `places`. */
export function markersAt(places: Place[], zoom: number, open?: Place): Markers {
  const index = new Supercluster<Place>({ radius: 50, maxZoom: MAX_CLUSTER_ZOOM })
  index.load(places.map(feature))
  const pins: Place[] = []
  const clusters: Cluster[] = []
  for (const point of index.getClusters(WORLD, zoom)) {
    const [lng, lat] = point.geometry.coordinates
    if (lng === undefined || lat === undefined) continue
    if ('cluster' in point.properties) {
      clusters.push({ id: point.properties.cluster_id, n: point.properties.point_count, lng, lat })
    } else {
      pins.push(point.properties)
    }
  }
  if (open && !places.some((p) => p.id === open.id)) pins.push(open)
  return { pins, clusters }
}
