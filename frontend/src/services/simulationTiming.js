export const DEFAULT_DISPLAY_SECONDS = 120

export function parseDurationToSeconds(text) {
  return parseDurationText(text)
}

function parseDurationText(text) {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return null

  const hourMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)$/)
  if (hourMatch) {
    return parseFloat(hourMatch[1]) * 3600
  }

  const minuteMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)$/)
  if (minuteMatch) {
    return parseFloat(minuteMatch[1]) * 60
  }

  const secondMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)$/)
  if (secondMatch) {
    return parseFloat(secondMatch[1])
  }

  const bareNumber = normalized.match(/^(\d+(?:\.\d+)?)$/)
  if (bareNumber) {
    const minutes = parseFloat(bareNumber[1])
    if (minutes > 0 && minutes <= 24 * 60) {
      return minutes * 60
    }
  }

  return null
}

export function buildSimulationTiming(intervalSeconds, displaySeconds = DEFAULT_DISPLAY_SECONDS) {
  const safeInterval = Math.max(intervalSeconds, 60)
  const safeDisplay = Math.max(displaySeconds, 30)

  return {
    intervalSeconds: safeInterval,
    displaySeconds: safeDisplay,
    compressionRatio: safeInterval / safeDisplay,
    intervalLabel: formatDuration(safeInterval),
    displayLabel: formatDuration(safeDisplay),
  }
}

export function mergeSimulationTiming(current, update) {
  const intervalSeconds = update.intervalSeconds ?? current?.intervalSeconds ?? 3600
  const displaySeconds = update.displaySeconds ?? current?.displaySeconds ?? DEFAULT_DISPLAY_SECONDS
  return buildSimulationTiming(intervalSeconds, displaySeconds)
}

export function parseActivityInterval(text, current = null) {
  const seconds = parseDurationText(text)
  if (!seconds) return null
  return mergeSimulationTiming(current, { intervalSeconds: seconds })
}

export function parsePlaybackDuration(text, current = null) {
  const seconds = parseDurationText(text)
  if (!seconds) return null
  return mergeSimulationTiming(current, { displaySeconds: seconds })
}

export function parseSimulationTimingInput(text, current = null) {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return null

  const combinedMatch = normalized.match(/^(.+?)\s+(?:over|in|within|\/|→)\s+(.+)$/)
  if (combinedMatch) {
    const intervalSeconds = parseDurationText(combinedMatch[1])
    const displaySeconds = parseDurationText(combinedMatch[2])
    if (intervalSeconds && displaySeconds) {
      return buildSimulationTiming(intervalSeconds, displaySeconds)
    }
  }

  const playbackMatch = normalized.match(/^playback\s+(.+)$/)
  if (playbackMatch) {
    const displaySeconds = parseDurationText(playbackMatch[1])
    if (displaySeconds) {
      return mergeSimulationTiming(current, { displaySeconds })
    }
  }

  const activityMatch = normalized.match(/^(?:activity|interval)\s+(.+)$/)
  if (activityMatch) {
    const intervalSeconds = parseDurationText(activityMatch[1])
    if (intervalSeconds) {
      return mergeSimulationTiming(current, { intervalSeconds })
    }
  }

  const durationSeconds = parseDurationText(normalized)
  if (!durationSeconds) return null

  if (
    current?.intervalSeconds &&
    durationSeconds < current.intervalSeconds &&
    durationSeconds <= 30 * 60
  ) {
    return mergeSimulationTiming(current, { displaySeconds: durationSeconds })
  }

  return mergeSimulationTiming(current, { intervalSeconds: durationSeconds })
}

/** @deprecated Use parseActivityInterval or parseSimulationTimingInput */
export function parseSimulationInterval(text) {
  return parseSimulationTimingInput(text)
}

export function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)

  if (hours > 0 && minutes > 0) return `${hours} hr ${minutes} min`
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  if (minutes > 0 && seconds > 0) return `${minutes} min ${seconds} sec`
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return `${seconds} sec`
}

export function formatSimulatedClock(simulatedSeconds, intervalSeconds) {
  const clamped = Math.min(Math.max(simulatedSeconds, 0), intervalSeconds)
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const seconds = Math.floor(clamped % 60)

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function describeSimulationTiming(timing) {
  return `${timing.intervalLabel} of pedestrian activity plays over ${timing.displayLabel} (${timing.compressionRatio.toFixed(0)}× speed).`
}
