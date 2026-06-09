function PedestrianCountPanel({ approaches, counts, onCountChange, movements, onRun, isLoading }) {
  const total = counts.reduce((sum, count) => sum + count, 0)

  return (
    <div className="ped-count-panel">
      <p className="ped-count-panel-intro">
        Enter pedestrian counts for each approach point (pedestrians per hour), then
        click <strong>Run simulation</strong> or type <strong>run</strong> in the chat.
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
      <button
        type="button"
        className="ped-run-btn"
        onClick={onRun}
        disabled={isLoading || total <= 0}
        title={total <= 0 ? 'Enter counts above first' : 'Start pedestrian microsimulation'}
      >
        Run simulation
      </button>
      <div className="ped-movements-list">
        <p className="ped-movements-title">Pedestrian turning movements:</p>
        <ul>
          {movements.map((movement) => (
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
