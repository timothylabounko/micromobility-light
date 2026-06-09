const OVERPASS_URLS = ['/api/overpass-alt', '/api/overpass-fr', '/api/overpass']

const OVERPASS_RETRY_DELAY_MS = 1500
const OVERPASS_FETCH_TIMEOUT_MS = 35000

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
  return `[out:json][timeout:25];
(
  way["highway"~"^(footway|pedestrian|path|steps|living_street|crossing)$"](${bboxStr});
  way["footway"~"^(sidewalk|crossing)$"](${bboxStr});
);
out geom;`
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

function buildAdjacencyList(edges) {
  const adjacency = new Map()

  edges.forEach((edge) => {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    adjacency.get(edge.from).push({ to: edge.to, weight: edge.weight, edge })
  })

  return adjacency
}

function dijkstraShortestPath(graphNodes, edges, startId, endId) {
  if (startId == null || endId == null) return null
  if (startId === endId) return [startId]

  const adjacency = buildAdjacencyList(edges)
  const distances = new Map([[startId, 0]])
  const previous = new Map()
  const queue = [{ nodeId: startId, dist: 0 }]

  while (queue.length > 0) {
    queue.sort((a, b) => a.dist - b.dist)
    const { nodeId: current, dist } = queue.shift()
    if (dist > (distances.get(current) ?? Infinity)) continue
    if (current === endId) break

    const neighbors = adjacency.get(current) ?? []
    neighbors.forEach(({ to, weight }) => {
      const nextDist = dist + weight
      if (nextDist < (distances.get(to) ?? Infinity)) {
        distances.set(to, nextDist)
        previous.set(to, current)
        queue.push({ nodeId: to, dist: nextDist })
      }
    })
  }

  if (!distances.has(endId)) return null

  const path = [endId]
  let current = endId
  while (previous.has(current)) {
    current = previous.get(current)
    path.unshift(current)
  }

  return path
}

function appendRouteCoordinate(path, coord) {
  const last = path[path.length - 1]
  if (!last || haversineMeters(last, coord) > 0.2) {
    path.push(coord)
  }
}

function nodePathToCoordinates(graphNodes, edges, nodeIds, startPoint, endPoint) {
  if (!nodeIds?.length) return null

  const edgeByPair = new Map()
  edges.forEach((edge) => {
    edgeByPair.set(`${edge.from}-${edge.to}`, edge)
  })

  const path = [startPoint]

  for (let i = 0; i < nodeIds.length - 1; i += 1) {
    const fromId = nodeIds[i]
    const toId = nodeIds[i + 1]
    const edge = edgeByPair.get(`${fromId}-${toId}`)

    if (edge?.coordinates?.length >= 2) {
      edge.coordinates.forEach((coord) => appendRouteCoordinate(path, coord))
    } else {
      appendRouteCoordinate(path, graphNodes[toId])
    }
  }

  appendRouteCoordinate(path, endPoint)
  return path.length >= 2 ? path : null
}

function bridgeNearbyWayEndpoints(graphNodes, edges, ways, maxBridgeMeters = 18) {
  const endpointKeys = new Set()
  ways.forEach((way) => {
    if (way.coordinates.length < 2) return
    endpointKeys.add(coordKey(way.coordinates[0]))
    endpointKeys.add(coordKey(way.coordinates[way.coordinates.length - 1]))
  })

  const endpointIds = []
  graphNodes.forEach((node, index) => {
    if (endpointKeys.has(node.key)) endpointIds.push(index)
  })

  const bridgeEdges = []
  for (let i = 0; i < endpointIds.length; i += 1) {
    for (let j = i + 1; j < endpointIds.length; j += 1) {
      const fromId = endpointIds[i]
      const toId = endpointIds[j]
      const from = graphNodes[fromId]
      const to = graphNodes[toId]
      const distance = haversineMeters(from, to)
      if (distance < 0.5 || distance > maxBridgeMeters) continue

      const bridgeWay = {
        id: `bridge-${fromId}-${toId}`,
        isCrossing: false,
        isPedestrianZone: false,
      }

      bridgeEdges.push(makeEdge(fromId, toId, from, to, bridgeWay))
      bridgeEdges.push(makeEdge(toId, fromId, to, from, bridgeWay))
    }
  }

  return bridgeEdges.length ? [...edges, ...bridgeEdges] : edges
}

export function findGraphRoute(network, fromSnap, toSnap) {
  if (!fromSnap?.point || !toSnap?.point) return null

  const { graphNodes, edges, snapNodeIds } = createRoutableGraph(network, {
    from: fromSnap,
    to: toSnap,
  })

  const startId = snapNodeIds.get('from')
  const endId = snapNodeIds.get('to')
  if (startId == null || endId == null) return null

  const nodePath = dijkstraShortestPath(graphNodes, edges, startId, endId)
  if (!nodePath) return null

  return nodePathToCoordinates(
    graphNodes,
    edges,
    nodePath,
    fromSnap.point,
    toSnap.point,
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

function formatOverpassError(text, status) {
  if (!text) {
    return `Overpass request failed (${status || 'unknown'}).`
  }

  if (text.includes('404 Not Found') || text.includes('<title>404 Not Found</title>')) {
    return 'Overpass API route not found. Restart the Vite dev server (npm run dev) so the /api/overpass proxy is active.'
  }

  if (status === 504 || text.includes('too busy') || text.includes('timeout')) {
    return 'Overpass server is busy. Trying another mirror...'
  }

  const runtimeMatch = text.match(/<strong[^>]*>Error<\/strong>:\s*([^<]+)/i)
  if (runtimeMatch?.[1]) {
    return runtimeMatch[1].trim()
  }

  if (text.trimStart().startsWith('{')) {
    return 'Overpass returned an unexpected JSON error.'
  }

  return 'Failed to fetch pedestrian data from OpenStreetMap. Try again in a moment.'
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function queryOverpass(query, url, attempt = 1) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), OVERPASS_FETCH_TIMEOUT_MS)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Overpass request timed out. Trying another mirror...')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }

  const text = await response.text()
  const isBusy =
    response.status === 504 ||
    response.status === 429 ||
    text.includes('too busy') ||
    text.includes('timeout')

  if ((!response.ok || text.includes('runtime error')) && isBusy && attempt < 2) {
    await sleep(OVERPASS_RETRY_DELAY_MS)
    return queryOverpass(query, url, attempt + 1)
  }

  if (!response.ok || text.includes('runtime error') || text.includes('<strong')) {
    throw new Error(formatOverpassError(text, response.status))
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(formatOverpassError(text, response.status))
  }
}

function prioritizeWaysNearCenter(ways, center, maxWays = 600) {
  if (ways.length <= maxWays) return ways

  return [...ways]
    .map((way) => {
      const minDistance = way.coordinates.reduce((best, coord) => {
        const distance = haversineMeters(coord, center)
        return Math.min(best, distance)
      }, Infinity)
      return { way, minDistance, priority: way.isCrossing ? 0 : way.isPedestrianZone ? 1 : 2 }
    })
    .sort((a, b) => a.priority - b.priority || a.minDistance - b.minDistance)
    .slice(0, maxWays)
    .map((entry) => entry.way)
}

export async function fetchPedestrianNetwork(center) {
  const bbox = buildBbox(center.lat, center.lng, 110)
  const query = buildOverpassQuery(bbox)

  let data = null
  let lastError = null

  for (const url of OVERPASS_URLS) {
    try {
      data = await queryOverpass(query, url)
      break
    } catch (error) {
      lastError = error
      await sleep(300)
    }
  }

  if (!data) {
    throw new Error(
      lastError?.message ?? 'Failed to fetch pedestrian data from OpenStreetMap.',
    )
  }

  await new Promise((resolve) => window.setTimeout(resolve, 0))

  const parsed = parseOverpassElements(data)
  const ways = prioritizeWaysNearCenter(parsed.ways, center)
  const baseGraph = buildPedestrianGraph(ways)
  const edges = bridgeNearbyWayEndpoints(
    baseGraph.graphNodes,
    baseGraph.edges,
    ways,
  )
  const { graphNodes, nodeIndex } = baseGraph

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
