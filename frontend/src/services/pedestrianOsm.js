const OVERPASS_URLS = ['/api/overpass', '/api/overpass-alt']

const PEDESTRIAN_HIGHWAYS = new Set([
  'footway',
  'pedestrian',
  'path',
  'steps',
  'living_street',
  'crossing',
])

function isPedestrianWay(tags = {}) {
  if (tags.foot === 'no' || tags.access === 'private') return false
  if (tags.bicycle === 'designated' && tags.foot !== 'yes' && tags.highway !== 'footway') {
    return false
  }

  const highway = tags.highway
  if (!highway) return false

  if (highway === 'footway' || highway === 'pedestrian' || highway === 'steps') return true
  if (highway === 'crossing') return true
  if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return true
  if (highway === 'path' && tags.foot !== 'no') return true
  if (highway === 'living_street') return true

  return PEDESTRIAN_HIGHWAYS.has(highway)
}

function isCrossing(tags = {}) {
  return (
    tags.highway === 'crossing' ||
    tags.footway === 'crossing' ||
    tags.crossing != null
  )
}

function coordKey(coord) {
  return `${coord.lat.toFixed(6)},${coord.lng.toFixed(6)}`
}

function buildBbox(lat, lng, radiusMeters = 120) {
  const latDelta = radiusMeters / 111320
  const lngDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180))

  return {
    south: lat - latDelta,
    west: lng - lngDelta,
    north: lat + latDelta,
    east: lng + lngDelta,
  }
}

function buildOverpassQuery(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  return `[out:json][timeout:90];
(
  way["highway"~"^(footway|pedestrian|path|steps|living_street)$"](${bboxStr});
  way["highway"="crossing"](${bboxStr});
  way["footway"="crossing"](${bboxStr});
  way["highway"="footway"]["footway"="sidewalk"](${bboxStr});
  way["highway"="footway"]["footway"="crossing"](${bboxStr});
  node["highway"="crossing"](${bboxStr});
  way["area"="yes"]["highway"="pedestrian"](${bboxStr});
);
out body geom;
>;
out skel qt;`
}

function haversineMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const earthRadius = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(h))
}

function projectPointOnSegment(point, start, end) {
  const dx = end.lng - start.lng
  const dy = end.lat - start.lat
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) {
    return { point: start, t: 0, distance: haversineMeters(point, start) }
  }

  let t = ((point.lng - start.lng) * dx + (point.lat - start.lat) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))

  const projected = {
    lat: start.lat + t * dy,
    lng: start.lng + t * dx,
  }

  return {
    point: projected,
    t,
    distance: haversineMeters(point, projected),
  }
}

function parseOverpassElements(data) {
  const nodes = new Map()
  const ways = []

  for (const element of data.elements ?? []) {
    if (element.type === 'node') {
      nodes.set(element.id, { id: element.id, lat: element.lat, lng: element.lon })
    }
  }

  for (const element of data.elements ?? []) {
    if (element.type === 'way') {
      const tags = element.tags ?? {}
      if (!isPedestrianWay(tags)) continue

      const coordinates =
        element.geometry?.map((coord) => ({ lat: coord.lat, lng: coord.lon })) ??
        (element.nodes ?? [])
          .map((nodeId) => nodes.get(nodeId))
          .filter(Boolean)
          .map((node) => ({ lat: node.lat, lng: node.lng }))

      if (coordinates.length < 2) continue

      ways.push({
        id: element.id,
        tags,
        coordinates,
        isCrossing: isCrossing(tags),
        isPedestrianZone: tags.highway === 'pedestrian' || tags.area === 'yes',
      })
    }
  }

  return { nodes, ways }
}

function makeEdge(fromId, toId, fromCoord, toCoord, way) {
  const length = haversineMeters(fromCoord, toCoord)
  return {
    from: fromId,
    to: toId,
    length,
    weight: length * (way.isCrossing ? 0.9 : 1),
    coordinates: [fromCoord, toCoord],
    isCrossing: way.isCrossing,
    isPedestrianZone: way.isPedestrianZone,
    wayId: way.id,
  }
}

function buildPedestrianGraph(ways) {
  const nodeIndex = new Map()
  const graphNodes = []
  const edges = []

  const getNodeId = (coord, isCrossingNode = false) => {
    const key = coordKey(coord)
    if (!nodeIndex.has(key)) {
      nodeIndex.set(key, graphNodes.length)
      graphNodes.push({ ...coord, key, isCrossingNode })
    } else if (isCrossingNode) {
      graphNodes[nodeIndex.get(key)].isCrossingNode = true
    }
    return nodeIndex.get(key)
  }

  for (const way of ways) {
    for (let i = 0; i < way.coordinates.length - 1; i += 1) {
      const fromCoord = way.coordinates[i]
      const toCoord = way.coordinates[i + 1]
      const fromId = getNodeId(fromCoord, way.isCrossing)
      const toId = getNodeId(toCoord, way.isCrossing)

      edges.push(makeEdge(fromId, toId, fromCoord, toCoord, way))
      edges.push(makeEdge(toId, fromId, toCoord, fromCoord, way))
    }
  }

  return { graphNodes, edges, nodeIndex }
}

function snapToNetwork(latlng, ways, maxDistanceMeters = 18) {
  let best = null

  for (const way of ways) {
    for (let i = 0; i < way.coordinates.length - 1; i += 1) {
      const start = way.coordinates[i]
      const end = way.coordinates[i + 1]
      const projection = projectPointOnSegment(latlng, start, end)

      if (!best || projection.distance < best.distance) {
        best = {
          point: projection.point,
          distance: projection.distance,
          way,
          segmentIndex: i,
          segmentStart: start,
          segmentEnd: end,
        }
      }
    }
  }

  if (!best || best.distance > maxDistanceMeters) {
    return null
  }

  return best
}

function findEdgeContainingPoint(edges, snap) {
  const { point, way } = snap
  let fallback = null

  for (const edge of edges) {
    const [start, end] = edge.coordinates
    const projection = projectPointOnSegment(point, start, end)
    const onWay = edge.wayId === way.id
    const tolerance = onWay ? 2.5 : 1.5

    if (projection.distance > tolerance) continue

    const candidate = {
      distance: projection.distance,
      onWay,
      atStart: projection.t <= 0.02,
      atEnd: projection.t >= 0.98,
      edge,
      start,
      end,
      startId: edge.from,
      endId: edge.to,
    }

    if (!fallback || (candidate.onWay && !fallback.onWay) || candidate.distance < fallback.distance) {
      fallback = candidate
    }
  }

  if (!fallback) return null

  if (fallback.atStart) {
    return { type: 'endpoint', nodeId: fallback.edge.from, point: fallback.start }
  }
  if (fallback.atEnd) {
    return { type: 'endpoint', nodeId: fallback.edge.to, point: fallback.end }
  }

  return {
    type: 'segment',
    edge: fallback.edge,
    startId: fallback.startId,
    endId: fallback.endId,
    start: fallback.start,
    end: fallback.end,
  }
}

function findNearestGraphNodeId(graphNodes, point, maxDistanceMeters = 15) {
  let bestId = null
  let bestDistance = Infinity

  graphNodes.forEach((node, index) => {
    const distance = haversineMeters(node, point)
    if (distance < bestDistance) {
      bestDistance = distance
      bestId = index
    }
  })

  return bestDistance <= maxDistanceMeters ? bestId : null
}

function insertSnapOnSegment(graphNodes, edges, nodeIndex, snap) {
  const { point, way } = snap
  const existingKey = coordKey(point)
  if (nodeIndex.has(existingKey)) {
    return { graphNodes, edges, snapNodeId: nodeIndex.get(existingKey) }
  }

  const match = findEdgeContainingPoint(edges, snap)
  if (!match) {
    return { graphNodes, edges, snapNodeId: null }
  }

  if (match.type === 'endpoint') {
    return { graphNodes, edges, snapNodeId: match.nodeId }
  }

  const { edge, startId, endId, start, end } = match
  const snapNodeId = graphNodes.length
  graphNodes.push({ ...point, key: existingKey, isSnapPoint: true })
  nodeIndex.set(existingKey, snapNodeId)

  const filteredEdges = edges.filter((candidate) => candidate !== edge && candidate !== reverseEdge(edges, edge))

  const splitEdges = [
    makeEdge(startId, snapNodeId, start, point, way),
    makeEdge(snapNodeId, endId, point, end, way),
    makeEdge(snapNodeId, startId, point, start, way),
    makeEdge(endId, snapNodeId, end, point, way),
  ]

  return {
    graphNodes,
    edges: [...filteredEdges, ...splitEdges],
    snapNodeId,
  }
}

function reverseEdge(edges, edge) {
  return edges.find(
    (candidate) =>
      candidate.wayId === edge.wayId &&
      candidate.from === edge.to &&
      candidate.to === edge.from,
  )
}

export function createRoutableGraph(network, snapById) {
  let graphNodes = network.graphNodes.map((node) => ({ ...node }))
  let edges = network.edges.map((edge) => ({ ...edge }))
  const nodeIndex = new Map(graphNodes.map((node, index) => [node.key, index]))
  const snapNodeIds = new Map()

  const orderedSnaps = Object.entries(snapById).filter(([, snap]) => snap)

  orderedSnaps.forEach(([id, snap]) => {
    const result = insertSnapOnSegment(graphNodes, edges, nodeIndex, snap)
    graphNodes = result.graphNodes
    edges = result.edges

    if (result.snapNodeId != null) {
      snapNodeIds.set(id, result.snapNodeId)
      return
    }

    const fallbackId = findNearestGraphNodeId(graphNodes, snap.point, 20)
    if (fallbackId != null) {
      snapNodeIds.set(id, fallbackId)
    }
  })

  return { graphNodes, edges, snapNodeIds }
}

function waysToGeoJson(ways) {
  return {
    type: 'FeatureCollection',
    features: ways.map((way) => ({
      type: 'Feature',
      properties: {
        highway: way.tags.highway,
        footway: way.tags.footway,
        crossing: way.tags.crossing,
        isCrossing: way.isCrossing,
        isPedestrianZone: way.isPedestrianZone,
      },
      geometry: {
        type: 'LineString',
        coordinates: way.coordinates.map((coord) => [coord.lng, coord.lat]),
      },
    })),
  }
}

async function queryOverpass(query, url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  })

  const text = await response.text()
  if (!response.ok || text.includes('runtime error')) {
    throw new Error(text || 'Overpass request failed')
  }

  return JSON.parse(text)
}

export async function fetchPedestrianNetwork(center) {
  const bbox = buildBbox(center.lat, center.lng, 140)
  const query = buildOverpassQuery(bbox)

  let data = null
  let lastError = null

  for (const url of OVERPASS_URLS) {
    try {
      data = await queryOverpass(query, url)
      break
    } catch (error) {
      lastError = error
    }
  }

  if (!data) {
    throw new Error(
      lastError?.message ?? 'Failed to fetch pedestrian data from OpenStreetMap.',
    )
  }

  const { ways } = parseOverpassElements(data)
  const { graphNodes, edges, nodeIndex } = buildPedestrianGraph(ways)

  if (ways.length === 0) {
    throw new Error(
      'No pedestrian crosswalks or footways found near this intersection in OpenStreetMap.',
    )
  }

  return {
    bbox,
    ways,
    graphNodes,
    edges,
    nodeIndex,
    geojson: waysToGeoJson(ways),
  }
}

export function snapPointToPedestrianNetwork(latlng, network) {
  return snapToNetwork(latlng, network.ways)
}

export { haversineMeters, buildPedestrianGraph, coordKey, projectPointOnSegment }
