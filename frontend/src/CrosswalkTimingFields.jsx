import {
  formatSimSeconds,
  mergeCrosswalkSignalTiming,
} from './services/crosswalkSignal.js'
import { parseDurationToSeconds } from './services/simulationTiming.js'

function CrosswalkTimingFields({
  mode,
  timing,
  onTimingChange,
  vehicleLabel = 'Vehicle priority',
}) {
  const handleVehicleInput = (value) => {
    const seconds = parseDurationToSeconds(value)
    if (!seconds) return
    onTimingChange(
      mergeCrosswalkSignalTiming(mode, timing, { vehicleWaitSeconds: seconds }),
    )
  }

  const handleWalkInput = (value) => {
    const seconds = parseDurationToSeconds(value)
    if (!seconds) return
    onTimingChange(mergeCrosswalkSignalTiming(mode, timing, { pedGoSeconds: seconds }))
  }

  if (!mode || !timing) return null

  return (
    <div className="crosswalk-timing-fields">
      <p className="crosswalk-timing-note">
        Simulated signal times (not playback clock). Defaults are pre-filled — edit
        only if needed.
      </p>
      <label className="ped-count-field ped-interval-field">
        <span>{vehicleLabel}</span>
        <input
          type="text"
          placeholder="e.g. 2 minutes"
          key={`vehicle-${timing.vehicleWaitSeconds}`}
          defaultValue={formatSimSeconds(timing.vehicleWaitSeconds)}
          onBlur={(event) => handleVehicleInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleVehicleInput(event.target.value)
          }}
        />
      </label>
      <label className="ped-count-field ped-interval-field">
        <span>Pedestrian walk</span>
        <input
          type="text"
          placeholder="e.g. 30 seconds"
          key={`walk-${timing.pedGoSeconds}`}
          defaultValue={formatSimSeconds(timing.pedGoSeconds)}
          onBlur={(event) => handleWalkInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleWalkInput(event.target.value)
          }}
        />
      </label>
    </div>
  )
}

export default CrosswalkTimingFields
