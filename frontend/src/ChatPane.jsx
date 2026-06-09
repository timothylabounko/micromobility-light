import { useEffect, useRef, useState } from 'react'
import CrosswalkTimingPanel from './CrosswalkTimingPanel.jsx'
import PedestrianCountPanel from './PedestrianCountPanel.jsx'
import {
  INTERSECTION_MODES,
  MIN_COUNT_POINTS,
  parseApproachCounts,
} from './services/intersectionAnalysis.js'
import {
  describeCrosswalkSignalMode,
  describeCrosswalkSignalTiming,
  formatCrosswalkPairs,
  getCrosswalkSignalTiming,
  parseCrosswalkSignalMode,
  parseCrosswalkTimingInput,
} from './services/crosswalkSignal.js'
import {
  describeSimulationTiming,
  formatSimulatedClock,
  parseSimulationTimingInput,
} from './services/simulationTiming.js'

const WELCOME_MESSAGE = {
  id: 'welcome',
  role: 'assistant',
  type: 'text',
  text: 'Welcome to pedestrian intersection counting. First choose your intersection type: type crosswalk for a signalized or marked crosswalk, or pedestrian for a pedestrian-only intersection (plaza, shared street, or ped zone). Then click at least two count points on the map and type commit when you are done placing points.',
}

const RUN_COMMAND = /^run$/i
const START_COMMAND = /^(start|begin|count|intersection|new)$/i
const EDIT_COMMAND = /^(edit|modify|adjust)$/i
const UNDO_COMMAND = /^undo$/i
const COMMIT_COMMAND = /^(commit|done|finish)$/i
const CROSSWALK_COMMAND = /^(crosswalk|1)$/i
const PEDESTRIAN_COMMAND = /^(pedestrian|pedestrian-only|ped|2)$/i

function canRunSimulation(workflowPhase) {
  return (
    workflowPhase === 'entering_counts' ||
    workflowPhase === 'complete' ||
    workflowPhase === 'running'
  )
}

function ChatPane({
  chatEnabled = true,
  workflowPhase,
  pickedPointCount,
  intersectionMode,
  analysis,
  approachCounts,
  movementAssignments,
  onApproachCountChange,
  onStartWorkflow,
  onSelectIntersectionType,
  onSelectCrosswalkSignalMode,
  crosswalkSignalMode,
  crosswalkSignalTiming,
  onCrosswalkTimingChange,
  onContinueCrosswalkTiming,
  onCommitPoints,
  onRunSimulation,
  onEditSimulation,
  onStartNewSimulation,
  onUndoLastPoint,
  simulationInterval,
  simulationClock,
  onSimulationIntervalChange,
  isLoading,
  workflowError,
}) {
  const [messages, setMessages] = useState([WELCOME_MESSAGE])
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)
  const lastPhaseRef = useRef(null)
  const lastPointCountRef = useRef(0)
  const lastErrorRef = useRef(null)
  const lastAnalysisKeyRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  useEffect(() => {
    if (workflowPhase !== 'entering_counts' || !analysis) return

    const analysisKey = `${analysis.countPoints.length}-${analysis.summary.movementCount}-${crosswalkSignalMode ?? 'none'}-${crosswalkSignalTiming?.vehicleWaitSeconds ?? 0}-${crosswalkSignalTiming?.pedGoSeconds ?? 0}`
    if (lastAnalysisKeyRef.current === analysisKey) return
    lastAnalysisKeyRef.current = analysisKey

    setMessages((prev) => [
      ...prev.filter((message) => message.type !== 'counts'),
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        type: 'text',
        text: `Intersection analyzed: ${analysis.summary.modeLabel} — ${analysis.summary.typeLabel} with ${analysis.summary.movementCount} pedestrian turning movements from ${analysis.summary.approachCount} count points. ${
          analysis.summary.usesCrosswalks ? 'Crosswalks detected. ' : ''
        }${
          analysis.summary.usesPedestrianZones ? 'Pedestrian zones detected. ' : ''
        }Enter counts for each point below. Set the activity interval (e.g. 1 hour) and playback duration (e.g. 2 minutes), or type 1 hour over 2 minutes. Type run when ready.${
          crosswalkSignalMode
            ? ` Crosswalk signals: ${describeCrosswalkSignalMode(crosswalkSignalMode, crosswalkSignalTiming)}.`
            : ''
        }`,
      },
      {
        id: 'ped-counts',
        role: 'assistant',
        type: 'counts',
      },
    ])
  }, [workflowPhase, analysis, crosswalkSignalMode, crosswalkSignalTiming])

  useEffect(() => {
    if (workflowPhase === lastPhaseRef.current) return
    lastPhaseRef.current = workflowPhase

    if (workflowPhase === 'choosing_type') {
      lastAnalysisKeyRef.current = null
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'What type of intersection are you counting? Type crosswalk for a marked crosswalk at a vehicular intersection, or pedestrian for a pedestrian-only intersection (plaza, shared street, or ped zone).',
        },
      ])
    }

    if (workflowPhase === 'picking_points') {
      const modeLabel =
        intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
          ? 'pedestrian-only intersection'
          : 'crosswalk intersection'
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: `Place at least ${MIN_COUNT_POINTS} pedestrian count points on the ${modeLabel} map. Use sidewalk approaches, crosswalk corners, or ped-zone edges. Type commit or click Done when finished, or undo to remove the last point.`,
        },
      ])
    }

    if (workflowPhase === 'choosing_crosswalk_signal') {
      const pairSummary = analysis?.crosswalkPairs?.length
        ? ` Crossing pairs: ${formatCrosswalkPairs(analysis.crosswalkPairs, analysis.countPoints)}.`
        : ''
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: `Before entering counts, choose pedestrian signal timing.${pairSummary} Type simultaneous if all crosswalks go green at once (2 min vehicle wait, 30 sec walk per cycle in simulated time), or sequential if one pair goes green then the other (1 min vehicle wait + 30 sec walk per pair).`,
        },
      ])
    }

    if (workflowPhase === 'entering_crosswalk_timing') {
      setMessages((prev) => [
        ...prev.filter((message) => message.type !== 'crosswalk-timing'),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Set vehicle and pedestrian walk intervals for the signal cycle (simulated time, not playback). Defaults are pre-filled — type continue to keep them, or e.g. vehicle 2 minutes, walk 30 seconds.',
        },
        {
          id: 'crosswalk-timing',
          role: 'assistant',
          type: 'crosswalk-timing',
        },
      ])
    }

    if (workflowPhase === 'running') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Running agent-based pedestrian microsimulation. Walkable corridors are shaded on the map; agents keep moving and steer around each other within the bounds.',
        },
      ])
    }

    if (workflowPhase === 'complete') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Simulation complete. Edit counts or timing and run again, or start a new intersection.',
        },
      ])
    }
  }, [workflowPhase, intersectionMode, analysis])

  useEffect(() => {
    if (!workflowError || workflowError === lastErrorRef.current) return
    lastErrorRef.current = workflowError

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        type: 'text',
        text: workflowError,
      },
    ])
  }, [workflowError])

  useEffect(() => {
    if (pickedPointCount === lastPointCountRef.current) return

    const previousCount = lastPointCountRef.current
    lastPointCountRef.current = pickedPointCount

    if (workflowPhase !== 'picking_points') return

    if (pickedPointCount < previousCount) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: `Removed point ${String.fromCharCode(65 + previousCount - 1)}. ${pickedPointCount} point${pickedPointCount === 1 ? '' : 's'} placed.${
            pickedPointCount >= MIN_COUNT_POINTS
              ? ' Type commit or click Done when ready.'
              : ` Place at least ${MIN_COUNT_POINTS - pickedPointCount} more.`
          }`,
        },
      ])
      return
    }

    if (pickedPointCount === 0) return

    const canCommit = pickedPointCount >= MIN_COUNT_POINTS
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        type: 'text',
        text: canCommit
          ? `Point ${pickedPointCount} placed (${String.fromCharCode(64 + pickedPointCount)}). You can add more points, type commit when done, or undo to remove the last point.`
          : `Point ${pickedPointCount} placed. Place at least ${MIN_COUNT_POINTS - pickedPointCount} more point${MIN_COUNT_POINTS - pickedPointCount === 1 ? '' : 's'}.`,
      },
    ])
  }, [pickedPointCount, workflowPhase])

  const handleRun = () => {
    if (!canRunSimulation(workflowPhase)) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Place your count points, commit them, and enter counts before running.',
        },
      ])
      return
    }

    const result = onRunSimulation?.()
    if (!result) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Could not start the simulation. Check that counts are entered and points are on sidewalks.',
        },
      ])
      return
    }

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        type: 'text',
        text: result.message,
      },
    ])
  }

  const handleCommit = () => {
    if (workflowPhase !== 'picking_points') return

    if (pickedPointCount < MIN_COUNT_POINTS) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: `Place at least ${MIN_COUNT_POINTS} points before committing.`,
        },
      ])
      return
    }

    onCommitPoints?.()
  }

  const submitMessage = async () => {
    if (!chatEnabled) return

    const text = input.trim()
    if (!text || isLoading) return

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', type: 'text', text },
    ])
    setInput('')

    if (EDIT_COMMAND.test(text) && workflowPhase === 'complete') {
      onEditSimulation?.()
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Edit mode: adjust counts, activity interval, or playback duration above, then run again.',
        },
      ])
      return
    }

    if (
      START_COMMAND.test(text) &&
      workflowPhase !== 'choosing_type' &&
      workflowPhase !== 'picking_points'
    ) {
      if (workflowPhase === 'complete') {
        onStartNewSimulation?.()
      } else {
        onStartWorkflow()
      }
      return
    }

    if (workflowPhase === 'choosing_crosswalk_signal') {
      const parsedSignal = parseCrosswalkSignalMode(text)
      if (parsedSignal) {
        onSelectCrosswalkSignalMode?.(parsedSignal)
        return
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Please type simultaneous (all crosswalks green at once) or sequential (one pair, then the other).',
        },
      ])
      return
    }

    if (workflowPhase === 'entering_crosswalk_timing') {
      const parsedCrosswalkTiming = parseCrosswalkTimingInput(
        text,
        crosswalkSignalMode,
        crosswalkSignalTiming,
      )
      if (parsedCrosswalkTiming?.action === 'continue') {
        onContinueCrosswalkTiming?.()
        return
      }
      if (parsedCrosswalkTiming?.action === 'update') {
        onCrosswalkTimingChange?.(parsedCrosswalkTiming.timing)
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            type: 'text',
            text: `Signal intervals updated: ${describeCrosswalkSignalTiming(crosswalkSignalMode, parsedCrosswalkTiming.timing)}. Type continue when ready.`,
          },
        ])
        return
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Type continue to use the default intervals, or set custom values like vehicle 2 minutes, walk 30 seconds.',
        },
      ])
      return
    }

    if (workflowPhase === 'choosing_type') {
      if (CROSSWALK_COMMAND.test(text)) {
        onSelectIntersectionType?.(INTERSECTION_MODES.CROSSWALK)
        return
      }
      if (PEDESTRIAN_COMMAND.test(text)) {
        onSelectIntersectionType?.(INTERSECTION_MODES.PEDESTRIAN_ONLY)
        return
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Please type crosswalk or pedestrian to choose the intersection type.',
        },
      ])
      return
    }

    if (RUN_COMMAND.test(text) && canRunSimulation(workflowPhase)) {
      handleRun()
      return
    }

    if (workflowPhase === 'entering_counts' || workflowPhase === 'complete') {
      if (intersectionMode === INTERSECTION_MODES.CROSSWALK) {
        const parsedSignal = parseCrosswalkSignalMode(text)
        if (parsedSignal) {
          onSelectCrosswalkSignalMode?.(parsedSignal, { skipTimingStep: true })
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              type: 'text',
              text: `Crosswalk signals updated to ${describeCrosswalkSignalMode(parsedSignal, getCrosswalkSignalTiming(parsedSignal))}.`,
            },
          ])
          return
        }

        const parsedCrosswalkTiming = parseCrosswalkTimingInput(
          text,
          crosswalkSignalMode,
          crosswalkSignalTiming,
        )
        if (parsedCrosswalkTiming?.action === 'update') {
          onCrosswalkTimingChange?.(parsedCrosswalkTiming.timing)
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              type: 'text',
              text: `Crosswalk signal intervals updated: ${describeCrosswalkSignalTiming(crosswalkSignalMode, parsedCrosswalkTiming.timing)}.`,
            },
          ])
          return
        }
      }

      const parsedTiming = parseSimulationTimingInput(text, simulationInterval)
      if (parsedTiming) {
        onSimulationIntervalChange?.(parsedTiming)
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            type: 'text',
            text: `Timing updated: ${describeSimulationTiming(parsedTiming)} Type run when ready.`,
          },
        ])
        return
      }

      const parsedCounts = parseApproachCounts(
        text,
        analysis?.countPoints?.length ?? MIN_COUNT_POINTS,
      )
      if (parsedCounts) {
        parsedCounts.forEach((count, index) => onApproachCountChange(index, String(count)))
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            type: 'text',
            text: `Counts updated: ${parsedCounts.join(', ')}. Set activity interval and playback duration if needed, then type run.`,
          },
        ])
        return
      }
    }

    if (workflowPhase === 'idle') {
      if (!RUN_COMMAND.test(text)) {
        onStartWorkflow()
      }
      return
    }

    if (UNDO_COMMAND.test(text) && workflowPhase === 'picking_points') {
      if (pickedPointCount === 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            type: 'text',
            text: 'No points to undo yet.',
          },
        ])
        return
      }
      onUndoLastPoint()
      return
    }

    if (COMMIT_COMMAND.test(text) && workflowPhase === 'picking_points') {
      handleCommit()
      return
    }

    if (workflowPhase === 'picking_points') {
      const canCommit = pickedPointCount >= MIN_COUNT_POINTS
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: canCommit
            ? `You have ${pickedPointCount} point${pickedPointCount === 1 ? '' : 's'}. Click more on the map, type commit when done, or undo to remove the last point.`
            : `Place at least ${MIN_COUNT_POINTS} points on the map (${pickedPointCount} so far).`,
        },
      ])
      return
    }

    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        type: 'text',
        text: 'Enter pedestrian counts using the fields above, then type run.',
      },
    ])
  }

  const handleKeyDown = (event) => {
    if (!chatEnabled) return

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitMessage()
    }
  }

  const placeholder =
    workflowPhase === 'choosing_type'
      ? 'Type crosswalk or pedestrian...'
      : workflowPhase === 'choosing_crosswalk_signal'
        ? 'Type simultaneous or sequential...'
        : workflowPhase === 'entering_crosswalk_timing'
          ? 'Vehicle/walk intervals or continue...'
          : workflowPhase === 'entering_counts'
          ? 'Counts, timing (e.g. 1 hour over 2 min), or run...'
          : workflowPhase === 'picking_points'
            ? 'Click points, commit, or undo...'
          : workflowPhase === 'complete'
            ? 'Edit, new, timing, counts, or run...'
            : 'Type start to begin counting...'

  return (
    <aside className="chat-pane">
      <div className="chat-messages">
        {messages.map((message) => {
          if (message.type === 'crosswalk-timing' && crosswalkSignalMode && crosswalkSignalTiming) {
            return (
              <div
                key={message.id}
                className="chat-bubble chat-bubble--assistant chat-bubble--weights"
              >
                <CrosswalkTimingPanel
                  mode={crosswalkSignalMode}
                  timing={crosswalkSignalTiming}
                  onTimingChange={onCrosswalkTimingChange}
                  onContinue={onContinueCrosswalkTiming}
                  isLoading={isLoading}
                />
              </div>
            )
          }

          if (message.type === 'counts' && analysis) {
            return (
              <div
                key={message.id}
                className="chat-bubble chat-bubble--assistant chat-bubble--weights"
              >
                <PedestrianCountPanel
                  approaches={analysis.countPoints}
                  counts={approachCounts}
                  movementAssignments={movementAssignments ?? []}
                  movements={analysis.movements}
                  simulationInterval={simulationInterval}
                  onIntervalChange={onSimulationIntervalChange}
                  onCountChange={onApproachCountChange}
                  onRun={handleRun}
                  isLoading={isLoading || workflowPhase === 'running'}
                  intersectionMode={intersectionMode}
                  crosswalkSignalMode={crosswalkSignalMode}
                  crosswalkSignalTiming={crosswalkSignalTiming}
                  onCrosswalkTimingChange={onCrosswalkTimingChange}
                />
              </div>
            )
          }

          return (
            <div
              key={message.id}
              className={`chat-bubble chat-bubble--${message.role}`}
            >
              {message.text}
            </div>
          )
        })}
        {isLoading && (
          <div className="chat-bubble chat-bubble--assistant">Loading...</div>
        )}
        {workflowPhase === 'complete' && (
          <div className="chat-bubble chat-bubble--assistant chat-complete-actions">
            <p>What would you like to do next?</p>
            <div className="chat-action-buttons">
              <button
                type="button"
                className="chat-action-btn chat-action-btn--primary"
                onClick={() => {
                  onEditSimulation?.()
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: 'assistant',
                      type: 'text',
                      text: 'Edit mode: adjust counts or timing above, then run again.',
                    },
                  ])
                }}
              >
                Edit simulation
              </button>
              <button
                type="button"
                className="chat-action-btn"
                onClick={() => onStartNewSimulation?.()}
              >
                New intersection
              </button>
            </div>
          </div>
        )}
        {workflowPhase === 'running' && simulationClock && (
          <div className="chat-bubble chat-bubble--assistant chat-sim-clock">
            <span className="chat-sim-clock-label">Simulated time</span>
            <strong>
              {formatSimulatedClock(
                simulationClock.simulatedSeconds,
                simulationClock.intervalSeconds,
              )}
            </strong>
            <span className="chat-sim-clock-sep">/</span>
            <span>{simulationClock.intervalLabel}</span>
            <span className="chat-sim-clock-playback">
              Playback {formatSimulatedClock(simulationClock.elapsedDisplaySeconds, simulationClock.displaySeconds)}
              {' / '}
              {simulationClock.displayLabel}
            </span>
            {simulationClock.crosswalkPhaseLabel && (
              <span className="chat-sim-clock-signal">
                Signal: {simulationClock.crosswalkPhaseLabel}
              </span>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form
        className="chat-input-form"
        onSubmit={(event) => {
          event.preventDefault()
          submitMessage()
        }}
      >
        <input
          type="text"
          className="chat-input"
          placeholder={placeholder}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!chatEnabled || isLoading}
        />
        <button
          type="submit"
          className="chat-submit"
          aria-label="Send message"
          disabled={!chatEnabled || isLoading || !input.trim()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h12m0 0-5-5m5 5-5 5" />
          </svg>
        </button>
      </form>
    </aside>
  )
}

export default ChatPane
