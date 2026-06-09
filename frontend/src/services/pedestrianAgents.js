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

const SIM_DURATION_SECONDS = 45
const MAX_AGENTS_PER_MOVEMENT = 15
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

function spreadLateralOffset(agentIndex, agentCount, halfWidth, seed) {
  if (agentCount <= 1) {
    return randomBetween(-halfWidth * 0.7, halfWidth * 0.7, seed)
  }

  const lane = agentIndex / (agentCount - 1)
  const base = (lane * 2 - 1) * halfWidth * 0.82
  const jitter = randomBetween(-0.35, 0.35, seed + 11)
  return Math.max(-halfWidth * 0.92, Math.min(halfWidth * 0.92, base + jitter))
}

function buildIndividualPath(network, fromSnap, toSnap, hubSnap, seed, agentIndex, agentCount) {
  const from = resolveSnap(network, fromSnap, fromSnap?.point)
  const to = resolveSnap(network, toSnap, toSnap?.point)
  const hub = resolveSnap(network, hubSnap, hubSnap?.point)
  if (!from || !to || !hub) return null

  const routeSeed = seed * 31 + agentIndex * 997
  const fromOffsetMeters = randomBetween(0, 12, routeSeed + 6)
  const toOffsetMeters = randomBetween(0, 10, routeSeed + 7)
  const hubLateralOffset = randomBetween(-2.2, 2.2, routeSeed + 8)

  const route = findPedestrianRoute(network, from, to, hub, {
    seed: routeSeed,
    fromOffsetMeters,
    toOffsetMeters,
    hubLateralOffset,
  })
  if (!route?.coordinates?.length) return null

  const spawnOffset = randomBetween(0, 5, routeSeed + 1)
  const startDistance = Math.min(spawnOffset, pathLength(route.coordinates) * 0.2)

  const halfWidth = hub.way?.isCrossing ? 2.5 : 1.8
  const preferredLateral = spreadLateralOffset(agentIndex, agentCount, halfWidth, routeSeed + 9)

  return {
    centerPath: route.coordinates,
    pathLength: route.lengthMeters,
    startDistance,
    preferredLateral,
    routeSeed,
  }
}

function createAgentAttributes(seed, movement, preferredLateral) {
  const speed = randomBetween(1.0, 1.7, seed + 2)
  const patience = randomBetween(0.4, 1.0, seed + 3)
  const personalSpace = randomBetween(0.8, 1.4, seed + 4)
  const reactionTime = randomBetween(0.2, 0.8, seed + 5)

  return {
    speed,
    patience,
    personalSpace,
    reactionTime,
    preferredLateral,
    turnType: movement.turnType,
    fromLabel: movement.fromLabel,
    toLabel: movement.toLabel,
    color: TURN_COLORS[movement.turnType] ?? '#10e0f0',
  }
}

export function buildAgentPopulation(network, assignments, hubSnap) {
  const hub = resolveSnap(network, hubSnap, hubSnap?.point)
  if (!hub) return { agents: [], walkable: null }

  const walkable = buildWalkableIndex(network)
  const agents = []
  let seed = 1

  assignments.forEach((assignment) => {
    const agentCount = Math.min(assignment.count, MAX_AGENTS_PER_MOVEMENT)

    for (let index = 0; index < agentCount; index += 1) {
      const pathData = buildIndividualPath(
        network,
        assignment.fromSnap,
        assignment.toSnap,
        hub,
        seed,
        index,
        agentCount,
      )
      seed += 1

      if (!pathData) continue

      const attributes = createAgentAttributes(seed, assignment.movement, pathData.preferredLateral)
      seed += 1

      const spawnOffsetSeconds = randomBetween(0, SIM_DURATION_SECONDS * 0.85, seed)
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
        spawnTime: spawnOffsetSeconds,
        state: 'waiting',
        waitTimer: 0,
        arrived: false,
      }

      agents.push({
        id: `agent-${assignment.movementId}-${index}`,
        movementId: assignment.movementId,
        attributes,
        initialState,
        ...initialState,
      })
    }
  })

  return { agents, walkable }
}

function computeAvoidanceLateral(agent, others, step, elapsedSeconds) {
  let avoidance = 0
  const { centerPoint, segment } = step

  others.forEach((other) => {
    if (other.id === agent.id) return
    if (other.state === 'waiting' && elapsedSeconds < other.spawnTime) return
    if (other.arrived) return

    const dist = haversineMeters(agent.position, other.position)
    const range = agent.attributes.personalSpace + other.attributes.personalSpace + 0.4
    if (dist > range * 1.8) return

    const strength = Math.max(0, 1 - dist / range) ** 1.4
    const otherSide = lateralSideOf(centerPoint, segment, other.position)

    if (otherSide === 0) {
      const steer = agent.preferredLateral >= 0 ? 1 : -1
      avoidance += steer * strength * 1.1
      return
    }

    avoidance -= otherSide * strength * 2.2

    if (dist < 1.0 && Math.abs(other.lateralOffset - agent.lateralOffset) < 0.5) {
      avoidance += agent.preferredLateral >= 0 ? strength * 1.5 : -strength * 1.5
    }
  })

  return avoidance
}

function interactionSpeedFactor(agent, others, elapsedSeconds) {
  let factor = 1

  others.forEach((other) => {
    if (other.id === agent.id) return
    if (other.state === 'waiting' && elapsedSeconds < other.spawnTime) return
    if (other.arrived) return

    const distance = haversineMeters(agent.position, other.position)
    const combinedSpace = agent.attributes.personalSpace + other.attributes.personalSpace

    if (distance < 0.35) {
      factor = Math.min(factor, 0.1)
      return
    }

    if (distance < combinedSpace) {
      const slowFactor = 0.2 + (distance / combinedSpace) * 0.6
      factor = Math.min(factor, slowFactor * agent.attributes.patience)
    }
  })

  return factor
}

function updateAgent(agent, agents, walkable, elapsedSeconds, deltaSeconds) {
  if (agent.arrived) {
    agent.state = 'arrived'
    return
  }

  if (elapsedSeconds < agent.spawnTime) {
    agent.state = 'waiting'
    return
  }

  const speedFactor = interactionSpeedFactor(agent, agents, elapsedSeconds)
  const moveMeters = agent.attributes.speed * Math.max(speedFactor, 0.12) * deltaSeconds
  const step = advanceAlongPolyline(
    agent.centerPath,
    agent.distanceAlong,
    moveMeters,
    walkable,
  )

  const avoidance = computeAvoidanceLateral(agent, agents, step, elapsedSeconds)
  const avoidanceBoost = speedFactor < 0.4 ? 1.6 : 1
  const targetLateral = walkable.clampLateral(
    agent.preferredLateral + avoidance * avoidanceBoost,
    step.segment,
  )

  const lateralSmoothing = Math.min(1, 8 * deltaSeconds)
  agent.lateralOffset += (targetLateral - agent.lateralOffset) * lateralSmoothing

  const placed = walkable.positionFromCenter(
    step.centerPoint,
    step.segment,
    agent.lateralOffset,
  )

  agent.distanceAlong = step.distanceAlong
  agent.position = placed.point
  agent.lateralOffset = placed.lateralOffset
  agent.arrived = step.arrived
  agent.state = speedFactor < 0.25 ? 'yielding' : 'walking'

  if (agent.arrived) {
    agent.state = 'arrived'
  }
}

export function createAgentSimulation(agentPopulation, onUpdate) {
  const { agents, walkable } = agentPopulation
  let elapsedSeconds = 0
  let animationFrame = null
  let lastTimestamp = null
  const timeScale = 2.5

  const step = (timestamp) => {
    if (lastTimestamp == null) lastTimestamp = timestamp
    const deltaSeconds = ((timestamp - lastTimestamp) / 1000) * timeScale
    lastTimestamp = timestamp
    elapsedSeconds += deltaSeconds

    agents.forEach((agent) => {
      updateAgent(agent, agents, walkable, elapsedSeconds, deltaSeconds)
    })

    const activeAgents = agents
      .filter((agent) => agent.state !== 'waiting' || elapsedSeconds >= agent.spawnTime)
      .filter((agent) => !agent.arrived || elapsedSeconds - agent.spawnTime < 3)
      .map((agent) => ({
        id: agent.id,
        latlng: agent.position,
        movementId: agent.movementId,
        turnType: agent.attributes.turnType,
        color: agent.attributes.color,
        state: agent.state,
        speed: agent.attributes.speed,
        lateral: agent.lateralOffset,
        fromLabel: agent.attributes.fromLabel,
        toLabel: agent.attributes.toLabel,
      }))

    onUpdate({ elapsedSeconds, agentPositions: activeAgents })

    const stillActive = agents.some((agent) => !agent.arrived)
    const withinHorizon = elapsedSeconds < SIM_DURATION_SECONDS + 30

    if (stillActive || withinHorizon) {
      animationFrame = requestAnimationFrame(step)
    }
  }

  return {
    start() {
      elapsedSeconds = 0
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
  }
}

export { findIntersectionHub, SIM_DURATION_SECONDS }
