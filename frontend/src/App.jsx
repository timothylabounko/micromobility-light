import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import ChatPane from './ChatPane.jsx'
import {
  analyzeIntersection,
  applyWalkAreaEdit,
  attachIntersectionHub,
  distributeCountsToMovements,
  INTERSECTION_MODES,
  MIN_COUNT_POINTS,
  totalApproachCount,
} from './services/intersectionAnalysis.js'
import { createWalkAreaEditor } from './services/walkAreaEditor.js'
import { fetchPedestrianNetwork } from './services/pedestrianOsm.js'
import {
  buildAgentPopulation,
  createAgentSimulation,
  findIntersectionHub,
} from './services/pedestrianAgents.js'
import { buildCorridorPolygons } from './services/walkableNetwork.js'
import { NETWORK_MODES } from './services/pedestrianOsm.js'
import {
  buildCrosswalkSignalConfig,
  attachCrosswalkPairing,
  describeCrosswalkSignalMode,
  getCrosswalkSignalTiming,
} from './services/crosswalkSignal.js'
import { describeSimulationTiming } from './services/simulationTiming.js'
import './App.css'

const MAP_CENTER = [36.7783, -119.4179]
const MAP_ZOOM = 6

const TURN_COLORS = {
  through: '#10e0f0',
  left: '#f13193',
  right: '#ffc800',
  'u-turn': '#9b59b6',
}

function App() {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const pedestrianLayerRef = useRef(null)
  const pointLayerRef = useRef(null)
  const agentLayerRef = useRef(null)
  const routeLayerRef = useRef(null)
  const simControllerRef = useRef(null)
  const walkAreaEditorRef = useRef(null)
  const simCompleteRef = useRef(false)
  const lastClockUpdateRef = useRef(0)

  const [workflowPhase, setWorkflowPhase] = useState('choosing_type')
  const [intersectionMode, setIntersectionMode] = useState(null)
  const [pickedPoints, setPickedPoints] = useState([])
  const [pedestrianNetwork, setPedestrianNetwork] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [approachCounts, setApproachCounts] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState(null)
  const [simulationInterval, setSimulationInterval] = useState(null)
  const [simulationClock, setSimulationClock] = useState(null)
  const [crosswalkSignalMode, setCrosswalkSignalMode] = useState(null)
  const [crosswalkSignalTiming, setCrosswalkSignalTiming] = useState(null)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const map = L.map(mapRef.current).setView(MAP_CENTER, MAP_ZOOM)

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map)

    mapInstanceRef.current = map
    pointLayerRef.current = L.layerGroup().addTo(map)
    agentLayerRef.current = L.layerGroup().addTo(map)
    routeLayerRef.current = L.layerGroup().addTo(map)

    const resizeTimer = window.setTimeout(() => map.invalidateSize(), 100)

    return () => {
      window.clearTimeout(resizeTimer)
      simControllerRef.current?.stop()
      map.remove()
      mapInstanceRef.current = null
      pedestrianLayerRef.current = null
      pointLayerRef.current = null
      agentLayerRef.current = null
      routeLayerRef.current = null
    }
  }, [])

  const clearAgentLayer = useCallback(() => {
    agentLayerRef.current?.clearLayers()
  }, [])

  const renderPedestrianNetwork = useCallback((geojson) => {
    const map = mapInstanceRef.current
    if (!map) return

    if (pedestrianLayerRef.current) {
      map.removeLayer(pedestrianLayerRef.current)
    }

    pedestrianLayerRef.current = L.geoJSON(geojson, {
      renderer: L.canvas({ padding: 0.5 }),
      style: (feature) => ({
        color: feature.properties.isCrossing
          ? '#10e0f0'
          : feature.properties.isRoadSurface
            ? '#8b7355'
            : '#5a8f7b',
        weight: feature.properties.isCrossing ? 3 : feature.properties.isRoadSurface ? 3 : 2,
        opacity: feature.properties.isPedestrianZone ? 0.95 : 0.75,
        dashArray:
          feature.properties.isCrossing || feature.properties.isRoadSurface ? null : '4 6',
      }),
    }).addTo(map)
  }, [])

  const isWalkAreaEditorPhase =
    analysis?.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY &&
    analysis?.walkArea?.coordinates?.length >= 3 &&
    (workflowPhase === 'editing_walk_area' ||
      workflowPhase === 'entering_counts' ||
      workflowPhase === 'complete')

  const handleWalkAreaChange = useCallback((walkArea) => {
    setAnalysis((prev) => (prev ? applyWalkAreaEdit(prev, walkArea) : prev))
  }, [])

  const renderCountPoints = useCallback((points, intersectionAnalysis = null, hideWalkArea = false) => {
    const layer = pointLayerRef.current
    if (!layer) return

    layer.clearLayers()

    const displayPoints = intersectionAnalysis?.countPoints ?? points.map((point, index) => ({
      original: point,
      snapped: point,
      label: String.fromCharCode(65 + index),
    }))

    const useBoundaryPoints =
      intersectionAnalysis?.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY

    if (!hideWalkArea) {
    displayPoints.forEach((entry, index) => {
      const snapped = entry.snapped ?? entry
      const original = entry.original ?? entry
      const markerPoint = useBoundaryPoints ? original : snapped

      L.circleMarker([markerPoint.lat, markerPoint.lng], {
        radius: 8,
        color: '#f13193',
        fillColor: '#f13193',
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip(`Point ${entry.label ?? String.fromCharCode(65 + index)}`, {
          permanent: true,
          direction: 'top',
          className: 'count-point-label',
        })
        .addTo(layer)

      if (
        intersectionAnalysis &&
        !useBoundaryPoints &&
        original &&
        (Math.abs(original.lat - snapped.lat) > 0.000001 ||
          Math.abs(original.lng - snapped.lng) > 0.000001)
      ) {
        L.polyline(
          [
            [original.lat, original.lng],
            [snapped.lat, snapped.lng],
          ],
          { color: '#666', weight: 1, dashArray: '3 4', opacity: 0.7 },
        ).addTo(layer)
      }
    })
    }

    if (
      !hideWalkArea &&
      intersectionAnalysis?.walkArea?.coordinates?.length >= 3
    ) {
      L.polygon(
        intersectionAnalysis.walkArea.coordinates.map((coord) => [coord.lat, coord.lng]),
        {
          color: '#5a8f7b',
          fillColor: '#5a8f7b',
          fillOpacity: 0.08,
          weight: 2,
          opacity: 0.55,
          dashArray: '6 4',
        },
      )
        .bindTooltip('Pedestrian walk area', { direction: 'center' })
        .addTo(layer)
    }

    if (intersectionAnalysis?.hubSnap?.point) {
      const hub = intersectionAnalysis.hubSnap.point
      L.circleMarker([hub.lat, hub.lng], {
        radius: 6,
        color: '#fff',
        fillColor: '#10e0f0',
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip(
          intersectionAnalysis.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
            ? 'Intersection hub'
            : 'Crossing hub',
          { direction: 'bottom' },
        )
        .addTo(layer)
    }
  }, [])

  const fitToPoints = useCallback((points) => {
    const map = mapInstanceRef.current
    if (!map || points.length === 0) return

    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]))
    map.fitBounds(bounds.pad(0.35))
  }, [])

  const resetWorkflow = useCallback(() => {
    simControllerRef.current?.stop()
    walkAreaEditorRef.current?.destroy()
    walkAreaEditorRef.current = null
    clearAgentLayer()
    setPickedPoints([])
    setIntersectionMode(null)
    setPedestrianNetwork(null)
    setAnalysis(null)
    setApproachCounts([])
    setWorkflowError(null)
    setSimulationInterval(null)
    setSimulationClock(null)
    setCrosswalkSignalMode(null)
    setCrosswalkSignalTiming(null)
    simCompleteRef.current = false
    pointLayerRef.current?.clearLayers()

    const map = mapInstanceRef.current
    if (pedestrianLayerRef.current && map) {
      map.removeLayer(pedestrianLayerRef.current)
      pedestrianLayerRef.current = null
    }
  }, [clearAgentLayer])

  const handleStartWorkflow = useCallback(() => {
    resetWorkflow()
    setWorkflowPhase('choosing_type')
  }, [resetWorkflow])

  const handleEditSimulation = useCallback(() => {
    simControllerRef.current?.stop()
    clearAgentLayer()
    routeLayerRef.current?.clearLayers()
    setSimulationClock(null)
    simCompleteRef.current = false
    setWorkflowError(null)
    setWorkflowPhase(
      analysis?.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
        ? 'editing_walk_area'
        : 'entering_counts',
    )
  }, [analysis?.intersectionMode, clearAgentLayer])

  const handleContinueWalkAreaEdit = useCallback(() => {
    setWorkflowError(null)
    setWorkflowPhase('entering_counts')
  }, [])

  const handleStartNewSimulation = useCallback(() => {
    handleStartWorkflow()
  }, [handleStartWorkflow])

  const handleSelectIntersectionType = useCallback((mode) => {
    setIntersectionMode(mode)
    setCrosswalkSignalMode(null)
    setCrosswalkSignalTiming(null)
    setWorkflowError(null)
    setWorkflowPhase('picking_points')
  }, [])

  const handleSelectCrosswalkSignalMode = useCallback((mode, options = {}) => {
    setCrosswalkSignalMode(mode)
    setCrosswalkSignalTiming(getCrosswalkSignalTiming(mode))
    setWorkflowError(null)
    setWorkflowPhase(options.skipTimingStep ? 'entering_counts' : 'entering_crosswalk_timing')
  }, [])

  const handleCrosswalkTimingChange = useCallback((timing) => {
    setCrosswalkSignalTiming(timing)
  }, [])

  const handleContinueCrosswalkTiming = useCallback(() => {
    setWorkflowError(null)
    setWorkflowPhase('entering_counts')
  }, [])

  const analyzePickedPoints = useCallback(async (points, mode) => {
    if (!mode) {
      setWorkflowError('Choose crosswalk or pedestrian intersection type first.')
      setWorkflowPhase('choosing_type')
      return
    }

    if (points.length < MIN_COUNT_POINTS) {
      setWorkflowError(`Place at least ${MIN_COUNT_POINTS} count points before committing.`)
      return
    }

    setIsLoading(true)
    setWorkflowError(null)
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    try {
      const center = points.reduce(
        (acc, point) => ({
          lat: acc.lat + point.lat / points.length,
          lng: acc.lng + point.lng / points.length,
        }),
        { lat: 0, lng: 0 },
      )

      const network = await fetchPedestrianNetwork(center, {
        mode:
          mode === INTERSECTION_MODES.PEDESTRIAN_ONLY
            ? NETWORK_MODES.PEDESTRIAN_ONLY
            : NETWORK_MODES.CROSSWALK,
      })

      await new Promise((resolve) => window.requestAnimationFrame(resolve))

      const intersectionAnalysisBase = analyzeIntersection(points, network, { mode })
      const hubSnap =
        mode === INTERSECTION_MODES.PEDESTRIAN_ONLY
          ? {
              point:
                intersectionAnalysisBase.walkArea?.center ??
                intersectionAnalysisBase.center,
              way: null,
            }
          : findIntersectionHub(network, center, mode)

      if (!hubSnap) {
        throw new Error(
          'Could not find a crosswalk or pedestrian path at the intersection center.',
        )
      }

      const intersectionAnalysis = attachCrosswalkPairing(
        attachIntersectionHub(intersectionAnalysisBase, hubSnap),
      )

      setPedestrianNetwork(network)
      setAnalysis(intersectionAnalysis)
      setApproachCounts(
        Array.from({ length: intersectionAnalysis.countPoints.length }, () => 0),
      )
      setCrosswalkSignalMode(null)
      setCrosswalkSignalTiming(null)
      setWorkflowPhase(
        mode === INTERSECTION_MODES.CROSSWALK
          ? 'choosing_crosswalk_signal'
          : 'editing_walk_area',
      )

      await new Promise((resolve) => window.requestAnimationFrame(resolve))

      renderPedestrianNetwork(network.geojson)
      renderCountPoints(
        points,
        intersectionAnalysis,
        intersectionAnalysis.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY,
      )
      fitToPoints(
        intersectionAnalysis.countPoints.map((entry) =>
          intersectionAnalysis.intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
            ? entry.original
            : entry.snapped,
        ),
      )
    } catch (error) {
      console.error(error)
      setWorkflowError(
        error instanceof Error
          ? error.message
          : 'Failed to load pedestrian network from OpenStreetMap.',
      )
      setWorkflowPhase('picking_points')
      renderCountPoints(points)
    } finally {
      setIsLoading(false)
    }
  }, [fitToPoints, renderCountPoints, renderPedestrianNetwork])

  const handleCommitPoints = useCallback(() => {
    if (workflowPhase !== 'picking_points') return
    if (pickedPoints.length < MIN_COUNT_POINTS) {
      setWorkflowError(`Place at least ${MIN_COUNT_POINTS} count points before committing.`)
      return
    }
    analyzePickedPoints(pickedPoints, intersectionMode)
  }, [analyzePickedPoints, intersectionMode, pickedPoints, workflowPhase])

  const handleMapClick = useCallback(
    (event) => {
      if (workflowPhase !== 'picking_points') return

      const nextPoints = [
        ...pickedPoints,
        { lat: event.latlng.lat, lng: event.latlng.lng },
      ]
      setPickedPoints(nextPoints)
      renderCountPoints(nextPoints)

      if (nextPoints.length === 1) {
        const map = mapInstanceRef.current
        map?.setView(event.latlng, Math.max(map.getZoom(), 17))
      }
    },
    [analyzePickedPoints, pickedPoints, renderCountPoints, workflowPhase],
  )

  const handleUndoLastPoint = useCallback(() => {
    if (workflowPhase !== 'picking_points' || pickedPoints.length === 0) return

    const nextPoints = pickedPoints.slice(0, -1)
    setPickedPoints(nextPoints)
    setWorkflowError(null)
    renderCountPoints(nextPoints)
  }, [pickedPoints, renderCountPoints, workflowPhase])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return undefined

    map.on('click', handleMapClick)
    const container = map.getContainer()
    if (workflowPhase === 'picking_points') {
      container.classList.add('map--picking')
    } else {
      container.classList.remove('map--picking')
    }

    return () => {
      map.off('click', handleMapClick)
      container.classList.remove('map--picking')
    }
  }, [handleMapClick, workflowPhase])

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return undefined

    if (!isWalkAreaEditorPhase || !analysis?.walkArea) {
      walkAreaEditorRef.current?.destroy()
      walkAreaEditorRef.current = null
      return undefined
    }

    if (!walkAreaEditorRef.current) {
      walkAreaEditorRef.current = createWalkAreaEditor(map, {
        walkArea: analysis.walkArea,
        countPoints: analysis.countPoints ?? [],
        onChange: handleWalkAreaChange,
      })
    }

    renderCountPoints(pickedPoints, analysis, true)

    return undefined
  }, [
    analysis,
    handleWalkAreaChange,
    isWalkAreaEditorPhase,
    pickedPoints,
    renderCountPoints,
  ])

  useEffect(
    () => () => {
      walkAreaEditorRef.current?.destroy()
      walkAreaEditorRef.current = null
    },
    [],
  )

  const movementAssignments = useMemo(() => {
    if (!analysis) return []
    return distributeCountsToMovements(approachCounts, analysis)
  }, [analysis, approachCounts])

  const handleApproachCountChange = useCallback((index, value) => {
    const parsed = Number.parseInt(value, 10)
    setApproachCounts((prev) => {
      const next = [...prev]
      while (next.length <= index) next.push(0)
      next[index] = Number.isNaN(parsed) ? 0 : Math.max(0, parsed)
      return next
    })
  }, [])

  const handleRunSimulation = useCallback(() => {
    if (!analysis || !pedestrianNetwork) {
      return {
        ok: false,
        message: 'Intersection is not ready yet. Place and commit your count points first.',
      }
    }

    const totalCount = approachCounts.reduce((sum, count) => sum + count, 0)
    if (totalCount <= 0) {
      return {
        ok: false,
        message: 'Enter pedestrian counts greater than zero before running.',
      }
    }

    if (!simulationInterval) {
      return {
        ok: false,
        message: 'Set the simulation interval first (e.g. type 1 hour in the chat).',
      }
    }

    const activeMode = analysis.intersectionMode ?? intersectionMode
    if (activeMode === INTERSECTION_MODES.CROSSWALK && !crosswalkSignalMode) {
      return {
        ok: false,
        message:
          'Choose crosswalk signal timing first (type simultaneous or sequential in the chat).',
      }
    }

    simControllerRef.current?.stop()
    clearAgentLayer()
    setWorkflowError(null)
    setSimulationClock(null)
    simCompleteRef.current = false

    const assignments = movementAssignments
    const hubSnap =
      activeMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
        ? analysis.hubSnap ?? { point: analysis.walkArea?.center ?? analysis.center }
        : analysis.hubSnap
    if (!hubSnap) {
      return {
        ok: false,
        message: 'Intersection hub is missing. Place your points again and commit.',
      }
    }

    const crosswalkSignal = buildCrosswalkSignalConfig(
      analysis,
      crosswalkSignalMode,
      crosswalkSignalTiming,
    )

    const population = buildAgentPopulation(
      pedestrianNetwork,
      assignments,
      hubSnap,
      activeMode,
      simulationInterval,
      crosswalkSignal,
      analysis.walkArea,
    )
    if (population.agents.length === 0) {
      const message =
        activeMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
          ? 'No valid pedestrian agents could be created inside the walk area. Try placing count points closer to mapped roads.'
          : 'No valid pedestrian agents could be created on the walkable network. Try placing count points closer to mapped footways.'
      setWorkflowError(message)
      return { ok: false, message }
    }

    const map = mapInstanceRef.current
    if (map) {
      const bounds = L.latLngBounds([])
      population.agents.forEach((agent) => {
        bounds.extend([agent.position.lat, agent.position.lng])
        agent.centerPath.forEach((coord) => bounds.extend([coord.lat, coord.lng]))
      })
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.15))
      }
    }

    routeLayerRef.current?.clearLayers()
    if (
      activeMode === INTERSECTION_MODES.PEDESTRIAN_ONLY &&
      analysis.walkArea?.coordinates?.length >= 3
    ) {
      L.polygon(
        analysis.walkArea.coordinates.map((coord) => [coord.lat, coord.lng]),
        {
          color: '#5a8f7b',
          fillColor: '#5a8f7b',
          fillOpacity: 0.12,
          weight: 2,
          opacity: 0.45,
        },
      ).addTo(routeLayerRef.current)
    } else {
      buildCorridorPolygons(pedestrianNetwork).forEach((corridor) => {
        L.polygon(
          corridor.coordinates.map((coord) => [coord.lat, coord.lng]),
          {
            color: corridor.isCrossing ? '#10e0f0' : '#5a8f7b',
            fillColor: corridor.isCrossing ? '#10e0f0' : '#5a8f7b',
            fillOpacity: corridor.isPedestrianZone ? 0.14 : 0.1,
            weight: 1,
            opacity: 0.35,
          },
        ).addTo(routeLayerRef.current)
      })
    }

    const agentMarkers = new Map()
    const markerRadius =
      population.agents.length > 120 ? 4 : population.agents.length > 60 ? 5 : 7

    simControllerRef.current = createAgentSimulation(
      population,
      simulationInterval,
      (clock) => {
      const { agentPositions } = clock
      const now = performance.now()
      if (now - lastClockUpdateRef.current > 200) {
        lastClockUpdateRef.current = now
        setSimulationClock(clock)
      }

      if (
        !simCompleteRef.current &&
        clock.elapsedDisplaySeconds >= simulationInterval.displaySeconds
      ) {
        simCompleteRef.current = true
        window.setTimeout(() => {
          setWorkflowPhase((phase) => (phase === 'running' ? 'complete' : phase))
        }, 500)
      }

      const layer = agentLayerRef.current
      if (!layer) return

      const activeIds = new Set(agentPositions.map((agent) => agent.id))

      agentMarkers.forEach((marker, id) => {
        if (!activeIds.has(id)) {
          layer.removeLayer(marker)
          agentMarkers.delete(id)
        }
      })

      agentPositions.forEach((agent) => {
        const color = agent.color ?? TURN_COLORS[agent.turnType] ?? '#10e0f0'
        let marker = agentMarkers.get(agent.id)

        if (!marker) {
          marker = L.circleMarker(agent.latlng, {
            radius: agent.state === 'yielding' ? markerRadius - 1 : markerRadius,
            color: '#fff',
            fillColor: color,
            fillOpacity: agent.state === 'yielding' ? 0.85 : 1,
            weight: 2,
          })
          const stateLabel =
            agent.state === 'waiting_vehicles'
              ? 'Waiting for vehicles'
              : agent.state === 'waiting_signal'
                ? 'Waiting for walk signal'
                : agent.state
          marker.bindTooltip(
            `${agent.fromLabel} → ${agent.toLabel}<br/>Speed: ${agent.speed.toFixed(1)} m/s (sim)<br/>Lane: ${agent.lateral?.toFixed(1) ?? '0.0'} m<br/>State: ${stateLabel}`,
            { direction: 'top', opacity: 0.9 },
          )
          marker.addTo(layer)
          agentMarkers.set(agent.id, marker)
        } else {
          marker.setLatLng(agent.latlng)
          marker.setStyle({
            radius: agent.state === 'yielding' ? markerRadius - 1 : markerRadius,
            fillOpacity: agent.state === 'yielding' ? 0.85 : 1,
            fillColor: color,
          })
        }
      })
    },
    )

    setWorkflowPhase('running')
    simControllerRef.current.start()

    const enteredTotal = totalApproachCount(approachCounts)
    const { requestedTotal, createdTotal, movementStats } = population.stats
    let countMessage = `Simulating ${createdTotal} pedestrian${createdTotal === 1 ? '' : 's'} from your counts (${enteredTotal} entered across ${analysis.countPoints.length} points).`
    if (crosswalkSignal?.mode) {
      countMessage += ` Crosswalk signals: ${describeCrosswalkSignalMode(crosswalkSignal.mode, crosswalkSignal.timing)}.`
    }

    if (createdTotal < requestedTotal) {
      const failedMovements = movementStats
        .filter((entry) => entry.created < entry.requested)
        .slice(0, 4)
        .map((entry) => `${entry.label} (${entry.created}/${entry.requested})`)
      countMessage += ` ${requestedTotal - createdTotal} could not be routed on the walkable network.`
      if (failedMovements.length > 0) {
        countMessage += ` Missing routes: ${failedMovements.join('; ')}.`
      }
    }

    return {
      ok: true,
      message: `${countMessage} ${describeSimulationTiming(simulationInterval)}`,
    }
  }, [
    analysis,
    approachCounts,
    clearAgentLayer,
    intersectionMode,
    movementAssignments,
    crosswalkSignalMode,
    crosswalkSignalTiming,
    pedestrianNetwork,
    simulationInterval,
  ])

  return (
    <div className="page">
      <header className="site-header">
        <div className="logo-wrap">
          <img
            src="/goneon-logo.png"
            alt="GO NEON"
            className="site-logo"
          />
        </div>
      </header>

      <div className="content">
        <ChatPane
          chatEnabled
          workflowPhase={workflowPhase}
          pickedPointCount={pickedPoints.length}
          intersectionMode={intersectionMode}
          analysis={analysis}
          approachCounts={approachCounts}
          movementAssignments={movementAssignments}
          onApproachCountChange={handleApproachCountChange}
          onStartWorkflow={handleStartWorkflow}
          onSelectIntersectionType={handleSelectIntersectionType}
          onSelectCrosswalkSignalMode={handleSelectCrosswalkSignalMode}
          crosswalkSignalMode={crosswalkSignalMode}
          crosswalkSignalTiming={crosswalkSignalTiming}
          onCrosswalkTimingChange={handleCrosswalkTimingChange}
          onContinueCrosswalkTiming={handleContinueCrosswalkTiming}
          onCommitPoints={handleCommitPoints}
          onRunSimulation={handleRunSimulation}
          onEditSimulation={handleEditSimulation}
          onContinueWalkAreaEdit={handleContinueWalkAreaEdit}
          onStartNewSimulation={handleStartNewSimulation}
          onUndoLastPoint={handleUndoLastPoint}
          simulationInterval={simulationInterval}
          simulationClock={simulationClock}
          onSimulationIntervalChange={setSimulationInterval}
          isLoading={isLoading}
          workflowError={workflowError}
        />

        <main className="map-section">
          <div ref={mapRef} className="map" />
          {isLoading && (
            <div className="map-loading-overlay" aria-live="polite">
              <div className="map-loading-card">
                <span className="map-loading-spinner" aria-hidden="true" />
                <span>Loading pedestrian network from OpenStreetMap…</span>
              </div>
            </div>
          )}
          {workflowPhase === 'choosing_type' && (
            <div className="map-hint">
              <span>Choose intersection type in the chat: crosswalk or pedestrian</span>
            </div>
          )}
          {workflowPhase === 'choosing_crosswalk_signal' && (
            <div className="map-hint">
              <span>Choose crosswalk signal timing in the chat: simultaneous or sequential</span>
            </div>
          )}
          {workflowPhase === 'entering_crosswalk_timing' && (
            <div className="map-hint">
              <span>Set vehicle and walk intervals in the chat, or type continue for defaults</span>
            </div>
          )}
          {workflowPhase === 'editing_walk_area' && (
            <div className="map-hint">
              <span>
                Drag pink corners to move count points. Click-drag an edge to widen the area.
                Double-click an edge to add a point.
              </span>
              <div className="map-hint-actions">
                <button
                  type="button"
                  className="map-commit-btn"
                  onClick={handleContinueWalkAreaEdit}
                >
                  Continue to counts
                </button>
              </div>
            </div>
          )}
          {workflowPhase === 'entering_counts' &&
            intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY && (
            <div className="map-hint map-hint--subtle">
              <span>
                Walk area is editable: click-drag edges to widen, double-click to add a point.
              </span>
            </div>
          )}
          {workflowPhase === 'picking_points' && (
            <div className="map-hint">
              <span>
                {intersectionMode === INTERSECTION_MODES.PEDESTRIAN_ONLY
                  ? 'Pedestrian-only: click corners around the intersection (4 recommended, min 2)'
                  : 'Crosswalk: click count points (min 2)'}
                {pickedPoints.length > 0 ? ` — ${pickedPoints.length} placed` : ''}
              </span>
              <div className="map-hint-actions">
                {pickedPoints.length > 0 && (
                  <button
                    type="button"
                    className="map-undo-btn"
                    onClick={handleUndoLastPoint}
                  >
                    Undo last point
                  </button>
                )}
                {pickedPoints.length >= MIN_COUNT_POINTS && (
                  <button
                    type="button"
                    className="map-commit-btn"
                    onClick={handleCommitPoints}
                    disabled={isLoading}
                  >
                    Done — use {pickedPoints.length} point{pickedPoints.length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="map-legend">
            <span className="map-legend-label">Pedestrian movements</span>
            <div className="map-legend-items">
              <span><i className="legend-swatch legend-swatch--through" /> Cross</span>
              <span><i className="legend-swatch legend-swatch--left" /> Left</span>
              <span><i className="legend-swatch legend-swatch--right" /> Right</span>
            </div>
            <div className="map-legend-scale">
              <span>OSM crosswalks</span>
              <span>Walkable corridors</span>
              <span>Pedestrian zones</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
