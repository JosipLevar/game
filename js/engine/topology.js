// engine/topology.js
// The network is stored as a flat nodes[]/edges[] list, but every
// electrical calculation needs it as a tree rooted at the transformer.
// This module is the ONLY place that walks the graph — load-flow,
// interventions and scoring all go through here so there is exactly one
// implementation of "who is downstream of what".

/**
 * Build an undirected adjacency list from edges, then BFS from the
 * transformer to derive parent/child direction. We deliberately do NOT
 * trust edge.fromNodeId/toNodeId as "parent->child" — after a transfer-load
 * intervention that direction may no longer match the actual tree shape,
 * so direction is always re-derived from root on every recalculation.
 *
 * Returns null if the graph is not a valid single tree covering every
 * node (disconnected node, or a cycle producing an unreachable branch).
 */
export function buildTopology(network) {
  const rootId = network.transformer.id;
  const adjacency = new Map(); // nodeId -> [{neighborId, edgeId}]

  for (const node of network.nodes) adjacency.set(node.id, []);

  for (const edge of network.edges) {
    if (!adjacency.has(edge.fromNodeId) || !adjacency.has(edge.toNodeId)) {
      return { valid: false, reason: 'dangling-edge', edgeId: edge.id };
    }
    adjacency.get(edge.fromNodeId).push({ neighborId: edge.toNodeId, edgeId: edge.id });
    adjacency.get(edge.toNodeId).push({ neighborId: edge.fromNodeId, edgeId: edge.id });
  }

  const parentOf = new Map();     // nodeId -> parentNodeId
  const edgeToParent = new Map(); // nodeId -> edgeId (edge connecting node to its parent)
  const edgeToChild = new Map();  // edgeId -> childNodeId (the downstream end of that edge)
  const children = new Map();     // nodeId -> [nodeId]
  const order = [];               // BFS visit order, root first
  const depth = new Map();

  for (const node of network.nodes) children.set(node.id, []);

  const visited = new Set([rootId]);
  const queue = [rootId];
  depth.set(rootId, 0);
  order.push(rootId);

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = adjacency.get(current) || [];
    for (const { neighborId, edgeId } of neighbors) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      parentOf.set(neighborId, current);
      edgeToParent.set(neighborId, edgeId);
      edgeToChild.set(edgeId, neighborId);
      children.get(current).push(neighborId);
      depth.set(neighborId, depth.get(current) + 1);
      order.push(neighborId);
      queue.push(neighborId);
    }
  }

  if (visited.size !== network.nodes.length) {
    return { valid: false, reason: 'disconnected-node' };
  }
  // A valid tree over N nodes has exactly N-1 edges. More means a cycle;
  // fewer means we already caught it as disconnected above.
  if (network.edges.length !== network.nodes.length - 1) {
    return { valid: false, reason: 'cycle-or-orphan-edge' };
  }

  return {
    valid: true,
    rootId,
    parentOf,
    edgeToParent,
    edgeToChild,
    children,
    order,
    depth
  };
}

/** Ordered list of edge IDs from a node up to (not including) the root. */
export function getPathEdgesToRoot(nodeId, topo) {
  const path = [];
  let current = nodeId;
  while (topo.parentOf.has(current)) {
    path.push(topo.edgeToParent.get(current));
    current = topo.parentOf.get(current);
  }
  return path; // ordered nearest-edge-first; caller reverses if needed
}

/** All node IDs in the subtree rooted at nodeId, inclusive of nodeId itself. */
export function getSubtreeNodeIds(nodeId, topo) {
  const result = [];
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    result.push(current);
    for (const child of topo.children.get(current) || []) stack.push(child);
  }
  return result;
}

/** All loads whose node lies in the subtree downstream of the given edge. */
export function getDownstreamLoads(edgeId, network, topo) {
  const childNodeId = topo.edgeToChild.get(edgeId);
  if (!childNodeId) return [];
  const subtreeNodeIds = new Set(getSubtreeNodeIds(childNodeId, topo));
  return network.loads.filter((load) => subtreeNodeIds.has(load.nodeId));
}

/**
 * Would re-attaching `movingNodeId` (and everything below it) under
 * `targetNodeId` create a cycle? True if the target is the moving node
 * itself or anywhere in its own subtree — you cannot become your own
 * ancestor.
 */
export function wouldCreateCycle(movingNodeId, targetNodeId, topo) {
  if (movingNodeId === targetNodeId) return true;
  const subtree = new Set(getSubtreeNodeIds(movingNodeId, topo));
  return subtree.has(targetNodeId);
}

/** The feeder root (direct child of TS) that a node hangs off, or null for the TS node itself. */
export function getFeederRootForNode(nodeId, topo) {
  let current = nodeId;
  while (topo.parentOf.get(current) !== topo.rootId) {
    if (!topo.parentOf.has(current)) return null; // is root itself
    current = topo.parentOf.get(current);
  }
  return current;
}
