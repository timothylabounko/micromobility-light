import { INTERSECTION_MODES } from './intersectionAnalysis.js'
import { parseDurationToSeconds } from './simulationTiming.js'

export const CROSSWALK_SIGNAL_MODES = {
  SIMULTANEOUS: 'simultaneous',
  SEQUENTIAL: 'sequential',
}

/** Simulated-time defaults (not playback clock). */
export const DEFAULT_VEHICLE_WAIT_SIMULTANEOUS = 120
export const DEFAULT_VEHICLE_WAIT_SEQUENTIAL = 60
export const DEFAULT_PED_GO_TIME = 30

export function buildCrosswalkPairs(approaches) {
  const sorted = [...approaches].sort((a, b) => a.bearing - b.bearing)
  const count = sorted.length
  if (count === 0) return []
  if (count === 1) return [[sorted[0].id]]
  if (count === 2) return [[sorted[0].id, sorted[1].id]]

  const pairs = []
  const half = Math.floor(count / 2)

  for (let i = 0; i < half; i += 1) {
    const pair = [sorted[i].id]
    if (i + half < count) {
      pair.push(sorted[i + half].id)
    }
    pairs.push(pair)
  }

  if (count % 2 === 1) {
    pairs[pairs.length - 1].push(sorted[count - 1].id)
  }

  return pairs
}

export function attachCrosswalkPairing(analysis) {
  if (analysis.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY) {
    return analysis
  }

  const pairs = buildCrosswalkPairs(analysis.approaches)
  const approachToPair = new Map()
  pairs.forEach((pair, index) => {
    pair.forEach((approachId) => approachToPair.set(approachId, index))
  })

  return {
    ...analysis,
    crosswalkPairs: pairs,
    approachToPair,
  }
}

export function parseCrosswalkSignalMode(text) {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return null

  if (
    /^(simultaneous|all(\s+at\s+once)?|together|all\s+green|same\s+time|at\s+once|1)$/.test(
      normalized,
    )
  ) {
    return CROSSWALK_SIGNAL_MODES.SIMULTANEOUS
  }

  if (
    /^(sequential|one\s+pair|alternating|phased|staggered|alternate|2)$/.test(normalized)
  ) {
    return CROSSWALK_SIGNAL_MODES.SEQUENTIAL
  }

  return null
}

export function getCrosswalkSignalTiming(mode) {
  if (mode === CROSSWALK_SIGNAL_MODES.SEQUENTIAL) {
    return {
      vehicleWaitSeconds: DEFAULT_VEHICLE_WAIT_SEQUENTIAL,
      pedGoSeconds: DEFAULT_PED_GO_TIME,
    }
  }

  return {
    vehicleWaitSeconds: DEFAULT_VEHICLE_WAIT_SIMULTANEOUS,
    pedGoSeconds: DEFAULT_PED_GO_TIME,
  }
}

export function clampCrosswalkTimingValue(seconds, min = 5, max = 3600) {
  return Math.max(min, Math.min(max, Math.round(seconds)))
}

export function mergeCrosswalkSignalTiming(mode, current, update = {}) {
  const defaults = getCrosswalkSignalTiming(mode)
  return {
    vehicleWaitSeconds: clampCrosswalkTimingValue(
      update.vehicleWaitSeconds ?? current?.vehicleWaitSeconds ?? defaults.vehicleWaitSeconds,
      5,
      3600,
    ),
    pedGoSeconds: clampCrosswalkTimingValue(
      update.pedGoSeconds ?? current?.pedGoSeconds ?? defaults.pedGoSeconds,
      5,
      600,
    ),
  }
}

export function describeCrosswalkSignalTiming(mode, timing) {
  const { vehicleWaitSeconds, pedGoSeconds } =
    timing ?? getCrosswalkSignalTiming(mode)
  const waitLabel = formatSimSeconds(vehicleWaitSeconds)
  const goLabel = formatSimSeconds(pedGoSeconds)

  if (mode === CROSSWALK_SIGNAL_MODES.SEQUENTIAL) {
    return `${waitLabel} vehicle priority + ${goLabel} walk per pair`
  }

  return `${waitLabel} vehicle priority + ${goLabel} walk (all crossings)`
}

export function describeCrosswalkSignalMode(mode, timing) {
  if (mode === CROSSWALK_SIGNAL_MODES.SEQUENTIAL) {
    return `sequential (${describeCrosswalkSignalTiming(mode, timing)})`
  }
  if (mode === CROSSWALK_SIGNAL_MODES.SIMULTANEOUS) {
    return `simultaneous (${describeCrosswalkSignalTiming(mode, timing)})`
  }
  return mode
}

export function formatSimSeconds(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0 && seconds > 0) return `${minutes} min ${seconds} sec`
  if (minutes > 0) return `${minutes} min`
  return `${seconds} sec`
}

export function formatCrosswalkPairs(pairs, countPoints) {
  return pairs
    .map((pair, index) => {
      const labels = pair
        .map((approachId) => countPoints.find((point) => point.id === approachId)?.label)
        .filter(Boolean)
      const compass = pair
        .map((approachId) => countPoints.find((point) => point.id === approachId)?.compass)
        .filter(Boolean)
      const detail =
        labels.length === compass.length
          ? labels.map((label, i) => `${label} (${compass[i]})`).join(' & ')
          : labels.join(' & ')
      return `Pair ${index + 1}: ${detail}`
    })
    .join('; ')
}

const CONTINUE_TIMING_COMMAND = /^(continue|done|defaults|next|skip)$/i

export function parseCrosswalkTimingInput(text, mode, current) {
  const normalized = text.trim().toLowerCase()
  if (!normalized || !mode) return null

  if (CONTINUE_TIMING_COMMAND.test(normalized)) {
    return { action: 'continue' }
  }

  let vehicleWaitSeconds = null
  let pedGoSeconds = null

  const vehiclePatterns = [
    /vehicle(?:s)?\s+(.+?)(?:,|\s+and\s+|\s+walk\b|$)/,
    /(.+?)\s+vehicle(?:s)?(?:\s+wait)?/,
  ]
  const walkPatterns = [
    /walk(?:\s+time)?\s+(.+)$/,
    /ped(?:estrian)?\s+(.+)$/,
    /(.+?)\s+walk\b/,
  ]

  vehiclePatterns.forEach((pattern) => {
    const match = normalized.match(pattern)
    if (match?.[1] && vehicleWaitSeconds == null) {
      vehicleWaitSeconds = parseDurationToSeconds(match[1].trim())
    }
  })

  walkPatterns.forEach((pattern) => {
    const match = normalized.match(pattern)
    if (match?.[1] && pedGoSeconds == null) {
      pedGoSeconds = parseDurationToSeconds(match[1].trim())
    }
  })

  if (vehicleWaitSeconds == null && pedGoSeconds == null) {
    return null
  }

  return {
    action: 'update',
    timing: mergeCrosswalkSignalTiming(mode, current, {
      vehicleWaitSeconds: vehicleWaitSeconds ?? undefined,
      pedGoSeconds: pedGoSeconds ?? undefined,
    }),
  }
}

export function buildCrosswalkSignalConfig(analysis, mode, timing) {
  if (
    !analysis ||
    !mode ||
    analysis.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
  ) {
    return null
  }

  const pairs = analysis.crosswalkPairs ?? buildCrosswalkPairs(analysis.approaches)
  let approachToPair = analysis.approachToPair
  if (!approachToPair || approachToPair.size === 0) {
    approachToPair = new Map()
    pairs.forEach((pair, index) => {
      pair.forEach((approachId) => approachToPair.set(approachId, index))
    })
  }

  const signalTiming = timing ?? getCrosswalkSignalTiming(mode)
  const phaseLength = signalTiming.vehicleWaitSeconds + signalTiming.pedGoSeconds

  return {
    mode,
    pairs,
    approachToPair,
    numPairs: pairs.length,
    timing: signalTiming,
    phaseLength,
    cycleLength:
      mode === CROSSWALK_SIGNAL_MODES.SEQUENTIAL
        ? pairs.length * phaseLength
        : phaseLength,
  }
}

export function getPairIndexForApproach(signalConfig, fromApproachId) {
  if (!signalConfig?.approachToPair) return 0
  return signalConfig.approachToPair.get(fromApproachId) ?? 0
}

function timeInCycle(signalConfig, simulatedSeconds) {
  const cycleLength = signalConfig.cycleLength
  if (!cycleLength) return 0
  const normalized = simulatedSeconds % cycleLength
  return normalized < 0 ? normalized + cycleLength : normalized
}

function getPairGoWindow(signalConfig, pairIndex) {
  const { vehicleWaitSeconds, pedGoSeconds } = signalConfig.timing
  const offset = pairIndex * signalConfig.phaseLength
  return {
    waitStart: offset,
    waitEnd: offset + vehicleWaitSeconds,
    goStart: offset + vehicleWaitSeconds,
    goEnd: offset + vehicleWaitSeconds + pedGoSeconds,
  }
}

export function isCrosswalkPhaseGreen(signalConfig, fromApproachId, simulatedSeconds) {
  if (!signalConfig) return true

  const t = timeInCycle(signalConfig, simulatedSeconds)
  const { vehicleWaitSeconds, pedGoSeconds } = signalConfig.timing

  if (signalConfig.mode === CROSSWALK_SIGNAL_MODES.SIMULTANEOUS) {
    return t >= vehicleWaitSeconds && t < vehicleWaitSeconds + pedGoSeconds
  }

  const pairIndex = getPairIndexForApproach(signalConfig, fromApproachId)
  const window = getPairGoWindow(signalConfig, pairIndex)
  return t >= window.goStart && t < window.goEnd
}

export function classifyCrosswalkWait(signalConfig, fromApproachId, simulatedSeconds) {
  if (!signalConfig) {
    return { canCross: true, reason: null }
  }

  if (isCrosswalkPhaseGreen(signalConfig, fromApproachId, simulatedSeconds)) {
    return { canCross: true, reason: null }
  }

  const t = timeInCycle(signalConfig, simulatedSeconds)

  if (signalConfig.mode === CROSSWALK_SIGNAL_MODES.SIMULTANEOUS) {
    return { canCross: false, reason: 'vehicles' }
  }

  const pairIndex = getPairIndexForApproach(signalConfig, fromApproachId)
  const window = getPairGoWindow(signalConfig, pairIndex)

  if (t >= window.waitStart && t < window.waitEnd) {
    return { canCross: false, reason: 'vehicles' }
  }

  return { canCross: false, reason: 'signal' }
}

export function getActiveCrosswalkPhaseLabel(signalConfig, simulatedSeconds) {
  if (!signalConfig) return null

  const t = timeInCycle(signalConfig, simulatedSeconds)
  const { vehicleWaitSeconds, pedGoSeconds } = signalConfig.timing

  if (signalConfig.mode === CROSSWALK_SIGNAL_MODES.SIMULTANEOUS) {
    if (t >= vehicleWaitSeconds && t < vehicleWaitSeconds + pedGoSeconds) {
      return 'Walk — all crossings'
    }
    return 'Vehicles'
  }

  for (let pairIndex = 0; pairIndex < signalConfig.numPairs; pairIndex += 1) {
    const window = getPairGoWindow(signalConfig, pairIndex)
    if (t >= window.goStart && t < window.goEnd) {
      return `Walk — pair ${pairIndex + 1}`
    }
    if (t >= window.waitStart && t < window.waitEnd) {
      return `Vehicles — pair ${pairIndex + 1}`
    }
  }

  return 'Vehicles'
}
