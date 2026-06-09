import { haversineMeters, snapPointToPedestrianNetwork } from './pedestrianOsm.js'
import { perpendicularOffset } from './walkableNetwork.js'

const WALK_SPEED_MPS = 1.4
const SIM_DURATION_SECONDS = 20
const MAX_VISIBLE_AGENTS_PER_MOVEMENT = 12
const WAY_CONNECTION_METERS = 22

function resolveSnap(network, snap, fallbackPoint) {
  if (snap?.way?.coordinates?.length >= 2 && snap?.point) {
    return snap
  }

  const point = snap?.point ?? fallbackPoint
  const resolved = snapPointToPedestrianNetwork(point, network)
  if (resolved) return resolved

  return null
}

function closestVertexIndex(coordinates, point) {
  let bestIdx = 0
  let bestDist = Infinity

  coordinates.forEach((coord, index) => {
    const distance = haversineMeters(coord, point)
    if (distance < bestDist) {
      bestDist = distance
      bestIdx = index
    }
  })

  return bestIdx
}

function appendCoordinate(path, coord) {
  const last = path[path.length - 1]
  if (!last || haversineMeters(last, coord) > 0.2) {
    path.push(coord)
  }
}

function walkAlongWay(way, startPoint, targetPoint) {
  const coordinates = way.coordinates
  const startIdx = closestVertexIndex(coordinates, startPoint)
  const targetIdx = closestVertexIndex(coordinates, targetPoint)
  const path = [startPoint]

  if (startIdx === targetIdx) {
    appendCoordinate(path, coordinates[startIdx])
    appendCoordinate(path, targetPoint)
    return path
  }

  if (startIdx < targetIdx) {
    for (let i = startIdx + 1; i <= targetIdx; i += 1) {
      appendCoordinate(path, coordinates[i])
    }
  } else {
    for (let i = startIdx - 1; i >= targetIdx; i -= 1) {
      appendCoordinate(path, coordinates[i])
    }
  }

  appendCoordinate(path, targetPoint)
  return path
}

function wayEndpoints(way) {
  const coordinates = way.coordinates
  return [coordinates[0], coordinates[coordinates.length - 1]]
}

function findWayLink(wayA, wayB) {
  let best = null

  wayEndpoints(wayA).forEach((fromCoord) => {
    wayEndpoints(wayB).forEach((toCoord) => {
      const distance = haversineMeters(fromCoord, toCoord)
      if (!best || distance < best.distance) {
        best = { fromCoord, toCoord, distance }
      }
    })
  })

  return best
}

function buildWayAdjacency(ways) {
  const adjacency = new Map()

  ways.forEach((way) => {
    adjacency.set(way.id, [])
  })

  for (let i = 0; i < ways.length; i += 1) {
    for (let j = i + 1; j < ways.length; j += 1) {
      const link = findWayLink(ways[i], ways[j])
      if (!link || link.distance > WAY_CONNECTION_METERS) continue

      adjacency.get(ways[i].id).push({ wayId: ways[j].id, link })
      adjacency.get(ways[j].id).push({
        wayId: ways[i].id,
        link: { fromCoord: link.toCoord, toCoord: link.fromCoord, distance: link.distance },
      })
    }
  }

  return adjacency
}

function seededOrder(items, seed) {
  return [...items].sort((a, b) => {
    const hashA = Math.sin(seed * 12.9898 + a.wayId * 78.233) * 43758.5453
    const hashB = Math.sin(seed * 12.9898 + b.wayId * 78.233) * 43758.5453
    return (hashA - Math.floor(hashA)) - (hashB - Math.floor(hashB))
  })
}

function findWayPath(ways, startWayId, endWayId, seed = 0) {
  if (startWayId === endWayId) return [startWayId]

  const adjacency = buildWayAdjacency(ways)
  const queue = [startWayId]
  const previous = new Map()
  const visited = new Set([startWayId])

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === endWayId) break

    const neighbors = seededOrder(adjacency.get(current) ?? [], seed + current.length)
    neighbors.forEach((neighbor) => {
      if (visited.has(neighbor.wayId)) return
      visited.add(neighbor.wayId)
      previous.set(neighbor.wayId, { wayId: current, link: neighbor.link })
      queue.push(neighbor.wayId)
    })
  }

  if (!visited.has(endWayId)) return null

  const path = [endWayId]
  let current = endWayId
  while (previous.has(current)) {
    const step = previous.get(current)
    path.unshift(step.wayId)
    current = step.wayId
  }

  return path
}

function getWayById(ways, wayId) {
  return ways.find((way) => way.id === wayId)
}

function offsetPointAlongWay(way, point, offsetMeters, direction = 1) {
  const coordinates = way.coordinates
  const startIdx = closestVertexIndex(coordinates, point)
  let remaining = Math.abs(offsetMeters)
  let current = { ...point }
  const step = direction >= 0 ? 1 : -1

  for (
    let i = startIdx;
    remaining > 0 && i >= 0 && i < coordinates.length - 1;
    i += step
  ) {
    const nextIdx = i + step
    if (nextIdx < 0 || nextIdx >= coordinates.length) break

    const segmentLength = haversineMeters(coordinates[i], coordinates[nextIdx])
    if (segmentLength <= remaining) {
      remaining -= segmentLength
      current = { ...coordinates[nextIdx] }
      continue
    }

    const t = remaining / segmentLength
    current = {
      lat: coordinates[i].lat + t * (coordinates[nextIdx].lat - coordinates[i].lat),
      lng: coordinates[i].lng + t * (coordinates[nextIdx].lng - coordinates[i].lng),
    }
    remaining = 0
  }

  return current
}

function buildRouteOnWays(ways, fromSnap, toSnap, seed = 0) {
  if (!fromSnap?.way || !toSnap?.way) return null

  if (fromSnap.way.id === toSnap.way.id) {
    return walkAlongWay(fromSnap.way, fromSnap.point, toSnap.point)
  }

  const wayIds = findWayPath(ways, fromSnap.way.id, toSnap.way.id, seed)
  if (!wayIds || wayIds.length === 0) return null

  const path = [fromSnap.point]
  let currentWay = fromSnap.way
  let currentPoint = fromSnap.point

  for (let i = 1; i < wayIds.length; i += 1) {
    const nextWay = getWayById(ways, wayIds[i])
    if (!nextWay) return null

    const link = findWayLink(currentWay, nextWay)
    if (!link) return null

    const towardExit = walkAlongWay(currentWay, currentPoint, link.fromCoord)
    towardExit.forEach((coord) => appendCoordinate(path, coord))
    appendCoordinate(path, link.toCoord)

    currentWay = nextWay
    currentPoint = link.toCoord
  }

  const finalLeg = walkAlongWay(currentWay, currentPoint, toSnap.point)
  finalLeg.forEach((coord) => appendCoordinate(path, coord))

  return path.length >= 2 ? path : null
}

function mergeCoordinatePaths(paths) {
  const merged = []
  paths.forEach((path) => {
    path?.forEach((coord) => appendCoordinate(merged, coord))
  })
  return merged
}

function densifyPath(coordinates, spacingMeters = 1.5) {
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

function pathLength(coordinates) {
  return coordinates.reduce((total, coord, index) => {
    if (index === 0) return 0
    return total + haversineMeters(coordinates[index - 1], coord)
  }, 0)
}

export function findIntersectionHub(network, center) {
  const crossingWays = network.ways.filter((way) => way.isCrossing)
  const crossingNetwork = crossingWays.length ? { ways: crossingWays } : network

  const snapped = snapPointToPedestrianNetwork(center, crossingNetwork)
  if (snapped) return snapped

  return snapPointToPedestrianNetwork(center, network)
}

function offsetHubLaterally(hub, lateralMeters) {
  if (!lateralMeters || !hub?.way?.coordinates?.length) return hub

  const coords = hub.way.coordinates
  const idx = closestVertexIndex(coords, hub.point)
  const a = coords[Math.max(0, idx - 1)] ?? coords[0]
  const b = coords[Math.min(coords.length - 1, idx + 1)] ?? coords[coords.length - 1]

  return {
    ...hub,
    point: perpendicularOffset(hub.point, a, b, lateralMeters),
  }
}

export function findPedestrianRoute(network, fromSnap, toSnap, hubSnap, options = {}) {
  const {
    seed = 0,
    fromOffsetMeters = 0,
    toOffsetMeters = 0,
    hubLateralOffset = 0,
  } = options
  const from = resolveSnap(network, fromSnap, fromSnap?.point)
  const to = resolveSnap(network, toSnap, toSnap?.point)
  const hub = resolveSnap(network, hubSnap, hubSnap?.point)

  if (!from || !to || !hub) return null

  const variedFrom = fromOffsetMeters
    ? { ...from, point: offsetPointAlongWay(from.way, from.point, fromOffsetMeters, 1) }
    : from
  const variedTo = toOffsetMeters
    ? { ...to, point: offsetPointAlongWay(to.way, to.point, toOffsetMeters, -1) }
    : to
  const variedHub = offsetHubLaterally(hub, hubLateralOffset)

  const inbound = buildRouteOnWays(network.ways, variedFrom, variedHub, seed)
  const outbound = buildRouteOnWays(network.ways, variedHub, variedTo, seed + 7)

  let merged = null
  if (inbound && outbound) {
    merged = mergeCoordinatePaths([inbound, outbound])
  } else {
    merged = buildRouteOnWays(network.ways, from, to)
  }

  if (!merged || merged.length < 2) return null

  const coordinates = densifyPath(merged)

  return {
    coordinates,
    lengthMeters: pathLength(coordinates),
    isValid: true,
  }
}

function interpolateAlongRoute(coordinates, progress) {
  const totalLength = pathLength(coordinates)
  if (totalLength === 0) return coordinates[0]

  const target = progress * totalLength
  let walked = 0

  for (let i = 1; i < coordinates.length; i += 1) {
    const segmentLength = haversineMeters(coordinates[i - 1], coordinates[i])
    if (walked + segmentLength >= target) {
      const t = (target - walked) / segmentLength
      return {
        lat: coordinates[i - 1].lat + t * (coordinates[i].lat - coordinates[i - 1].lat),
        lng: coordinates[i - 1].lng + t * (coordinates[i - 1].lng - coordinates[i - 1].lng),
      }
    }
    walked += segmentLength
  }

  return coordinates[coordinates.length - 1]
}

export function buildSimulationPlan(network, assignments, hubSnap) {
  const hub = resolveSnap(network, hubSnap, hubSnap?.point)
  if (!hub) return []

  const plans = []

  assignments.forEach((assignment) => {
    const from = resolveSnap(network, assignment.fromSnap, assignment.from)
    const to = resolveSnap(network, assignment.toSnap, assignment.to)
    if (!from || !to) return

    const route = findPedestrianRoute(network, from, to, hub)
    if (!route?.isValid || route.coordinates.length < 2) return

    const visibleAgents = Math.min(assignment.count, MAX_VISIBLE_AGENTS_PER_MOVEMENT)
    const travelSeconds = Math.max(route.lengthMeters / WALK_SPEED_MPS, 3)

    plans.push({
      ...assignment,
      route,
      travelSeconds,
      agents: Array.from({ length: visibleAgents }, (_, index) => ({
        id: `${assignment.movementId}-${index}`,
        spawnOffsetSeconds: (index / Math.max(visibleAgents, 1)) * SIM_DURATION_SECONDS,
        progress: 0,
        active: false,
        completed: false,
      })),
    })
  })

  return plans
}

export function createSimulationController(plans, onUpdate) {
  let elapsedSeconds = 0
  let animationFrame = null
  let lastTimestamp = null
  const timeScale = 3

  const step = (timestamp) => {
    if (lastTimestamp == null) lastTimestamp = timestamp
    const deltaSeconds = ((timestamp - lastTimestamp) / 1000) * timeScale
    lastTimestamp = timestamp
    elapsedSeconds += deltaSeconds

    const agentPositions = []

    plans.forEach((plan) => {
      plan.agents.forEach((agent) => {
        if (elapsedSeconds < agent.spawnOffsetSeconds) return

        const travelElapsed = elapsedSeconds - agent.spawnOffsetSeconds
        agent.progress = Math.min(travelElapsed / plan.travelSeconds, 1)
        agent.active = agent.progress < 1
        agent.completed = agent.progress >= 1

        if (agent.active) {
          agentPositions.push({
            id: agent.id,
            latlng: interpolateAlongRoute(plan.route.coordinates, agent.progress),
            movementId: plan.movementId,
            turnType: plan.movement.turnType,
          })
        }
      })
    })

    onUpdate({ elapsedSeconds, agentPositions })

    const stillRunning = plans.some((plan) =>
      plan.agents.some((agent) => !agent.completed),
    )

    if (stillRunning || elapsedSeconds < SIM_DURATION_SECONDS + 5) {
      animationFrame = requestAnimationFrame(step)
    }
  }

  return {
    start() {
      elapsedSeconds = 0
      lastTimestamp = null
      animationFrame = requestAnimationFrame(step)
    },
    stop() {
      if (animationFrame != null) cancelAnimationFrame(animationFrame)
      animationFrame = null
    },
  }
}

export { SIM_DURATION_SECONDS, WALK_SPEED_MPS }
