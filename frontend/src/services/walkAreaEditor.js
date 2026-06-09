import L from 'leaflet'
import {
  computeEdgeOutwardNormal,
  dragOffsetAlongNormal,
  findNearestEdge,
  getEdgeDragVertexIndices,
  insertVertexOnEdge,
  offsetCoordinatesByNormal,
  polygonCenter,
  rebuildWalkArea,
} from './walkableNetwork.js'

const EDGE_HIT_WEIGHT = 14
const MIN_VERTEX_COUNT = 3

function cloneCoord(coord) {
  return { lat: coord.lat, lng: coord.lng }
}

function createVertexIcon(isCountPoint, label) {
  const className = isCountPoint
    ? 'walk-area-vertex walk-area-vertex--count'
    : 'walk-area-vertex walk-area-vertex--shape'

  const labelHtml = isCountPoint && label
    ? `<span class="walk-area-vertex-label">${label}</span>`
    : ''

  return L.divIcon({
    className,
    html: `<span class="walk-area-vertex-dot"></span>${labelHtml}`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

function countPointLabel(countPoints, vertexMeta) {
  if (vertexMeta?.type !== 'count' || !vertexMeta.countPointId) return null
  return countPoints.find((point) => point.id === vertexMeta.countPointId)?.label ?? null
}

export function createWalkAreaEditor(map, options = {}) {
  const layer = L.layerGroup().addTo(map)
  let enabled = options.enabled ?? true
  let coordinates = (options.walkArea?.coordinates ?? []).map(cloneCoord)
  let vertices = (options.walkArea?.vertices ?? []).map((vertex) => ({ ...vertex }))
  let countPoints = options.countPoints ?? []
  let onChange = options.onChange ?? null

  let polygon = null
  let edgeLayers = []
  let vertexMarkers = []
  let activeEdgeHighlight = null
  let mapDblClickHandler = null
  let edgeDragState = null

  function getWalkArea() {
    return rebuildWalkArea(coordinates, vertices)
  }

  function emitChange() {
    onChange?.(getWalkArea())
  }

  function syncPolygonGeometry() {
    if (!polygon) return
    polygon.setLatLngs(coordinates.map((coord) => [coord.lat, coord.lng]))

    edgeLayers.forEach((edgeLayer, edgeIndex) => {
      const start = coordinates[edgeIndex]
      const end = coordinates[(edgeIndex + 1) % coordinates.length]
      edgeLayer.setLatLngs([
        [start.lat, start.lng],
        [end.lat, end.lng],
      ])
    })
  }

  function updateVertexMarkerPositions() {
    vertexMarkers.forEach((marker, index) => {
      const coord = coordinates[index]
      if (coord) marker.setLatLng([coord.lat, coord.lng])
    })
  }

  function updateActiveEdgeHighlight(edgeIndex) {
    if (activeEdgeHighlight) {
      layer.removeLayer(activeEdgeHighlight)
      activeEdgeHighlight = null
    }
    if (edgeIndex == null) return

    const start = coordinates[edgeIndex]
    const end = coordinates[(edgeIndex + 1) % coordinates.length]
    activeEdgeHighlight = L.polyline(
      [
        [start.lat, start.lng],
        [end.lat, end.lng],
      ],
      {
        color: '#10e0f0',
        weight: 4,
        opacity: 0.95,
        interactive: false,
        className: 'walk-area-edge-active',
      },
    ).addTo(layer)
  }

  function updateVertexPosition(index, latlng) {
    coordinates[index] = { lat: latlng.lat, lng: latlng.lng }
    syncPolygonGeometry()
  }

  function insertVertexOnNearestEdge(latlng) {
    const edge = findNearestEdge(coordinates, { lat: latlng.lat, lng: latlng.lng })
    if (!edge) return false

    coordinates = insertVertexOnEdge(coordinates, edge.edgeIndex, edge.point)
    vertices = [
      ...vertices.slice(0, edge.edgeIndex + 1),
      { type: 'shape' },
      ...vertices.slice(edge.edgeIndex + 1),
    ]
    render()
    emitChange()
    return true
  }

  function finishEdgeDrag() {
    if (!edgeDragState) return

    map.off('mousemove', handleEdgeDragMove)
    map.off('mouseup', handleEdgeDragEnd)
    L.DomEvent.off(document, 'mouseup', handleEdgeDragEnd)
    map.dragging.enable()
    map.getContainer().classList.remove('map--edge-dragging')

    edgeDragState = null
    updateActiveEdgeHighlight(null)
    emitChange()
  }

  function handleEdgeDragMove(event) {
    if (!edgeDragState) return

    const offsetMeters = dragOffsetAlongNormal(
      edgeDragState.startLatLng,
      { lat: event.latlng.lat, lng: event.latlng.lng },
      edgeDragState.normal,
    )

    coordinates = offsetCoordinatesByNormal(
      edgeDragState.initialCoords,
      edgeDragState.vertexIndices,
      offsetMeters,
      edgeDragState.normal,
    )

    syncPolygonGeometry()
    updateVertexMarkerPositions()
    updateActiveEdgeHighlight(edgeDragState.edgeIndex)
  }

  function handleEdgeDragEnd() {
    finishEdgeDrag()
  }

  function startEdgeDrag(edgeIndex, latlng) {
    if (!enabled || edgeDragState) return

    const center = polygonCenter(coordinates)
    const normal = computeEdgeOutwardNormal(coordinates, edgeIndex, center)
    const vertexIndices = getEdgeDragVertexIndices(coordinates, edgeIndex)

    edgeDragState = {
      edgeIndex,
      startLatLng: { lat: latlng.lat, lng: latlng.lng },
      initialCoords: coordinates.map(cloneCoord),
      normal,
      vertexIndices,
    }

    map.dragging.disable()
    map.getContainer().classList.add('map--edge-dragging')
    updateActiveEdgeHighlight(edgeIndex)
    map.on('mousemove', handleEdgeDragMove)
    map.on('mouseup', handleEdgeDragEnd)
    L.DomEvent.on(document, 'mouseup', handleEdgeDragEnd)
  }

  function handleEdgeMouseDown(edgeIndex, event) {
    if (!enabled || edgeDragState) return
    L.DomEvent.stopPropagation(event)
    startEdgeDrag(edgeIndex, event.latlng)
  }

  function handleEdgeDoubleClick(event) {
    if (!enabled || edgeDragState) return
    L.DomEvent.stopPropagation(event)
    insertVertexOnNearestEdge(event.latlng)
  }

  function handleMapDoubleClick(event) {
    if (!enabled || edgeDragState) return
    insertVertexOnNearestEdge(event.latlng)
  }

  function render() {
    if (edgeDragState) {
      finishEdgeDrag()
    }

    layer.clearLayers()
    polygon = null
    edgeLayers = []
    vertexMarkers = []
    activeEdgeHighlight = null

    if (coordinates.length < MIN_VERTEX_COUNT) return

    polygon = L.polygon(
      coordinates.map((coord) => [coord.lat, coord.lng]),
      {
        color: '#5a8f7b',
        fillColor: '#5a8f7b',
        fillOpacity: 0.1,
        weight: 2,
        opacity: 0.65,
        interactive: false,
      },
    ).addTo(layer)

    for (let edgeIndex = 0; edgeIndex < coordinates.length; edgeIndex += 1) {
      const start = coordinates[edgeIndex]
      const end = coordinates[(edgeIndex + 1) % coordinates.length]
      const edgeLayer = L.polyline(
        [
          [start.lat, start.lng],
          [end.lat, end.lng],
        ],
        {
          color: '#5a8f7b',
          weight: EDGE_HIT_WEIGHT,
          opacity: 0.01,
          interactive: enabled,
          className: 'walk-area-edge-hit',
        },
      )
        .on('mousedown', (event) => handleEdgeMouseDown(edgeIndex, event))
        .on('dblclick', handleEdgeDoubleClick)
        .addTo(layer)

      edgeLayers.push(edgeLayer)
    }

    coordinates.forEach((coord, index) => {
      const vertexMeta = vertices[index] ?? { type: 'shape' }
      const isCountPoint = vertexMeta.type === 'count'
      const marker = L.marker([coord.lat, coord.lng], {
        draggable: enabled,
        icon: createVertexIcon(isCountPoint, countPointLabel(countPoints, vertexMeta)),
        zIndexOffset: isCountPoint ? 800 : 600,
      }).addTo(layer)

      marker.on('dragstart', () => {
        if (edgeDragState) finishEdgeDrag()
      })

      marker.on('drag', () => {
        updateVertexPosition(index, marker.getLatLng())
      })

      marker.on('dragend', () => {
        updateVertexPosition(index, marker.getLatLng())
        emitChange()
      })

      vertexMarkers.push(marker)
    })
  }

  function setEnabled(nextEnabled) {
    enabled = nextEnabled

    if (enabled) {
      map.doubleClickZoom.disable()
      if (!mapDblClickHandler) {
        mapDblClickHandler = handleMapDoubleClick
        map.on('dblclick', mapDblClickHandler)
      }
    } else {
      finishEdgeDrag()
      map.doubleClickZoom.enable()
      if (mapDblClickHandler) {
        map.off('dblclick', mapDblClickHandler)
        mapDblClickHandler = null
      }
    }

    render()
  }

  function setWalkArea(walkArea, nextCountPoints = countPoints) {
    finishEdgeDrag()
    coordinates = (walkArea?.coordinates ?? []).map(cloneCoord)
    vertices = (walkArea?.vertices ?? []).map((vertex) => ({ ...vertex }))
    countPoints = nextCountPoints
    render()
  }

  function destroy() {
    finishEdgeDrag()
    map.doubleClickZoom.enable()
    if (mapDblClickHandler) {
      map.off('dblclick', mapDblClickHandler)
      mapDblClickHandler = null
    }
    layer.clearLayers()
    map.removeLayer(layer)
  }

  setEnabled(enabled)

  return {
    setEnabled,
    setWalkArea,
    getWalkArea,
    destroy,
  }
}
