import CrosswalkTimingFields from './CrosswalkTimingFields.jsx'
import {
  CROSSWALK_SIGNAL_MODES,
  describeCrosswalkSignalMode,
  describeCrosswalkSignalTiming,
} from './services/crosswalkSignal.js'

function CrosswalkTimingPanel({
  mode,
  timing,
  onTimingChange,
  onContinue,
  isLoading,
}) {
  const vehicleLabel =
    mode === CROSSWALK_SIGNAL_MODES.SEQUENTIAL
      ? 'Vehicle priority (per pair)'
      : 'Vehicle priority'

  return (
    <div className="crosswalk-timing-panel">
      <p className="ped-count-panel-intro">
        Signal type: <strong>{describeCrosswalkSignalMode(mode, timing)}</strong>.
        Adjust vehicle and walk intervals below, or continue with the defaults.
      </p>
      <CrosswalkTimingFields
        mode={mode}
        timing={timing}
        onTimingChange={onTimingChange}
        vehicleLabel={vehicleLabel}
      />
      <p className="ped-interval-note">
        Cycle in simulated time: {describeCrosswalkSignalTiming(mode, timing)}
      </p>
      <button
        type="button"
        className="ped-run-btn"
        onClick={onContinue}
        disabled={isLoading}
      >
        Continue with these timings
      </button>
    </div>
  )
}

export default CrosswalkTimingPanel
