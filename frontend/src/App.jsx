import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import ChatPane from './ChatPane.jsx'
import {
  analyzeIntersection,
  attachIntersectionHub,
  distributeCountsToMovements,
} from './services/intersectionAnalysis.js'
import { fetchPedestrianNetwork } from './services/pedestrianOsm.js'
import {
  buildAgentPopulation,
  createAgentSimulation,
  findIntersectionHub,
} from './services/pedestrianAgents.js'
import { buildCorridorPolygons } from './services/walkableNetwork.js'
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

  const [workflowPhase, setWorkflowPhase] = useState('picking_points')
  const [pickedPoints, setPickedPoints] = useState([])
  const [pedestrianNetwork, setPedestrianNetwork] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [approachCounts, setApproachCounts] = useState([0, 0, 0, 0])
  const [isLoading, setIsLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState(null)

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
      style: (feature) => ({
        color: feature.properties.isCrossing ? '#10e0f0' : '#5a8f7b',
        weight: feature.properties.isCrossing ? 3 : 2,
        opacity: feature.properties.isPedestrianZone ? 0.95 : 0.75,
        dashArray: feature.properties.isCrossing ? null : '4 6',
      }),
    }).addTo(map)
  }, [])

  const renderCountPoints = useCallback((points, intersectionAnalysis = null) => {
    const layer = pointLayerRef.current
    if (!layer) return

    layer.clearLayers()

    const displayPoints = intersectionAnalysis?.countPoints ?? points.map((point, index) => ({
      original: point,
      snapped: point,
      label: String.fromCharCode(65 + index),
    }))

    displayPoints.forEach((entry, index) => {
      const snapped = entry.snapped ?? entry
      const original = entry.original ?? entry

      L.circleMarker([snapped.lat, snapped.lng], {
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

    if (intersectionAnalysis?.hubSnap?.point) {
      const hub = intersectionAnalysis.hubSnap.point
      L.circleMarker([hub.lat, hub.lng], {
        radius: 6,
        color: '#fff',
        fillColor: '#10e0f0',
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindTooltip('Crossing hub', { direction: 'bottom' })
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
    clearAgentLayer()
    setPickedPoints([])
    setPedestrianNetwork(null)
    setAnalysis(null)
    setApproachCounts([0, 0, 0, 0])
    setWorkflowError(null)
    pointLayerRef.current?.clearLayers()

    const map = mapInstanceRef.current
    if (pedestrianLayerRef.current && map) {
      map.removeLayer(pedestrianLayerRef.current)
      pedestrianLayerRef.current = null
    }
  }, [clearAgentLayer])

  const handleStartWorkflow = useCallback(() => {
    resetWorkflow()
    setWorkflowPhase('picking_points')
  }, [resetWorkflow])

  const analyzePickedPoints = useCallback(async (points) => {
    setIsLoading(true)
    try {
      const center = points.reduce(
        (acc, point) => ({
          lat: acc.lat + point.lat / points.length,
          lng: acc.lng + point.lng / points.length,
        }),
        { lat: 0, lng: 0 },
      )

      const network = await fetchPedestrianNetwork(center)
      const hubSnap = findIntersectionHub(network, center)
      if (!hubSnap) {
        throw new Error(
          'Could not find a crosswalk or pedestrian path at the intersection center.',
        )
      }

      const intersectionAnalysis = attachIntersectionHub(
        analyzeIntersection(points, network),
        hubSnap,
      )

      setPedestrianNetwork(network)
      setAnalysis(intersectionAnalysis)
      renderPedestrianNetwork(network.geojson)
      renderCountPoints(points, intersectionAnalysis)
      fitToPoints(intersectionAnalysis.countPoints.map((entry) => entry.snapped))
      setWorkflowPhase('entering_counts')
    } catch (error) {
      console.error(error)
      setWorkflowError(
        error instanceof Error
          ? error.message
          : 'Failed to load pedestrian network from OpenStreetMap.',
      )
      setWorkflowPhase('picking_points')
      setPickedPoints([])
      renderCountPoints([])
    } finally {
      setIsLoading(false)
    }
  }, [fitToPoints, renderCountPoints, renderPedestrianNetwork])

  const handleMapClick = useCallback(
    (event) => {
      if (workflowPhase !== 'picking_points') return

      const nextPoints = [
        ...pickedPoints,
        { lat: event.latlng.lat, lng: event.latlng.lng },
      ]
      setPickedPoints(nextPoints)
      renderCountPoints(nextPoints)

      if (nextPoints.length === 4) {
        analyzePickedPoints(nextPoints)
      } else if (nextPoints.length === 1) {
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

  const handleApproachCountChange = useCallback((index, value) => {
    const parsed = Number.parseInt(value, 10)
    setApproachCounts((prev) => {
      const next = [...prev]
      next[index] = Number.isNaN(parsed) ? 0 : Math.max(0, parsed)
      return next
    })
  }, [])

  const handleRunSimulation = useCallback(() => {
    if (!analysis || !pedestrianNetwork) {
      return {
        ok: false,
        message: 'Intersection is not ready yet. Place all four count points first.',
      }
    }

    const totalCount = approachCounts.reduce((sum, count) => sum + count, 0)
    if (totalCount <= 0) {
      return {
        ok: false,
        message: 'Enter pedestrian counts greater than zero before running.',
      }
    }

    simControllerRef.current?.stop()
    clearAgentLayer()
    setWorkflowError(null)

    const assignments = distributeCountsToMovements(approachCounts, analysis)
    const hubSnap = analysis.hubSnap
    if (!hubSnap) {
      return {
        ok: false,
        message: 'Intersection hub is missing. Place the four points again.',
      }
    }

    const population = buildAgentPopulation(pedestrianNetwork, assignments, hubSnap)
    if (population.agents.length === 0) {
      const message =
        'No valid pedestrian agents could be created on the walkable network. Try placing count points closer to mapped footways.'
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

    const agentMarkers = new Map()

    simControllerRef.current = createAgentSimulation(population, ({ agentPositions }) => {
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
            radius: agent.state === 'yielding' ? 5 : 7,
            color: '#fff',
            fillColor: color,
            fillOpacity: agent.state === 'yielding' ? 0.65 : 1,
            weight: 2,
          })
          marker.bindTooltip(
            `${agent.fromLabel} → ${agent.toLabel}<br/>Speed: ${agent.speed.toFixed(1)} m/s<br/>Lane offset: ${agent.lateral?.toFixed(1) ?? '0.0'} m<br/>State: ${agent.state}`,
            { direction: 'top', opacity: 0.9 },
          )
          marker.addTo(layer)
          agentMarkers.set(agent.id, marker)
        } else {
          marker.setLatLng(agent.latlng)
          marker.setStyle({
            radius: agent.state === 'yielding' ? 5 : 7,
            fillOpacity: agent.state === 'yielding' ? 0.65 : 1,
            fillColor: color,
          })
        }
      })
    })

    setWorkflowPhase('running')
    simControllerRef.current.start()

    window.setTimeout(() => {
      setWorkflowPhase((phase) => (phase === 'running' ? 'complete' : phase))
    }, 25000)

    return {
      ok: true,
      message: `Agent-based simulation started with ${population.agents.length} pedestrians. Shaded areas show walkable bounds; each agent walks its own lane and steers around others.`,
    }
  }, [analysis, approachCounts, clearAgentLayer, pedestrianNetwork])

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
          analysis={analysis}
          approachCounts={approachCounts}
          onApproachCountChange={handleApproachCountChange}
          onStartWorkflow={handleStartWorkflow}
          onRunSimulation={handleRunSimulation}
          onUndoLastPoint={handleUndoLastPoint}
          isLoading={isLoading}
          workflowError={workflowError}
        />

        <main className="map-section">
          <div ref={mapRef} className="map" />
          {workflowPhase === 'picking_points' && (
            <div className="map-hint">
              <span>Click 4 pedestrian count points on the intersection</span>
              {pickedPoints.length > 0 && (
                <button
                  type="button"
                  className="map-undo-btn"
                  onClick={handleUndoLastPoint}
                >
                  Undo last point
                </button>
              )}
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
