import {
  parseActivityInterval,
  parsePlaybackDuration,
} from './services/simulationTiming.js'
import {
  summarizePointFlows,
  totalApproachCount,
} from './services/intersectionAnalysis.js'

import CrosswalkTimingFields from './CrosswalkTimingFields.jsx'
import {
  CROSSWALK_SIGNAL_MODES,
  describeCrosswalkSignalMode,
  describeCrosswalkSignalTiming,
} from './services/crosswalkSignal.js'
import { INTERSECTION_MODES } from './services/intersectionAnalysis.js'

function PedestrianCountPanel({
  approaches,
  counts,
  movementAssignments,
  onCountChange,
  movements,
  simulationInterval,
  onIntervalChange,
  onRun,
  isLoading,
  intersectionMode,
  crosswalkSignalMode,
  crosswalkSignalTiming,
  onCrosswalkTimingChange,
}) {
  const crosswalkVehicleLabel =
    crosswalkSignalMode === CROSSWALK_SIGNAL_MODES.SEQUENTIAL
      ? 'Vehicle priority (per pair)'
      : 'Vehicle priority'
  const total = totalApproachCount(counts)
  const simulatingTotal = movementAssignments.reduce(
    (sum, assignment) => sum + assignment.count,
    0,
  )
  const pointFlows =
    approaches.length > 0 && movementAssignments.length > 0
      ? summarizePointFlows(movementAssignments, { countPoints: approaches })
      : []

  const handleActivityInput = (value) => {
    const parsed = parseActivityInterval(value, simulationInterval)
    if (parsed) onIntervalChange(parsed)
  }

  const handlePlaybackInput = (value) => {
    const parsed = parsePlaybackDuration(value, simulationInterval)
    if (parsed) onIntervalChange(parsed)
  }

  return (
    <div className="ped-count-panel">
      <p className="ped-count-panel-intro">
        Enter how many pedestrians <strong>leave</strong> each point during the interval,
        then set the interval (e.g. <strong>1 hour</strong>). Traffic <strong>arriving</strong>{' '}
        at a point comes from the other points&apos; counts (split evenly across their
        outgoing routes).
      </p>
      <div className="ped-count-fields">
        {approaches.map((approach, index) => (
          <label key={approach.id} className="ped-count-field">
            <span>
              Point {approach.label} ({approach.compass})
            </span>
            <input
              type="number"
              min="0"
              step="1"
              value={counts[index] ?? 0}
              onChange={(event) => onCountChange(index, event.target.value)}
            />
          </label>
        ))}
      </div>
      {total > 0 && (
        <p className="ped-count-total">
          Total: <strong>{total}</strong> pedestrian{total === 1 ? '' : 's'} over{' '}
          {simulationInterval?.intervalLabel ?? 'the interval'}
          {simulatingTotal === total
            ? ` (${simulatingTotal} will be simulated)`
            : ` (${simulatingTotal} across movements)`}
        </p>
      )}
      {pointFlows.length > 0 && (
        <ul className="ped-flow-summary">
          {pointFlows.map((flow) => (
            <li key={flow.approachId}>
              Point {flow.label} ({flow.compass}):{' '}
              <strong>{flow.departing}</strong> leaving,{' '}
              <strong>{flow.arriving}</strong> arriving
            </li>
          ))}
        </ul>
      )}
      <div className="ped-timing-fields">
        <label className="ped-count-field ped-interval-field">
          <span>Activity interval</span>
          <input
            type="text"
            placeholder="e.g. 1 hour"
            key={`activity-${simulationInterval?.intervalSeconds ?? 'empty'}`}
            defaultValue={simulationInterval?.intervalLabel ?? ''}
            onBlur={(event) => handleActivityInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleActivityInput(event.target.value)
            }}
          />
        </label>
        <label className="ped-count-field ped-interval-field">
          <span>Playback duration</span>
          <input
            type="text"
            placeholder="e.g. 2 minutes"
            key={`playback-${simulationInterval?.displaySeconds ?? 'empty'}`}
            defaultValue={simulationInterval?.displayLabel ?? ''}
            onBlur={(event) => handlePlaybackInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handlePlaybackInput(event.target.value)
            }}
          />
        </label>
      </div>
      {simulationInterval && (
        <p className="ped-interval-note">
          {simulationInterval.intervalLabel} of activity → {simulationInterval.displayLabel}{' '}
          playback ({simulationInterval.compressionRatio.toFixed(0)}× speed)
        </p>
      )}
      {intersectionMode === INTERSECTION_MODES.CROSSWALK &&
        crosswalkSignalMode &&
        crosswalkSignalTiming &&
        onCrosswalkTimingChange && (
          <div className="crosswalk-timing-section">
            <p className="ped-movements-title">Crosswalk signal intervals</p>
            <CrosswalkTimingFields
              mode={crosswalkSignalMode}
              timing={crosswalkSignalTiming}
              onTimingChange={onCrosswalkTimingChange}
              vehicleLabel={crosswalkVehicleLabel}
            />
            <p className="ped-interval-note">
              {describeCrosswalkSignalMode(crosswalkSignalMode, crosswalkSignalTiming)}
            </p>
          </div>
        )}
      <button
        type="button"
        className="ped-run-btn"
        onClick={onRun}
        disabled={isLoading || total <= 0 || !simulationInterval}
        title={
          !simulationInterval
            ? 'Set the count interval first'
            : total <= 0
              ? 'Enter counts above first'
              : 'Start pedestrian microsimulation'
        }
      >
        Run simulation
      </button>
      <div className="ped-movements-list">
        <p className="ped-movements-title">Pedestrian turning movements (agents per route):</p>
        <ul>
          {movementAssignments.length > 0
            ? movementAssignments.map((assignment) => (
                <li key={assignment.movementId}>
                  <span>{assignment.movement.label}</span>
                  <strong className="ped-movement-count">{assignment.count}</strong>
                </li>
              ))
            : movements.map((movement) => (
                <li key={movement.id}>
                  <span>{movement.label}</span>
                </li>
              ))}
        </ul>
      </div>
    </div>
  )
}

export default PedestrianCountPanel
