import { useEffect, useRef, useState } from 'react'
import PedestrianCountPanel from './PedestrianCountPanel.jsx'
import { parseApproachCounts } from './services/intersectionAnalysis.js'

const WELCOME_MESSAGE = {
  id: 'welcome',
  role: 'assistant',
  type: 'text',
  text: 'Welcome to pedestrian intersection counting. Click four pedestrian count points on the map — one at each corner or approach of the intersection. Points must be on crosswalks, sidewalks, or dedicated pedestrian zones from OpenStreetMap. After placing all four points, enter pedestrian counts for each approach and type run to start the microsimulation.',
}

const RUN_COMMAND = /^run$/i
const START_COMMAND = /^(start|begin|count|intersection)$/i
const UNDO_COMMAND = /^undo$/i

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
  analysis,
  approachCounts,
  onApproachCountChange,
  onStartWorkflow,
  onRunSimulation,
  onUndoLastPoint,
  isLoading,
  workflowError,
}) {
  const [messages, setMessages] = useState([WELCOME_MESSAGE])
  const [input, setInput] = useState('')
  const messagesEndRef = useRef(null)
  const lastPhaseRef = useRef(null)
  const lastPointCountRef = useRef(0)
  const lastErrorRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  useEffect(() => {
    if (workflowPhase === lastPhaseRef.current) return
    lastPhaseRef.current = workflowPhase

    if (workflowPhase === 'picking_points') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: 'Click four pedestrian count points on the intersection map. Use sidewalk approaches and crosswalk corners. I will detect the intersection type and pedestrian turning movements from OpenStreetMap.',
        },
      ])
    }

    if (workflowPhase === 'entering_counts' && analysis) {
      setMessages((prev) => [
        ...prev.filter((message) => message.type !== 'counts'),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: `Intersection analyzed: ${analysis.summary.typeLabel} with ${analysis.summary.movementCount} pedestrian turning movements. ${
            analysis.summary.usesCrosswalks ? 'Crosswalks detected. ' : ''
          }${
            analysis.summary.usesPedestrianZones ? 'Pedestrian zones detected. ' : ''
          }Enter counts for each point below, or type four numbers separated by spaces (e.g. 12 8 15 10), then type run.`,
        },
        {
          id: 'ped-counts',
          role: 'assistant',
          type: 'counts',
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
          text: 'Running agent-based pedestrian microsimulation. Walkable corridors are shaded on the map; each agent takes its own lane, stays inside the bounds, and steers around others.',
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
          text: 'Simulation complete. Type start to count another intersection.',
        },
      ])
    }
  }, [workflowPhase, analysis])

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
          text: `Removed point ${String.fromCharCode(65 + previousCount - 1)}. Click ${4 - pickedPointCount} more pedestrian count point${4 - pickedPointCount === 1 ? '' : 's'}.`,
        },
      ])
      return
    }

    if (pickedPointCount === 0) return

    const remaining = 4 - pickedPointCount
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        type: 'text',
        text:
          remaining === 0
            ? 'All four points placed. Loading pedestrian network from OpenStreetMap...'
            : `Point ${pickedPointCount} placed. Click ${remaining} more pedestrian count point${remaining === 1 ? '' : 's'}.`,
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
          text: 'Place all four points and wait for analysis to finish before running.',
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

  const submitMessage = async () => {
    if (!chatEnabled) return

    const text = input.trim()
    if (!text || isLoading) return

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', type: 'text', text },
    ])
    setInput('')

    if (START_COMMAND.test(text) && workflowPhase !== 'picking_points') {
      onStartWorkflow()
      return
    }

    if (RUN_COMMAND.test(text) && canRunSimulation(workflowPhase)) {
      handleRun()
      return
    }

    if (workflowPhase === 'entering_counts' || workflowPhase === 'complete') {
      const parsedCounts = parseApproachCounts(text, analysis?.countPoints?.length ?? 4)
      if (parsedCounts) {
        parsedCounts.forEach((count, index) => onApproachCountChange(index, String(count)))
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            type: 'text',
            text: `Counts updated: ${parsedCounts.join(', ')}. Click Run simulation or type run.`,
          },
        ])
        return
      }
    }

    if (workflowPhase === 'idle' || workflowPhase === 'complete') {
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

    if (workflowPhase === 'picking_points') {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          type: 'text',
          text: `Please click ${4 - pickedPointCount} more point${4 - pickedPointCount === 1 ? '' : 's'} on the map, or type undo to remove the last point.`,
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
        text: 'Enter four pedestrian counts (e.g. 10 20 15 25) or use the fields above, then type run.',
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
    workflowPhase === 'entering_counts'
      ? 'Enter counts or type run...'
      : workflowPhase === 'picking_points'
        ? 'Click points or type undo...'
        : 'Type start to begin counting...'

  return (
    <aside className="chat-pane">
      <div className="chat-messages">
        {messages.map((message) => {
          if (message.type === 'counts' && analysis) {
            return (
              <div
                key={message.id}
                className="chat-bubble chat-bubble--assistant chat-bubble--weights"
              >
                <PedestrianCountPanel
                  approaches={analysis.countPoints}
                  counts={approachCounts}
                  movements={analysis.movements}
                  onCountChange={onApproachCountChange}
                  onRun={handleRun}
                  isLoading={isLoading || workflowPhase === 'running'}
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
