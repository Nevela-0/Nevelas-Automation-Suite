import { fail } from "./model.js";

export const SPRING_VARIANTS = {
  base: { label: "Spring Attack", limit: 1, source: "Compendium.pf1.feats.Item.ugQyUpqPBDsqLyra" },
  improved: { label: "Improved Spring Attack", limit: 2, source: "Compendium.pf1.feats.Item.D5VflgZupUiegFAY" },
  greater: { label: "Greater Spring Attack", limit: 3, source: "Compendium.pf1.feats.Item.6wPjZJNZpTfGJjTR" }
};
export const MYTHIC_SPRING_SOURCE = "Compendium.pf-content.pf-feats.Item.aI82VmbB0XMsE7hn";
export function springFeats(actor) {
  const items = Array.from(actor?.items ?? []);
  const find = (source) => items.find((item) => item.type === "feat"
    && (item._stats?.compendiumSource === source || item.flags?.core?.sourceId === source));
  const evidence = Object.fromEntries(Object.entries(SPRING_VARIANTS).map(([key, value]) => [key, find(value.source)?.uuid ?? null]));
  evidence.mythic = find(MYTHIC_SPRING_SOURCE)?.uuid ?? null;
  return { evidence, highest: evidence.greater ? "greater" : evidence.improved ? "improved" : evidence.base ? "base" : null };
}

export function requireSpringFeats(actor, variant, mythic = false) {
  const feats = springFeats(actor);
  if (!feats.evidence[variant] || !SPRING_VARIANTS[variant] || (mythic && !feats.evidence.mythic)) {
    fail("missingFeat", "The actor no longer has the selected Spring Attack feat. Use a separate attack or refresh the dialog.");
  }
  return feats;
}
export function declareSpring(actor, input, userId, time) {
  const feats = springFeats(actor), variant = input.springVariant ?? feats.highest ?? "base";
  if (!SPRING_VARIANTS[variant]) fail("invalidActivity", "Choose a supported Spring Attack variant.");
  const override = input.featOverride === true, mythic = input.mythic === true;
  if (!override && (!feats.highest || SPRING_VARIANTS[variant].limit > SPRING_VARIANTS[feats.highest].limit
    || (mythic && !feats.evidence.mythic))) fail("missingFeat", "This feat was not recognized. Select the recorded manual feat override if appropriate.");
  if (input.mythicPower === true && !mythic) fail("invalidActivity", "Mythic power requires the Mythic Spring Attack enhancement.");
  return { variant, limit: SPRING_VARIANTS[variant].limit, evidence: feats.evidence, override, mythic,
    declaredBy: userId, declaredAt: time,
    mythicPower: input.mythicPower === true ? { amount: 1, userId, declaredAt: time, status: "manualDeclaration" } : null,
    attacks: [], reservations: [] };
}
export const springNextSlot = (a) => {

  const occupied = new Set(a.spring.attacks.map((r) => r.slot));
  for (let slot = 1; slot <= a.spring.limit; slot++) if (!occupied.has(slot)) return slot;
  return null;
};
export const springPenalty = (slot) => slot === 1 ? 0 : -5 * (slot - 1);
export function springWarnings(a, ledger) {
  const warnings = [], targets = new Set();
  if (a.spring.override) warnings.push("Spring Attack feat eligibility was manually overridden.");
  for (const attack of a.spring.attacks.filter((r) => !r.unlinked)) {
    const moves = attack.movementIds.map((id) => ledger.operations.find((op) => op.operationId === id));
    const feet = moves.filter((op) => op && !op.excluded && !op.reversed && !op.teleport)
      .reduce((n, op) => n + op.distance * (op.spending?.feetPerUnit ?? 0), 0);
    if (!(a.spring.mythic && attack.slot === 1) && feet < 10 - 1e-8) warnings.push(`Attack ${attack.slot}: less than ten feet of recorded movement before the attack.`);
    if (attack.targets.length !== 1) warnings.push(`Attack ${attack.slot}: target identity is unverified.`);
    for (const target of attack.targets) {
      if (targets.has(target)) warnings.push(`Attack ${attack.slot}: a creature was targeted more than once.`);
      targets.add(target);
    }
    if (attack.adjacent === true) warnings.push(`Attack ${attack.slot}: the target was adjacent at the start of the turn.`);
    else if (attack.adjacent !== false) warnings.push(`Attack ${attack.slot}: starting adjacency is unverified.`);
    if (attack.appliedPenalty !== attack.expectedPenalty) warnings.push(`Attack ${attack.slot}: expected Spring Attack modifier ${attack.expectedPenalty}; the completed roll was not changed.`);
  }
  return warnings;
}

export function captureSpringPositions(combatant) {
  const token = combatant?.token, scene = token?.parent;
  if (!token || scene?.grid?.type !== 1 || !(scene.grid.size > 0)) return null;
  const bounds = (t) => [t.x, t.y, t.width, t.height, t.elevation].every(Number.isFinite)
    ? { x: t.x, y: t.y, w: t.width * scene.grid.size, h: t.height * scene.grid.size, z: t.elevation } : null;
  return { source: bounds(token), size: scene.grid.size,
    targets: Object.fromEntries(Array.from(scene.tokens ?? []).map((t) => [t.uuid, bounds(t)])) };
}
export function springAdjacency(evidence, targets) {
  if (!evidence?.source || targets.length !== 1) return null;
  const a = evidence.source, b = evidence.targets[targets[0]];
  if (!b || a.z !== b.z) return null;
  const dx = Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w);
  const dy = Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h);

  return dx < 1e-6 && dy < 1e-6;
}
