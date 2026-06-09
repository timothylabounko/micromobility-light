import {
  advanceAlongPolyline,
  buildWalkableIndex,
  lateralSideOf,
} from './walkableNetwork.js'
import {
  findPedestrianRoute,
  findIntersectionHub,
} from './pedestrianSim.js'
import { haversineMeters, snapPointToPedestrianNetwork } from './pedestrianOsm.js'
import {
  classifyCrosswalkWait,
  getActiveCrosswalkPhaseLabel,
} from './crosswalkSignal.js'
import { buildSimulationTiming } from './simulationTiming.js'

const MIN_BODY_RADIUS = 0.28
const MAX_LATERAL_SPEED = 1.1
const DISPLAY_SMOOTH_RATE = 8

// Typical adult walking speeds (~4.6–5.4 km/h)
export const PEDESTRIAN_SPEED_MIN = 1.28
export const PEDESTRIAN_SPEED_MAX = 1.48
export const PEDESTRIAN_SPEED_TYPICAL = 1.38
const TURN_COLORS = {
  through: '#10e0f0',
  left: '#f13193',
  right: '#ffc800',
  'u-turn': '#9b59b6',
}

function randomBetween(min, max, seed) {
  const x = Math.sin(seed * 127.1) * 43758.5453
  const frac = x - Math.floor(x)
  return min + frac * (max - min)
}

function resolveSnap(network, snap, fallbackPoint) {
  if (snap?.way?.coordinates?.length >= 2 && snap?.point) return snap
  const point = snap?.point ?? fallbackPoint
  return snapPointToPedestrianNetwork(point, network)
}

function pathLength(path) {
  return path.reduce((total, coord, index) => {
    if (index === 0) return 0
    return total + haversineMeters(path[index - 1], coord)
  }, 0)
}

function metersPerDegree(lat) {
  return {
    lat: 111320,
    lng: 111320 * Math.cos((lat * Math.PI) / 180),
  }
}

function spreadLateralOffset(agentIndex, agentCount, halfWidth, seed) {
  if (agentCount <= 1) {
    return randomBetween(-halfWidth * 0.7, halfWidth * 0.7, seed)
  }

  const lane = agentIndex / (agentCount - 1)
  const base = (lane * 2 - 1) * halfWidth * 0.88
  const jitter = randomBetween(-0.35, 0.35, seed + 11)
  return Math.max(-halfWidth * 0.95, Math.min(halfWidth * 0.95, base + jitter))
}

function buildRouteCacheKey(fromSnap, toSnap) {
  const fromPoint = fromSnap?.point
  const toPoint = toSnap?.point
  const fromWay = fromSnap?.way?.id ?? 'way'
  const toWay = toSnap?.way?.id ?? 'way'
  const fromCoord = fromPoint
    ? `${fromPoint.lat.toFixed(5)},${fromPoint.lng.toFixed(5)}`
    : '0'
  const toCoord = toPoint
    ? `${toPoint.lat.toFixed(5)},${toPoint.lng.toFixed(5)}`
    : '0'
  return `${fromWay}@${fromCoord}->${toWay}@${toCoord}`
}

function getShortestRoute(network, fromSnap, toSnap, hubSnap, routeCache) {
  const key = buildRouteCacheKey(fromSnap, toSnap)
  if (routeCache.has(key)) return routeCache.get(key)

  const from = resolveSnap(network, fromSnap, fromSnap?.point)
  const to = resolveSnap(network, toSnap, toSnap?.point)
  const hub = resolveSnap(network, hubSnap, hubSnap?.point)
  if (!from || !to) return null

  const route = findPedestrianRoute(network, from, to, hub)
  if (route) routeCache.set(key, route)
  return route
}

function buildIndividualPath(
  network,
  fromSnap,
  toSnap,
  hubSnap,
  routeCache,
  seed,
  agentIndex,
  agentCount,
  intersectionMode,
  hub,
) {
  const route = getShortestRoute(network, fromSnap, toSnap, hubSnap, routeCache)
  if (!route?.coordinates?.length) return null

  const totalLen = pathLength(route.coordinates)
  const spawnFraction = agentIndex / Math.max(agentCount, 1)
  const spawnOffset = randomBetween(0, 4, seed + 1) + spawnFraction * totalLen * 0.1
  const startDistance = Math.min(spawnOffset, totalLen * 0.3)

  const halfWidth =
    intersectionMode === 'pedestrian-only'
      ? 4.5
      : hub?.way?.isCrossing
        ? 2.5
        : 1.8
  const preferredLateral = spreadLateralOffset(agentIndex, agentCount, halfWidth, seed + 9)

  return {
    centerPath: route.coordinates,
    pathLength: route.lengthMeters,
    startDistance,
    preferredLateral,
  }
}

function createAgentAttributes(seed, movement, preferredLateral) {
  const speed = randomBetween(PEDESTRIAN_SPEED_MIN, PEDESTRIAN_SPEED_MAX, seed + 2)
  const personalSpace = randomBetween(0.85, 1.25, seed + 4)

  return {
    speed,
    personalSpace,
    preferredLateral,
    turnType: movement.turnType,
    fromLabel: movement.fromLabel,
    toLabel: movement.toLabel,
    color: TURN_COLORS[movement.turnType] ?? '#10e0f0',
  }
}

export function buildAgentPopulation(
  network,
  assignments,
  hubSnap,
  intersectionMode = 'crosswalk',
  simulationTiming = buildSimulationTiming(3600),
  crosswalkSignal = null,
) {
  const hub = resolveSnap(network, hubSnap, hubSnap?.point)
  if (!hub) return { agents: [], walkable: null }

  const walkable = buildWalkableIndex(network)
  const agents = []
  const routeCache = new Map()
  const movementStats = []
  let seed = 1
  let requestedTotal = 0
  let createdTotal = 0
  const { intervalSeconds, compressionRatio } = simulationTiming
  const signalConfig = crosswalkSignal

  assignments.forEach((assignment) => {
    const agentCount = Math.max(0, assignment.count)
    requestedTotal += agentCount
    let movementCreated = 0

    for (let index = 0; index < agentCount; index += 1) {
      const pathData = buildIndividualPath(
        network,
        assignment.fromSnap,
        assignment.toSnap,
        hub,
        routeCache,
        seed,
        index,
        agentCount,
        intersectionMode,
        hub,
      )
      seed += 1

      if (!pathData) continue

      const attributes = createAgentAttributes(seed, assignment.movement, pathData.preferredLateral)
      seed += 1

      const spawnOffsetSimulated =
        agentCount === 1
          ? intervalSeconds * 0.5
          : (index / (agentCount - 1)) * intervalSeconds * 0.96 +
            randomBetween(0, (intervalSeconds * 0.04) / agentCount, seed)
      const spawnTime = spawnOffsetSimulated / compressionRatio
      seed += 1

      const step = advanceAlongPolyline(
        pathData.centerPath,
        0,
        pathData.startDistance,
        walkable,
      )
      const startPos = walkable.positionFromCenter(
        step.centerPoint,
        step.segment,
        pathData.preferredLateral,
      )

      const initialState = {
        centerPath: pathData.centerPath,
        pathLength: pathData.pathLength,
        distanceAlong: pathData.startDistance,
        preferredLateral: pathData.preferredLateral,
        lateralOffset: startPos.lateralOffset,
        position: startPos.point,
        displayPosition: { ...startPos.point },
        spawnTime,
        state: 'waiting',
        arrived: false,
      }

      agents.push({
        id: `agent-${assignment.movementId}-${index}`,
        movementId: assignment.movementId,
        fromApproachId: assignment.movement.fromApproachId,
        attributes,
        initialState,
        ...initialState,
      })
      movementCreated += 1
      createdTotal += 1
    }

    movementStats.push({
      movementId: assignment.movementId,
      label: assignment.movement?.label,
      requested: agentCount,
      created: movementCreated,
    })
  })

  return {
    agents,
    walkable,
    crosswalkSignal: signalConfig,
    stats: {
      requestedTotal,
      createdTotal,
      movementStats,
    },
  }
}

function agentPoint(agent) {
  return agent.position
}

function isAheadOnPath(agent, other, segment) {
  const scale = metersPerDegree(agent.position.lat)
  const fx = (segment.b.lng - segment.a.lng) * scale.lng
  const fy = (segment.b.lat - segment.a.lat) * scale.lat
  const flen = Math.hypot(fx, fy)
  if (flen < 0.01) return false

  const ox = (other.position.lng - agent.position.lng) * scale.lng
  const oy = (other.position.lat - agent.position.lat) * scale.lat
  const dist = Math.hypot(ox, oy)
  if (dist < 0.05) return true

  const dot = (fx * ox + fy * oy) / (flen * dist)
  return dot > 0.45
}

function computeAvoidanceLateral(agent, others, centerPoint, segment, elapsedSeconds) {
  let avoidance = 0
  let weightSum = 0

  others.forEach((other) => {
    if (other.id === agent.id) return
    if (other.state === 'waiting' && elapsedSeconds < other.spawnTime) return
    if (other.arrived) return

    const dist = haversineMeters(agent.position, other.position)
    const minSep = MIN_BODY_RADIUS * 2 + 0.15
    const range = agent.attributes.personalSpace + other.attributes.personalSpace
    if (dist > range * 2) return

    const strength = Math.max(0, 1 - dist / range) ** 1.5
    const otherSide = lateralSideOf(centerPoint, segment, other.position)

    if (dist < minSep) {
      const push = otherSide === 0
        ? (agent.lateralOffset >= 0 ? 1 : -1)
        : -otherSide
      avoidance += push * (1.2 + strength)
      weightSum += 1.2
      return
    }

    if (otherSide === 0) {
      const steer = agent.lateralOffset >= 0 ? 1 : -1
      avoidance += steer * strength * 0.8
    } else {
      avoidance -= otherSide * strength * 1.35
    }

    weightSum += strength
  })

  if (weightSum <= 0) return 0
  return avoidance / Math.sqrt(weightSum)
}

function interactionSpeedFactor(agent, others, segment, elapsedSeconds) {
  let factor = 1

  others.forEach((other) => {
    if (other.id === agent.id) return
    if (other.state === 'waiting' && elapsedSeconds < other.spawnTime) return
    if (other.arrived) return

    const distance = haversineMeters(agent.position, other.position)
    const minSep = MIN_BODY_RADIUS * 2 + 0.1
    const combinedSpace = agent.attributes.personalSpace + other.attributes.personalSpace
    const ahead = isAheadOnPath(agent, other, segment)

    if (distance < minSep) {
      factor = Math.min(factor, ahead ? 0.08 : 0.2)
      return
    }

    if (distance < combinedSpace) {
      if (ahead) {
        const matchFactor = 0.15 + (distance / combinedSpace) * 0.55
        factor = Math.min(factor, matchFactor)
      } else {
        const sideFactor = 0.55 + (distance / combinedSpace) * 0.4
        factor = Math.min(factor, sideFactor)
      }
    } else if (ahead && distance < combinedSpace * 1.4) {
      factor = Math.min(factor, 0.75 + (distance / (combinedSpace * 1.4)) * 0.2)
    }
  })

  return factor
}

function smoothDisplayPosition(agent, target, deltaSeconds, nearOthers) {
  if (!agent.displayPosition) {
    agent.displayPosition = { ...target }
    return
  }

  const rate = nearOthers ? 16 : DISPLAY_SMOOTH_RATE
  const alpha = 1 - Math.exp(-rate * deltaSeconds)
  agent.displayPosition.lat += (target.lat - agent.displayPosition.lat) * alpha
  agent.displayPosition.lng += (target.lng - agent.displayPosition.lng) * alpha
}

function agentNearOthers(agent, agents, elapsedSeconds) {
  return agents.some((other) => {
    if (other.id === agent.id) return false
    if (other.state === 'waiting' && elapsedSeconds < other.spawnTime) return false
    if (other.arrived) return false
    return haversineMeters(agent.position, other.position) < 1.6
  })
}

function resolveOverlaps(agents, walkable, elapsedSeconds, compressionRatio) {
  const active = agents.filter(
    (agent) =>
      agent.state !== 'waiting' &&
      !agent.arrived &&
      elapsedSeconds >= agent.spawnTime,
  )

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]
      const b = active[j]
      const dist = haversineMeters(a.position, b.position)
      const minDist = MIN_BODY_RADIUS * 2 + 0.12

      if (dist >= minDist || dist < 0.01) continue

      const stepA = advanceAlongPolyline(a.centerPath, a.distanceAlong, 0, walkable)
      const push = (minDist - dist) * 0.55 * compressionRatio
      const sideB = lateralSideOf(stepA.centerPoint, stepA.segment, b.position)
      const dir = sideB === 0 ? (a.lateralOffset >= b.lateralOffset ? 1 : -1) : -sideB

      a.lateralOffset = walkable.clampLateral(
        a.lateralOffset + dir * push,
        stepA.segment,
      )
      const placedA = walkable.positionFromCenter(
        stepA.centerPoint,
        stepA.segment,
        a.lateralOffset,
      )
      a.position = placedA.point

      const stepB = advanceAlongPolyline(b.centerPath, b.distanceAlong, 0, walkable)
      const placedB = walkable.positionFromCenter(
        stepB.centerPoint,
        stepB.segment,
        b.lateralOffset - dir * push * 0.5,
      )
      b.position = placedB.point
      b.lateralOffset = placedB.lateralOffset
    }
  }
}

function updateAgent(
  agent,
  agents,
  walkable,
  elapsedSeconds,
  deltaSeconds,
  compressionRatio,
  crosswalkSignal,
  intervalSeconds,
) {
  if (agent.arrived) {
    agent.state = 'arrived'
    smoothDisplayPosition(
      agent,
      agent.position,
      deltaSeconds,
      agentNearOthers(agent, agents, elapsedSeconds),
    )
    return
  }

  if (elapsedSeconds < agent.spawnTime) {
    agent.state = 'waiting'
    return
  }

  const simulatedSeconds = elapsedSeconds * compressionRatio
  const crosswalkWait = classifyCrosswalkWait(
    crosswalkSignal,
    agent.fromApproachId,
    simulatedSeconds,
  )

  if (
    !crosswalkWait.canCross &&
    agent.distanceAlong <= (agent.initialState?.distanceAlong ?? 0) + 0.5
  ) {
    agent.state =
      crosswalkWait.reason === 'vehicles' ? 'waiting_vehicles' : 'waiting_signal'
    smoothDisplayPosition(
      agent,
      agent.position,
      deltaSeconds,
      agentNearOthers(agent, agents, elapsedSeconds),
    )
    return
  }

  const simDelta = deltaSeconds * compressionRatio
  const currentStep = advanceAlongPolyline(
    agent.centerPath,
    agent.distanceAlong,
    0,
    walkable,
  )

  const speedFactor = interactionSpeedFactor(
    agent,
    agents,
    currentStep.segment,
    elapsedSeconds,
  )
  const forwardMeters = agent.attributes.speed * speedFactor * simDelta

  const avoidance = computeAvoidanceLateral(
    agent,
    agents,
    currentStep.centerPoint,
    currentStep.segment,
    elapsedSeconds,
  )
  const targetLateral = walkable.clampLateral(
    agent.preferredLateral + avoidance,
    currentStep.segment,
  )

  const lateralDiff = targetLateral - agent.lateralOffset
  const maxLateralStep = MAX_LATERAL_SPEED * simDelta
  const lateralStep =
    Math.sign(lateralDiff) * Math.min(Math.abs(lateralDiff), maxLateralStep)
  agent.lateralOffset = walkable.clampLateral(
    agent.lateralOffset + lateralStep,
    currentStep.segment,
  )

  const step = advanceAlongPolyline(
    agent.centerPath,
    agent.distanceAlong,
    forwardMeters,
    walkable,
  )

  const placed = walkable.positionFromCenter(
    step.centerPoint,
    step.segment,
    agent.lateralOffset,
  )

  agent.distanceAlong = step.distanceAlong
  agent.position = placed.point
  agent.arrived = step.arrived
  agent.state = speedFactor < 0.25 ? 'yielding' : 'walking'

  const nearOthers = agentNearOthers(agent, agents, elapsedSeconds)
  smoothDisplayPosition(agent, placed.point, deltaSeconds, nearOthers)

  if (agent.arrived) {
    agent.state = 'arrived'
  }
}

export function createAgentSimulation(agentPopulation, simulationTiming, onUpdate) {
  const { agents, walkable, crosswalkSignal } = agentPopulation
  const timing = simulationTiming ?? buildSimulationTiming(3600)
  const { compressionRatio, intervalSeconds } = timing
  let elapsedDisplaySeconds = 0
  let animationFrame = null
  let lastTimestamp = null

  const step = (timestamp) => {
    if (lastTimestamp == null) lastTimestamp = timestamp
    const deltaSeconds = Math.min((timestamp - lastTimestamp) / 1000, 0.05)
    lastTimestamp = timestamp
    elapsedDisplaySeconds += deltaSeconds

    const simulatedSeconds = Math.min(
      elapsedDisplaySeconds * compressionRatio,
      timing.intervalSeconds,
    )

    agents.forEach((agent) => {
      updateAgent(
        agent,
        agents,
        walkable,
        elapsedDisplaySeconds,
        deltaSeconds,
        compressionRatio,
        crosswalkSignal,
        intervalSeconds,
      )
    })

    resolveOverlaps(agents, walkable, elapsedDisplaySeconds, compressionRatio)

    const activeAgents = agents
      .filter((agent) => agent.state !== 'waiting' || elapsedDisplaySeconds >= agent.spawnTime)
      .filter((agent) => !agent.arrived || elapsedDisplaySeconds - agent.spawnTime < 3)
      .map((agent) => ({
        id: agent.id,
        latlng: agent.displayPosition ?? agent.position,
        movementId: agent.movementId,
        turnType: agent.attributes.turnType,
        color:
          agent.state === 'waiting_vehicles'
            ? '#ff9800'
            : agent.state === 'waiting_signal'
              ? '#888'
              : agent.attributes.color,
        state: agent.state,
        speed: agent.attributes.speed * compressionRatio,
        lateral: agent.lateralOffset,
        fromLabel: agent.attributes.fromLabel,
        toLabel: agent.attributes.toLabel,
      }))

    onUpdate({
      elapsedDisplaySeconds,
      simulatedSeconds,
      intervalSeconds: timing.intervalSeconds,
      displaySeconds: timing.displaySeconds,
      intervalLabel: timing.intervalLabel,
      displayLabel: timing.displayLabel,
      compressionRatio,
      crosswalkPhaseLabel: crosswalkSignal
        ? getActiveCrosswalkPhaseLabel(crosswalkSignal, simulatedSeconds)
        : null,
      agentPositions: activeAgents,
    })

    if (elapsedDisplaySeconds < timing.displaySeconds) {
      animationFrame = requestAnimationFrame(step)
    }
  }

  return {
    start() {
      elapsedDisplaySeconds = 0
      lastTimestamp = null
      agents.forEach((agent) => {
        Object.assign(agent, agent.initialState)
      })
      animationFrame = requestAnimationFrame(step)
    },
    stop() {
      if (animationFrame != null) cancelAnimationFrame(animationFrame)
      animationFrame = null
    },
    getAgents: () => agents,
    getTiming: () => timing,
  }
}

export { findIntersectionHub }
