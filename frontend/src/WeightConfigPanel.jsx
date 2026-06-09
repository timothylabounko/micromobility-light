import { DEFAULT_WEIGHT_KEYS } from './WeightRunSummary.jsx'
import TimsYearCombobox from './TimsYearCombobox.jsx'

const RECALCULATE_COMMAND = /^calculate new scores$/i

export { DEFAULT_WEIGHT_KEYS }

export function isRecalculateCommand(text) {
  return RECALCULATE_COMMAND.test(text.trim())
}

function WeightConfigPanel({
  weights,
  weightLabels,
  availableAccidentYears,
  accidentYear,
  onWeightChange,
  onYearChange,
}) {
  return (
    <div className="weight-panel">
      <p className="weight-panel-intro">
        Parameter weights used for scoring (higher weight = more influence on the
        final score):
      </p>
      <div className="weight-fields">
        {DEFAULT_WEIGHT_KEYS.map((key) => (
          <label key={key} className="weight-field">
            <span>{weightLabels[key] ?? key}</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={weights[key]}
              onChange={(event) => onWeightChange(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      <label className="weight-field weight-field--year">
        <span>TIMS accident year</span>
        <TimsYearCombobox
          value={accidentYear}
          years={availableAccidentYears}
          onChange={onYearChange}
        />
      </label>
      <p className="weight-panel-hint">
        Edit the values above, then type <strong>calculate new scores</strong> to
        update the map.
      </p>
    </div>
  )
}

export default WeightConfigPanel
