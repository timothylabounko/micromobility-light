import { snapPointToPedestrianNetwork } from './pedestrianOsm.js'
import {
  buildIntersectionAreaPolygon,
  finalizeWalkArea,
  polygonCenter,
} from './walkableNetwork.js'

export const INTERSECTION_MODES = {
  CROSSWALK: 'crosswalk',
  PEDESTRIAN_ONLY: 'pedestrian-only',
}

export const MIN_COUNT_POINTS = 2

function bearingDegrees(from, to) {
  const lat1 = (from.lat * Math.PI) / 180
  const lat2 = (to.lat * Math.PI) / 180
  const dLng = ((to.lng - from.lng) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function normalizeAngle(angle) {
  let value = angle % 360
  if (value < 0) value += 360
  return value
}

function angleDifference(fromBearing, toBearing) {
  let diff = normalizeAngle(toBearing - fromBearing)
  if (diff > 180) diff -= 360
  return diff
}

function compassLabel(bearing) {
  if (bearing >= 337.5 || bearing < 22.5) return 'North'
  if (bearing < 67.5) return 'Northeast'
  if (bearing < 112.5) return 'East'
  if (bearing < 157.5) return 'Southeast'
  if (bearing < 202.5) return 'South'
  if (bearing < 247.5) return 'Southwest'
  if (bearing < 292.5) return 'West'
  return 'Northwest'
}

function classifyTurnMovement(angleDiff) {
  const abs = Math.abs(angleDiff)
  if (abs < 30) return 'u-turn'
  if (angleDiff > 30 && angleDiff < 150) return 'right'
  if (angleDiff < -30 && angleDiff > -150) return 'left'
  return 'through'
}

function classifyIntersectionType(approaches) {
  if (approaches.length < 3) return 'unsignalized'
  if (approaches.length === 4) {
    const bearings = approaches.map((approach) => approach.bearing).sort((a, b) => a - b)
    const gaps = []
    for (let i = 0; i < bearings.length; i += 1) {
      const next = bearings[(i + 1) % bearings.length]
      const current = bearings[i]
      const gap = normalizeAngle(next - current)
      gaps.push(gap)
    }
    const nearRightAngles = gaps.filter((gap) => Math.abs(gap - 90) < 25).length
    if (nearRightAngles >= 3) return 'four-way'
    return 'complex-four-leg'
  }
  if (approaches.length === 3) return 'three-way'
  return 'multi-leg'
}

function movementLabel(fromApproach, toApproach, turnType) {
  const turnNames = {
    through: 'cross',
    left: 'left turn',
    right: 'right turn',
    'u-turn': 'u-turn',
  }
  return `${fromApproach.label} → ${toApproach.label} (${turnNames[turnType]})`
}

function buildMovementsFromApproaches(approaches) {
  const movements = []

  for (const fromApproach of approaches) {
    for (const toApproach of approaches) {
      if (fromApproach.id === toApproach.id) continue

      const angleDiff = angleDifference(fromApproach.bearing, toApproach.bearing)
      const turnType = classifyTurnMovement(angleDiff)

      movements.push({
        id: `${fromApproach.id}-to-${toApproach.id}`,
        fromApproachId: fromApproach.id,
        toApproachId: toApproach.id,
        fromLabel: fromApproach.label,
        toLabel: toApproach.label,
        turnType,
        label: movementLabel(fromApproach, toApproach, turnType),
        angleDiff,
      })
    }
  }

  return movements
}

function buildApproachMovements(approaches, movements) {
  return approaches.map((approach) => ({
    approachId: approach.id,
    approachLabel: approach.label,
    movements: movements.filter((movement) => movement.fromApproachId === approach.id),
  }))
}

function updateCountPointsFromWalkArea(countPoints, walkArea) {
  const center = walkArea.center ?? polygonCenter(walkArea.coordinates)

  return countPoints.map((countPoint) => {
    const vertexIndex = walkArea.vertices.findIndex(
      (vertex) => vertex.type === 'count' && vertex.countPointId === countPoint.id,
    )
    if (vertexIndex < 0) return countPoint

    const point = walkArea.coordinates[vertexIndex]
    const bearing = bearingDegrees(center, point)

    return {
      ...countPoint,
      original: point,
      snapped: point,
      snap: { point, distance: 0, way: null },
      bearing,
      compass: compassLabel(bearing),
    }
  })
}

export function applyWalkAreaEdit(analysis, walkArea) {
  if (analysis.intersectionMode !== INTERSECTION_MODES.PEDESTRIAN_ONLY || !walkArea) {
    return analysis
  }

  const countPoints = updateCountPointsFromWalkArea(analysis.countPoints, walkArea)
  const center = walkArea.center ?? polygonCenter(walkArea.coordinates)
  const approaches = [...countPoints].sort((a, b) => a.bearing - b.bearing)
  const intersectionType = classifyIntersectionType(approaches)
  const movements = buildMovementsFromApproaches(approaches)

  return {
    ...analysis,
    center,
    countPoints,
    approaches,
    movements,
    approachMovements: buildApproachMovements(approaches, movements),
    intersectionType,
    walkArea,
    hubSnap: { point: center, way: null },
    hubPoint: center,
    summary: buildSummary(intersectionType, approaches, movements, analysis.intersectionMode),
  }
}

export function analyzeIntersection(points, network, options = {}) {
  const mode = options.mode ?? INTERSECTION_MODES.CROSSWALK
  const center = points.reduce(
    (acc, point) => ({
      lat: acc.lat + point.lat / points.length,
      lng: acc.lng + point.lng / points.length,
    }),
    { lat: 0, lng: 0 },
  )

  const snappedPoints = points.map((point, index) => {
    const snap =
      mode === INTERSECTION_MODES.PEDESTRIAN_ONLY
        ? null
        : network?.ways
          ? requireSnap(point, network, index)
          : null

    if (mode !== INTERSECTION_MODES.PEDESTRIAN_ONLY && !snap) {
      throw new Error(
        `Point ${String.fromCharCode(65 + index)} is too far from a sidewalk or crosswalk. Click closer to the pedestrian network.`,
      )
    }

    const boundaryPoint = mode === INTERSECTION_MODES.PEDESTRIAN_ONLY ? point : snap.point
    const bearing = bearingDegrees(center, boundaryPoint)
    return {
      id: `approach-${index + 1}`,
      index,
      label: String.fromCharCode(65 + index),
      original: point,
      snapped: boundaryPoint,
      snap:
        mode === INTERSECTION_MODES.PEDESTRIAN_ONLY
          ? { point: boundaryPoint, distance: 0, way: null }
          : snap,
      snapDistance: snap?.distance ?? 0,
      bearing,
      compass: compassLabel(bearing),
      pedestrianFeature: snap?.way?.tags?.highway ?? 'boundary',
      isCrossing: snap?.way?.isCrossing ?? false,
      isPedestrianZone: snap?.way?.isPedestrianZone ?? false,
    }
  })

  const countPoints = snappedPoints
  const approaches = [...snappedPoints].sort((a, b) => a.bearing - b.bearing)
  const intersectionType = classifyIntersectionType(approaches)

  const movements = buildMovementsFromApproaches(approaches)
  const approachMovements = buildApproachMovements(approaches, movements)

  const walkArea =
    mode === INTERSECTION_MODES.PEDESTRIAN_ONLY
      ? finalizeWalkArea(
          buildIntersectionAreaPolygon(snappedPoints.map((point) => point.original)),
          snappedPoints,
        )
      : null

  return {
    center,
    intersectionType,
    countPoints,
    approaches,
    movements,
    approachMovements,
    intersectionMode: mode,
    walkArea,
    summary: buildSummary(intersectionType, approaches, movements, mode),
    hubSnap: null,
  }
}

export function attachIntersectionHub(analysis, hubSnap) {
  return {
    ...analysis,
    hubSnap,
    hubPoint: hubSnap?.point ?? analysis.center,
  }
}

function requireSnap(point, network, index) {
  return snapPointToPedestrianNetwork(point, network)
}

function buildSummary(intersectionType, approaches, movements, mode) {
  const typeLabels = {
    'four-way': 'four-way intersection',
    'three-way': 'three-way (T) intersection',
    'complex-four-leg': 'four-leg intersection (non-orthogonal)',
    'multi-leg': 'multi-leg intersection',
    unsignalized: 'intersection',
  }

  const modeLabel =
    mode === INTERSECTION_MODES.PEDESTRIAN_ONLY
      ? 'pedestrian-only intersection'
      : 'crosswalk intersection'

  const turnCounts = movements.reduce(
    (acc, movement) => {
      acc[movement.turnType] = (acc[movement.turnType] ?? 0) + 1
      return acc
    },
    {},
  )

  return {
    typeLabel: typeLabels[intersectionType] ?? 'intersection',
    modeLabel,
    intersectionMode: mode,
    approachCount: approaches.length,
    movementCount: movements.length,
    turnCounts,
    usesCrosswalks: approaches.some((approach) => approach.isCrossing),
    usesPedestrianZones: approaches.some((approach) => approach.isPedestrianZone),
  }
}

export function parseApproachCounts(text, approachCount = MIN_COUNT_POINTS) {
  const numbers = text
    .trim()
    .split(/[\s,]+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => !Number.isNaN(value))

  if (numbers.length !== approachCount || approachCount < MIN_COUNT_POINTS) {
    return null
  }

  return numbers
}

export function totalApproachCount(approachCounts) {
  return approachCounts.reduce((sum, count) => sum + (count ?? 0), 0)
}

export function totalMovementCount(assignments) {
  return assignments.reduce((sum, assignment) => sum + assignment.count, 0)
}

export function summarizePointFlows(assignments, analysis) {
  return analysis.countPoints.map((point) => {
    const departing = assignments
      .filter((assignment) => assignment.movement.fromApproachId === point.id)
      .reduce((sum, assignment) => sum + assignment.count, 0)
    const arriving = assignments
      .filter((assignment) => assignment.movement.toApproachId === point.id)
      .reduce((sum, assignment) => sum + assignment.count, 0)

    return {
      approachId: point.id,
      label: point.label,
      compass: point.compass,
      departing,
      arriving,
    }
  })
}

export function distributeCountsToMovements(approachCounts, analysis) {
  const assignments = []

  analysis.countPoints.forEach((countPoint, index) => {
    const total =
      approachCounts[index] ??
      approachCounts[analysis.countPoints.indexOf(countPoint)] ??
      0
    const outgoing = analysis.movements.filter(
      (movement) => movement.fromApproachId === countPoint.id,
    )

    if (outgoing.length === 0 || total <= 0) return

    const base = Math.floor(total / outgoing.length)
    let remainder = total % outgoing.length

    outgoing.forEach((movement) => {
      let count = base
      if (remainder > 0) {
        count += 1
        remainder -= 1
      }

      if (count > 0) {
        const destination =
          analysis.countPoints.find((item) => item.id === movement.toApproachId) ??
          analysis.approaches.find((item) => item.id === movement.toApproachId)

        const useBoundaryPoints = analysis.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
        assignments.push({
          movementId: movement.id,
          movement,
          count,
          from: useBoundaryPoints ? countPoint.original : countPoint.snapped,
          to: useBoundaryPoints ? destination?.original : destination?.snapped,
          fromSnap: useBoundaryPoints
            ? { point: countPoint.original, way: null }
            : countPoint.snap,
          toSnap: useBoundaryPoints
            ? { point: destination?.original, way: null }
            : destination?.snap,
        })
      }
    })
  })

  return assignments
}
