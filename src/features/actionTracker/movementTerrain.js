import { copy } from "./model.js";

const warning = "Region movement cost could not be verified; distance was retained but this portion did not spend actions.";
const unknown = () => ({ version: 1, source: "unavailable", multiplier: null, warning });
const keys = ["x", "y", "elevation", "width", "height", "shape"];
const position = (point) => Object.fromEntries(keys.map((key) => [key, point[key]]));

function snapshot(token, terrain, source, from, to) {
  const data = terrain?.toObject?.() ?? terrain;
  if (data && (Object.keys(data).some((key) => key !== "difficulty") || !Number.isFinite(data.difficulty) || data.difficulty < 0)) return unknown();
  const multiplier = data?.difficulty ?? 1;
  const Terrain = globalThis.CONFIG?.Token?.movement?.TerrainData;
  if (Terrain?.getMovementCostFunction) {
    const value = terrain && Terrain.fromSource ? Terrain.fromSource(data) : terrain;
    const cost = Terrain.getMovementCostFunction(token)?.(from, to, 1, { terrain: value, action: to.action,
      actionConfig: globalThis.CONFIG?.Token?.movement?.actions?.[to.action] });

    if (cost !== undefined && (!Number.isFinite(cost) || Math.abs(cost - multiplier) > 1e-8)) return unknown();
  }
  return { version: 1, source, multiplier, data: data ? copy(data) : null };
}

function regionParts(token, from, to) {
  const regions = Array.from(token.parent.regions ?? []);
  const states = [];
  const transitions = [];
  const distancePixels = token.parent.grid.size / token.parent.grid.distance;
  const distance = (p) => Math.hypot(p.x - from.x, p.y - from.y, (p.elevation - from.elevation) * distancePixels);
  for (const region of regions) {
    const effects = Array.from(region.behaviors ?? []).filter((b) => !b.disabled)
      .flatMap((b) => b.system?._getTerrainEffects?.(token, { width: to.width, height: to.height, shape: to.shape, action: to.action, preview: false }) ?? []);
    if (!effects.length) continue;
    if (typeof token.testInsideRegion !== "function" || typeof token.segmentizeRegionMovementPath !== "function") throw new Error(warning);
    const state = { effects, inside: token.testInsideRegion(region, from) };
    states.push(state);
    for (const segment of token.segmentizeRegionMovementPath(region, [from, to])) {
      if (segment.type === 0) continue;
      if (![1, -1].includes(segment.type)) throw new Error(warning);
      transitions.push({ point: { ...to, ...segment.from }, distance: distance(segment.from), state, inside: segment.type === 1 });
    }
  }
  if (!states.length) return [{ from, to, terrain: snapshot(token, null, "regions", from, to) }];
  const resolve = globalThis.CONFIG?.Token?.movement?.TerrainData?.resolveTerrainEffects;
  if (!resolve) throw new Error(warning);
  transitions.sort((a, b) => a.distance - b.distance);
  const result = [];
  let previous = from;
  const append = (end) => {
    if (keys.slice(0, 3).every((key) => previous[key] === end[key])) return;
    const terrain = resolve.call(globalThis.CONFIG.Token.movement.TerrainData, states.filter((s) => s.inside).flatMap((s) => s.effects));
    result.push({ from: previous, to: end, terrain: snapshot(token, terrain, "regions", previous, end) });
    previous = end;
  };
  for (const transition of transitions) { append(transition.point); transition.state.inside = transition.inside; }
  append(to);
  return result;
}

export function terrainMovementParts(token, from, to, { confirmed = false, teleport = false } = {}) {
  try {
    if (teleport) return [{ from, to, terrain: { version: 1, source: "displacement", multiplier: 0, data: null } }];

    if (confirmed && (to.terrain != null || (Number.isFinite(to.cost) && to.cost > 0))) {
      return [{ from, to, terrain: snapshot(token, to.terrain ?? null, "confirmed", from, to) }];
    }
    return regionParts(token, from, to);
  } catch { return [{ from, to, terrain: unknown() }]; }
}

export function terrainRecord(part, token) {
  const record = { ...copy(part.terrain), positions: [position(part.from), position(part.to)] };
  if (!token || record.warning) return record;
  try {
    const grid = token.parent.grid;
    let origin = part.from;
    const target = part.to;
    if (["width", "height", "shape"].some((key) => origin[key] !== target[key])) {
      const center = token.getCenterPoint(origin), pivot = token.getCenterPoint({ ...target, x: 0, y: 0, elevation: 0 });
      origin = { ...target, x: center.x - pivot.x, y: center.y - pivot.y, elevation: center.elevation - pivot.elevation };
    }
    record.measurementPoints = [origin, target].map((p) => {
      let { x, y, elevation } = p;
      const snapped = token.getSnappedPosition?.(p);
      if (snapped && Math.round(snapped.x) === Math.round(x) && Math.round(snapped.y) === Math.round(y)) ({ x, y } = snapped);
      else { x = Math.round(x); y = Math.round(y); }
      if (grid.type === 1) {

        x += grid.size * (Number.isInteger(p.width) ? 0.5 : 0.25);
        y += grid.size * (Number.isInteger(p.height) ? 0.5 : 0.25);
      } else if (grid.type > 1) {
        const BaseToken = globalThis.foundry?.documents?.BaseToken;
        const { anchor } = BaseToken._getHexagonalOffsets(p.width, p.height, p.shape, grid.columns);
        x += grid.sizeX * anchor.x; y += grid.sizeY * anchor.y;
      }
      return { x, y, elevation };
    });
  } catch { Object.assign(record, unknown()); }
  return record;
}

export function terrainCost(operation, ledger = { operations: [operation] }) {
  if (!operation.terrain) return undefined;  
  const multiplier = operation.terrain.multiplier;
  if (operation.teleport) return 0;
  if (operation.terrain.warning || !Number.isFinite(multiplier) || multiplier < 0) return null;
  try {
    const classes = globalThis.foundry?.grid;
    const Grid = operation.config.type === 0 ? classes?.GridlessGrid : operation.config.type === 1 ? classes?.SquareGrid : classes?.HexagonalGrid;
    if (!Grid) return null;
    const chain = ledger.operations.filter((op) => op.chainId === operation.chainId && op.kind === "move" && !op.reversed);
    const points = [];
    let start = 0;
    for (const op of chain) {
      const path = op.terrain?.measurementPoints ?? op.points;
      if (!points.length) points.push(path[0]);
      else if (["x", "y", "elevation"].some((key) => points.at(-1)[key] !== path[0][key])) {

        points.push({ ...path[0], measure: false });
      }
      if (op === operation) start = points.length - 1;
      for (const p of path.slice(1)) points.push({ ...p, cost: (_from, _to, distance) => distance * (op === operation ? multiplier : 0) });
      if (op === operation) break;
    }
    const cost = new Grid(operation.config).measurePath(points).segments.slice(start).reduce((n, s) => n + s.cost, 0);
    return Number.isFinite(cost) && cost >= 0 ? cost : null;
  } catch { return null; }
}

export function terrainSummary(operations, checkpointId) {
  const groups = [];
  for (const op of operations) {
    if (op.checkpointId !== checkpointId || op.kind !== "move" || op.excluded || op.reversed || !op.terrain) continue;
    let group = groups.find((g) => g.units === op.config.units);
    if (!group) groups.push(group = { units: op.config.units, distance: 0, cost: 0, incomplete: false, multipliers: [] });
    group.distance += op.distance;
    if (Number.isFinite(op.terrain.cost)) group.cost += op.terrain.cost;
    else group.incomplete = true;
    if (Number.isFinite(op.terrain.multiplier) && !group.multipliers.includes(op.terrain.multiplier)) group.multipliers.push(op.terrain.multiplier);
  }
  return groups;
}
