import { haversineMeters, projectPointOnSegment } from './pedestrianOsm.js'

export const CORRIDOR_HALF_WIDTH = {
  crossing: 2.5,
  pedestrianZone: 5.0,
  footway: 1.8,
}

export const ROAD_HALF_WIDTH = {
  primary: 5.0,
  secondary: 4.5,
  tertiary: 4.0,
  residential: 3.5,
  unclassified: 3.5,
  living_street: 4.0,
  service: 3.0,
  default: 3.5,
}

const PEDESTRIAN_AREA_PADDING_METERS = 12

function metersPerDegree(lat) {
  return {
    lat: 111320,
    lng: 111320 * Math.cos((lat * Math.PI) / 180),
  }
}

export function segmentHalfWidth(segment) {
  if (segment?.isRoadSurface) {
    return ROAD_HALF_WIDTH[segment.highway] ?? ROAD_HALF_WIDTH.default
  }
  if (segment?.isPedestrianZone) return CORRIDOR_HALF_WIDTH.pedestrianZone
  if (segment?.isCrossing) return CORRIDOR_HALF_WIDTH.crossing
  return CORRIDOR_HALF_WIDTH.footway
}

function bearingDegrees(from, to) {
  const lat1 = (from.lat * Math.PI) / 180
  const lat2 = (to.lat * Math.PI) / 180
  const dLng = ((to.lng - from.lng) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export function pointInPolygon(point, polygon) {
  if (!polygon?.length) return false

  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].lng
    const yi = polygon[i].lat
    const xj = polygon[j].lng
    const yj = polygon[j].lat
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi + 0) + xi
    if (intersects) inside = !inside
  }

  return inside
}

export function polygonCenter(points) {
  return points.reduce(
    (acc, point) => ({
      lat: acc.lat + point.lat / points.length,
      lng: acc.lng + point.lng / points.length,
    }),
    { lat: 0, lng: 0 },
  )
}

function orderPointsByBearing(points, center) {
  return [...points].sort((a, b) => bearingDegrees(center, a) - bearingDegrees(center, b))
}

function buildAreaFromTwoPoints(a, b) {
  const halfWidth = PEDESTRIAN_AREA_PADDING_METERS
  const leftA = perpendicularOffset(a, a, b, halfWidth)
  const leftB = perpendicularOffset(b, a, b, halfWidth)
  const rightA = perpendicularOffset(a, a, b, -halfWidth)
  const rightB = perpendicularOffset(b, a, b, -halfWidth)
  return [leftA, leftB, rightB, rightA]
}

export function buildWalkAreaVertices(coordinates, countPoints) {
  if (!coordinates?.length) return []

  const used = new Set()
  return coordinates.map((coord) => {
    let bestPoint = null
    let bestDist = Infinity

    countPoints.forEach((countPoint) => {
      if (used.has(countPoint.id)) return
      const dist = haversineMeters(coord, countPoint.original)
      if (dist < bestDist) {
        bestDist = dist
        bestPoint = countPoint
      }
    })

    if (bestPoint) used.add(bestPoint.id)

    return bestPoint
      ? { type: 'count', countPointId: bestPoint.id }
      : { type: 'shape' }
  })
}

export function finalizeWalkArea(polygon, countPoints) {
  if (!polygon?.coordinates?.length) return null

  return {
    coordinates: polygon.coordinates.map((coord) => ({ ...coord })),
    center: polygon.center ?? polygonCenter(polygon.coordinates),
    vertices: buildWalkAreaVertices(polygon.coordinates, countPoints),
  }
}

export function findNearestEdge(coordinates, point, maxDistanceMeters = 10) {
  if (!coordinates?.length) return null

  let best = null

  for (let edgeIndex = 0; edgeIndex < coordinates.length; edgeIndex += 1) {
    const start = coordinates[edgeIndex]
    const end = coordinates[(edgeIndex + 1) % coordinates.length]
    const projection = projectPointOnSegment(point, start, end)

    if (projection.t <= 0.04 || projection.t >= 0.96) continue
    if (!best || projection.distance < best.distance) {
      best = {
        edgeIndex,
        point: projection.point,
        distance: projection.distance,
        t: projection.t,
      }
    }
  }

  if (!best || best.distance > maxDistanceMeters) return null
  return best
}

export function insertVertexOnEdge(coordinates, edgeIndex, point) {
  const next = coordinates.map((coord) => ({ ...coord }))
  next.splice(edgeIndex + 1, 0, { ...point })
  return next
}

export function rebuildWalkArea(coordinates, vertices) {
  if (!coordinates?.length) return null

  return {
    coordinates: coordinates.map((coord) => ({ ...coord })),
    center: polygonCenter(coordinates),
    vertices: vertices.map((vertex) => ({ ...vertex })),
  }
}

function isCollinearWithEdge(edgeStart, edgeEnd, pointOnEdge, nextPoint, toleranceMeters = 1.5) {
  const projection = projectPointOnSegment(nextPoint, edgeStart, edgeEnd)
  return projection.distance <= toleranceMeters
}

export function getEdgeDragVertexIndices(coordinates, edgeIndex) {
  const count = coordinates.length
  const indices = new Set([edgeIndex, (edgeIndex + 1) % count])
  const edgeStart = coordinates[edgeIndex]
  const edgeEnd = coordinates[(edgeIndex + 1) % count]

  let walker = (edgeIndex + 1) % count
  while (true) {
    const next = (walker + 1) % count
    if (next === edgeIndex || indices.has(next)) break
    if (isCollinearWithEdge(edgeStart, edgeEnd, coordinates[walker], coordinates[next])) {
      indices.add(next)
      walker = next
    } else {
      break
    }
  }

  walker = edgeIndex
  while (true) {
    const prev = (walker - 1 + count) % count
    if (prev === (edgeIndex + 1) % count || indices.has(prev)) break
    if (isCollinearWithEdge(edgeStart, edgeEnd, coordinates[prev], coordinates[walker])) {
      indices.add(prev)
      walker = prev
    } else {
      break
    }
  }

  return [...indices]
}

export function computeEdgeOutwardNormal(coordinates, edgeIndex, center) {
  const start = coordinates[edgeIndex]
  const end = coordinates[(edgeIndex + 1) % coordinates.length]
  const mid = {
    lat: (start.lat + end.lat) / 2,
    lng: (start.lng + end.lng) / 2,
  }
  const scale = metersPerDegree(mid.lat)
  const tx = (end.lng - start.lng) * scale.lng
  const ty = (end.lat - start.lat) * scale.lat
  const len = Math.hypot(tx, ty) || 1
  let nx = -ty / len
  let ny = tx / len
  const cx = (mid.lng - center.lng) * scale.lng
  const cy = (mid.lat - center.lat) * scale.lat

  if (nx * cx + ny * cy < 0) {
    nx = -nx
    ny = -ny
  }

  return { nx, ny, scale, mid }
}

export function offsetCoordinatesByNormal(coordinates, indices, offsetMeters, normal) {
  const next = coordinates.map((coord) => ({ ...coord }))
  indices.forEach((index) => {
    next[index] = {
      lat: next[index].lat + (normal.ny * offsetMeters) / normal.scale.lat,
      lng: next[index].lng + (normal.nx * offsetMeters) / normal.scale.lng,
    }
  })
  return next
}

export function dragOffsetAlongNormal(from, to, normal) {
  const dx = (to.lng - from.lng) * normal.scale.lng
  const dy = (to.lat - from.lat) * normal.scale.lat
  return dx * normal.nx + dy * normal.ny
}

export function buildIntersectionAreaPolygon(points) {
  if (!points?.length) return null

  if (points.length === 1) {
    const point = points[0]
    const latDelta = PEDESTRIAN_AREA_PADDING_METERS / 111320
    const lngDelta =
      PEDESTRIAN_AREA_PADDING_METERS /
      (111320 * Math.cos((point.lat * Math.PI) / 180))
    return {
      coordinates: [
        { lat: point.lat - latDelta, lng: point.lng - lngDelta },
        { lat: point.lat - latDelta, lng: point.lng + lngDelta },
        { lat: point.lat + latDelta, lng: point.lng + lngDelta },
        { lat: point.lat + latDelta, lng: point.lng - lngDelta },
      ],
      center: point,
    }
  }

  if (points.length === 2) {
    return {
      coordinates: buildAreaFromTwoPoints(points[0], points[1]),
      center: polygonCenter(points),
    }
  }

  const center = polygonCenter(points)
  return {
    coordinates: orderPointsByBearing(points, center),
    center,
  }
}

function randomBetween(min, max, seed) {
  const x = Math.sin(seed * 127.1) * 43758.5453
  const frac = x - Math.floor(x)
  return min + frac * (max - min)
}

function densifyPath(coordinates, spacingMeters = 1.2) {
  if (coordinates.length < 2) return coordinates

  const dense = [coordinates[0]]
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = coordinates[i - 1]
    const end = coordinates[i]
    const segmentLength = haversineMeters(start, end)
    const steps = Math.max(1, Math.ceil(segmentLength / spacingMeters))

    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps
      dense.push({
        lat: start.lat + t * (end.lat - start.lat),
        lng: start.lng + t * (end.lng - start.lng),
      })
    }
  }

  return dense
}

export function clampPointToPolygon(point, polygon, center = null) {
  if (!polygon?.length) return { ...point }
  if (pointInPolygon(point, polygon)) return { ...point }

  const centroid = center ?? polygonCenter(polygon)
  let best = null

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    const projection = projectPointOnSegment(point, a, b)
    if (!best || projection.distance < best.distance) {
      best = projection
    }
  }

  if (!best) return { ...point }

  const scale = metersPerDegree(best.point.lat)
  const toCenterLat = (centroid.lat - best.point.lat) * scale.lat
  const toCenterLng = (centroid.lng - best.point.lng) * scale.lng
  const len = Math.hypot(toCenterLat, toCenterLng)
  if (len < 0.01) return { ...best.point }

  const inwardMeters = 0.5
  return {
    lat: best.point.lat + (toCenterLat / len) * inwardMeters / scale.lat,
    lng: best.point.lng + (toCenterLng / len) * inwardMeters / scale.lng,
  }
}

function maxLateralInsidePolygon(centerPoint, segment, bounds, searchMax = 18) {
  let positive = 0
  let negative = 0

  for (let offset = 0.4; offset <= searchMax; offset += 0.4) {
    const pos = perpendicularOffset(centerPoint, segment.a, segment.b, offset)
    if (pointInPolygon(pos, bounds)) positive = offset
    else break
  }

  for (let offset = 0.4; offset <= searchMax; offset += 0.4) {
    const neg = perpendicularOffset(centerPoint, segment.a, segment.b, -offset)
    if (pointInPolygon(neg, bounds)) negative = offset
    else break
  }

  return { positive, negative }
}

export function buildPedestrianAreaPath(from, to, walkArea, seed = 1) {
  const bounds = walkArea.coordinates
  const center = walkArea.center ?? polygonCenter(bounds)
  const directDist = haversineMeters(from, to)
  const waypoints = [from]

  const mid = {
    lat: (from.lat + to.lat) / 2,
    lng: (from.lng + to.lng) / 2,
  }

  const wanderScale = Math.min(12, Math.max(3, directDist * 0.18))
  const wanderSign = randomBetween(0, 1, seed + 1) > 0.5 ? 1 : -1
  const wanderMeters = wanderScale * wanderSign * randomBetween(0.35, 1, seed + 2)
  const curvedMid = clampPointToPolygon(
    perpendicularOffset(mid, from, to, wanderMeters),
    bounds,
    center,
  )
  waypoints.push(curvedMid)

  if (directDist > 18 && randomBetween(0, 1, seed + 3) > 0.25) {
    const jitterLat = randomBetween(-0.00004, 0.00004, seed + 4)
    const jitterLng = randomBetween(-0.00004, 0.00004, seed + 5)
    const viaCenter = clampPointToPolygon(
      { lat: center.lat + jitterLat, lng: center.lng + jitterLng },
      bounds,
      center,
    )
    waypoints.push(viaCenter)
  }

  if (directDist > 30 && randomBetween(0, 1, seed + 6) > 0.5) {
    const lateMid = {
      lat: mid.lat * 0.35 + to.lat * 0.65,
      lng: mid.lng * 0.35 + to.lng * 0.65,
    }
    const lateWander =
      wanderScale * 0.6 * (randomBetween(0, 1, seed + 7) > 0.5 ? 1 : -1)
    waypoints.push(
      clampPointToPolygon(
        perpendicularOffset(lateMid, from, to, lateWander),
        bounds,
        center,
      ),
    )
  }

  waypoints.push(to)
  return densifyPath(waypoints)
}

function segmentTouchesBounds(segment, bounds) {
  const mid = {
    lat: (segment.a.lat + segment.b.lat) / 2,
    lng: (segment.a.lng + segment.b.lng) / 2,
  }
  return (
    pointInPolygon(mid, bounds) ||
    pointInPolygon(segment.a, bounds) ||
    pointInPolygon(segment.b, bounds)
  )
}

export function perpendicularOffset(point, segmentStart, segmentEnd, offsetMeters) {
  const scale = metersPerDegree(point.lat)
  const dx = (segmentEnd.lng - segmentStart.lng) * scale.lng
  const dy = (segmentEnd.lat - segmentStart.lat) * scale.lat
  const len = Math.hypot(dx, dy)
  if (len < 0.01) return { ...point }

  const tx = dx / len
  const ty = dy / len
  const nx = -ty
  const ny = tx

  return {
    lat: point.lat + (ny * offsetMeters) / scale.lat,
    lng: point.lng + (nx * offsetMeters) / scale.lng,
  }
}

export function signedLateralMeters(centerPoint, segment, point) {
  const scale = metersPerDegree(centerPoint.lat)
  const tx = (segment.b.lng - segment.a.lng) * scale.lng
  const ty = (segment.b.lat - segment.a.lat) * scale.lat
  const len = Math.hypot(tx, ty)
  if (len < 0.01) return 0

  const px = (point.lng - centerPoint.lng) * scale.lng
  const py = (point.lat - centerPoint.lat) * scale.lat
  return (tx * py - ty * px) / len
}

export function lateralSideOf(centerPoint, segment, point) {
  const lateral = signedLateralMeters(centerPoint, segment, point)
  if (Math.abs(lateral) < 0.08) return 0
  return lateral > 0 ? 1 : -1
}

export function buildWalkableIndex(network, options = {}) {
  const intersectionMode = options.intersectionMode ?? 'crosswalk'
  const bounds = options.walkArea?.coordinates ?? null
  const useBounds = intersectionMode === 'pedestrian-only' && bounds?.length >= 3
  const segments = []

  network.ways.forEach((way) => {
    for (let i = 0; i < way.coordinates.length - 1; i += 1) {
      const segment = {
        a: way.coordinates[i],
        b: way.coordinates[i + 1],
        wayId: way.id,
        isCrossing: way.isCrossing,
        isPedestrianZone: way.isPedestrianZone,
        isRoadSurface: way.isRoadSurface ?? false,
        highway: way.tags?.highway,
      }
      segment.halfWidth = segmentHalfWidth(segment)
      if (useBounds && !segmentTouchesBounds(segment, bounds)) continue
      segments.push(segment)
    }
  })

  function snapToCorridor(point, maxCenterlineDistance = 8) {
    if (useBounds && !pointInPolygon(point, bounds)) return null

    let best = null

    segments.forEach((segment) => {
      const projection = projectPointOnSegment(point, segment.a, segment.b)
      const lateral = signedLateralMeters(projection.point, segment, point)
      const absLateral = Math.abs(lateral)

      if (absLateral > segment.halfWidth + 0.2) return

      const placed = perpendicularOffset(projection.point, segment.a, segment.b, lateral)
      if (useBounds && !pointInPolygon(placed, bounds)) return

      const score = projection.distance + absLateral * 0.35
      if (!best || score < best.score) {
        const clampedLateral = clampLateral(lateral, segment)
        const snappedPoint = perpendicularOffset(
          projection.point,
          segment.a,
          segment.b,
          clampedLateral,
        )
        if (useBounds && !pointInPolygon(snappedPoint, bounds)) return

        best = {
          centerPoint: projection.point,
          point: snappedPoint,
          centerlineDistance: projection.distance,
          lateralOffset: clampedLateral,
          segment,
          score,
        }
      }
    })

    if (!best || best.centerlineDistance > maxCenterlineDistance) return null
    return best
  }

  function clampLateral(lateral, segment, centerPoint = null) {
    if (useBounds && centerPoint) {
      const limits = maxLateralInsidePolygon(centerPoint, segment, bounds)
      return Math.max(-limits.negative, Math.min(limits.positive, lateral))
    }

    const half = segment?.halfWidth ?? CORRIDOR_HALF_WIDTH.footway
    return Math.max(-half, Math.min(half, lateral))
  }

  function clampToBounds(point) {
    if (!useBounds) return point
    return clampPointToPolygon(point, bounds, options.walkArea?.center)
  }

  function positionFromCenter(centerPoint, segment, lateralMeters) {
    const clamped = clampLateral(lateralMeters, segment, centerPoint)
    let point = clampToBounds(
      perpendicularOffset(centerPoint, segment.a, segment.b, clamped),
    )

    if (useBounds && !pointInPolygon(point, bounds)) {
      point = clampToBounds(centerPoint)
      return {
        point,
        lateralOffset: 0,
        segment,
      }
    }

    return {
      point,
      lateralOffset: clamped,
      segment,
    }
  }

  function segmentAtCenterPoint(centerPoint, pathSegment) {
    if (useBounds) {
      const limits = maxLateralInsidePolygon(centerPoint, pathSegment, bounds)
      return {
        a: pathSegment.a,
        b: pathSegment.b,
        halfWidth: Math.max(limits.positive, limits.negative, 2),
        isCrossing: false,
        isPedestrianZone: false,
        isAreaMode: true,
      }
    }

    const snap = snapToCorridor(centerPoint, 6)
    if (snap) return snap.segment

    return {
      a: pathSegment.a,
      b: pathSegment.b,
      halfWidth: CORRIDOR_HALF_WIDTH.footway,
      isCrossing: false,
      isPedestrianZone: false,
    }
  }

  return {
    segments,
    snapToCorridor,
    positionFromCenter,
    clampLateral,
    clampToBounds,
    segmentAtCenterPoint,
    segmentHalfWidth,
    walkArea: options.walkArea ?? null,
    boundsPolygon: bounds,
    intersectionMode,
    useBounds,
  }
}

export function advanceAlongPolyline(path, distanceAlong, moveMeters, walkable = null) {
  const totalLength = pathLength(path)
  const target = Math.min(distanceAlong + moveMeters, totalLength)
  let walked = 0

  for (let i = 1; i < path.length; i += 1) {
    const segmentLength = haversineMeters(path[i - 1], path[i])
    if (walked + segmentLength >= target) {
      const t = (target - walked) / segmentLength
      const centerPoint = {
        lat: path[i - 1].lat + t * (path[i].lat - path[i - 1].lat),
        lng: path[i - 1].lng + t * (path[i].lng - path[i - 1].lng),
      }
      const pathSegment = { a: path[i - 1], b: path[i] }
      const segment = walkable?.segmentAtCenterPoint(centerPoint, pathSegment) ?? {
        ...pathSegment,
        halfWidth: CORRIDOR_HALF_WIDTH.footway,
        isCrossing: false,
        isPedestrianZone: false,
      }

      return {
        centerPoint,
        segment,
        distanceAlong: target,
        arrived: target >= totalLength - 0.05,
      }
    }
    walked += segmentLength
  }

  const last = path[path.length - 1]
  const prev = path[path.length - 2] ?? last
  const pathSegment = { a: prev, b: last }
  const segment = walkable?.segmentAtCenterPoint(last, pathSegment) ?? {
    ...pathSegment,
    halfWidth: CORRIDOR_HALF_WIDTH.footway,
    isCrossing: false,
    isPedestrianZone: false,
  }

  return {
    centerPoint: last,
    segment,
    distanceAlong: totalLength,
    arrived: true,
  }
}

export function buildCorridorPolygons(network) {
  const polygons = []

  network.ways.forEach((way) => {
    const half = way.isPedestrianZone
      ? CORRIDOR_HALF_WIDTH.pedestrianZone
      : way.isCrossing
        ? CORRIDOR_HALF_WIDTH.crossing
        : CORRIDOR_HALF_WIDTH.footway

    for (let i = 0; i < way.coordinates.length - 1; i += 1) {
      const a = way.coordinates[i]
      const b = way.coordinates[i + 1]
      const leftA = perpendicularOffset(a, a, b, half)
      const leftB = perpendicularOffset(b, a, b, half)
      const rightA = perpendicularOffset(a, a, b, -half)
      const rightB = perpendicularOffset(b, a, b, -half)

      polygons.push({
        coordinates: [leftA, leftB, rightB, rightA],
        isCrossing: way.isCrossing,
        isPedestrianZone: way.isPedestrianZone,
      })
    }
  })

  return polygons
}

function pathLength(path) {
  return path.reduce((total, coord, index) => {
    if (index === 0) return 0
    return total + haversineMeters(path[index - 1], coord)
  }, 0)
}
