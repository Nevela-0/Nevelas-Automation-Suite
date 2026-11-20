import { MODULE } from '../../../common/module.js';

const HEALTH_CONDITION_FLAG = 'healthCondition';
const HEALTH_CONDITIONS = new Set(['unconscious', 'staggered', 'dying', 'stable', 'disabled']);

export async function setHealthCondition(actor, conditionId, enabled) {
  if (!HEALTH_CONDITIONS.has(conditionId)) throw new Error(`Unsupported health condition: ${conditionId}`);

  if (enabled) {
    if (actor.statuses?.has(conditionId)) return;

    if (actor.getConditionImmunities().has(conditionId)) return;
    const tracks = pf1.registry.conditions.trackedConditions();
    const peers = tracks.filter(track => track.includes(conditionId))
      .flatMap(track => track.filter(id => id !== conditionId));

    for (const id of peers) {
      if (HEALTH_CONDITIONS.has(id)) await setHealthCondition(actor, id, false);
    }
    if (peers.some(id => actor.statuses?.has(id))) return;

    return actor.setCondition(conditionId, {
      flags: { [MODULE.ID]: { [HEALTH_CONDITION_FLAG]: conditionId } }
    });
  }

  const allowedStatuses = new Set([conditionId, ...(pf1.registry.conditions.get(conditionId)?.statuses ?? [])]);
  const ids = Array.from(actor.effects ?? []).filter(effect =>
    effect.parent === actor && !effect.origin && !effect.transfer &&
    effect.flags?.[MODULE.ID]?.[HEALTH_CONDITION_FLAG] === conditionId &&
    effect.statuses?.has(conditionId) &&
    Array.from(effect.statuses).every(id => allowedStatuses.has(id))
  ).map(effect => effect.id);
  if (ids.length) return actor.deleteEmbeddedDocuments('ActiveEffect', ids);
}
