import { haversineMeters, projectPointOnSegment } from './pedestrianOsm.js'

export const CORRIDOR_HALF_WIDTH = {
  crossing: 2.5,
  pedestrianZone: 5.0,
  footway: 1.8,
}

function metersPerDegree(lat) {
  return {
    lat: 111320,
    lng: 111320 * Math.cos((lat * Math.PI) / 180),
  }
}

export function segmentHalfWidth(segment) {
  if (segment?.isPedestrianZone) return CORRIDOR_HALF_WIDTH.pedestrianZone
  if (segment?.isCrossing) return CORRIDOR_HALF_WIDTH.crossing
  return CORRIDOR_HALF_WIDTH.footway
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

export function buildWalkableIndex(network) {
  const segments = []

  network.ways.forEach((way) => {
    for (let i = 0; i < way.coordinates.length - 1; i += 1) {
      const segment = {
        a: way.coordinates[i],
        b: way.coordinates[i + 1],
        wayId: way.id,
        isCrossing: way.isCrossing,
        isPedestrianZone: way.isPedestrianZone,
      }
      segment.halfWidth = segmentHalfWidth(segment)
      segments.push(segment)
    }
  })

  function snapToCorridor(point, maxCenterlineDistance = 8) {
    let best = null

    segments.forEach((segment) => {
      const projection = projectPointOnSegment(point, segment.a, segment.b)
      const lateral = signedLateralMeters(projection.point, segment, point)
      const absLateral = Math.abs(lateral)

      if (absLateral > segment.halfWidth + 0.2) return

      const score = projection.distance + absLateral * 0.35
      if (!best || score < best.score) {
        const clampedLateral = clampLateral(lateral, segment)
        best = {
          centerPoint: projection.point,
          point: perpendicularOffset(projection.point, segment.a, segment.b, clampedLateral),
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

  function clampLateral(lateral, segment) {
    const half = segment?.halfWidth ?? CORRIDOR_HALF_WIDTH.footway
    return Math.max(-half, Math.min(half, lateral))
  }

  function positionFromCenter(centerPoint, segment, lateralMeters) {
    const clamped = clampLateral(lateralMeters, segment)
    return {
      point: perpendicularOffset(centerPoint, segment.a, segment.b, clamped),
      lateralOffset: clamped,
      segment,
    }
  }

  function segmentAtCenterPoint(centerPoint, pathSegment) {
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
    segmentAtCenterPoint,
    segmentHalfWidth,
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
