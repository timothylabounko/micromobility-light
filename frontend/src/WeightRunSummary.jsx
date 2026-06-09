export const DEFAULT_WEIGHT_KEYS = [
  'speed',
  'length',
  'road_type',
  'lanes',
  'accidents',
  'bike_lanes',
]

export function formatAccidentYearLabel(accidentYear) {
  if (accidentYear == null || accidentYear === '') {
    return 'All years'
  }
  return String(accidentYear)
}

export function WeightRunSummary({ weights, weightLabels, accidentYear }) {
  return (
    <div className="weight-run-summary">
      <p className="weight-run-summary-title">Weights used for this run:</p>
      <ul className="weight-run-summary-list">
        {DEFAULT_WEIGHT_KEYS.map((key) => (
          <li key={key}>
            <span>{weightLabels[key] ?? key}</span>
            <span>{Number(weights[key]).toFixed(2)}</span>
          </li>
        ))}
        <li>
          <span>TIMS accident year</span>
          <span>{formatAccidentYearLabel(accidentYear)}</span>
        </li>
      </ul>
    </div>
  )
}
