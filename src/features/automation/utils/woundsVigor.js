import { MODULE } from '../../../common/module.js';
import { getCreatureTypeState } from './creatureTypeUtils.js';

function getPf1HealthConfig() {
  return game.settings.get('pf1', 'healthConfig');
}

export function isWoundsVigorAutomationEnabled() {
  return Boolean(game.settings.get(MODULE.ID, 'enableWoundsVigorAutomation'));
}

export function isWvNoWoundsConstructUndeadEnabled() {
  return Boolean(game.settings.get(MODULE.ID, 'woundsVigorNoWoundsConstructUndead'));
}

export function actorUsesWoundsVigor(actor) {
  if (!actor) return false;
  try {
    const cfg = getPf1HealthConfig();
    return Boolean(cfg?.getActorConfig?.(actor)?.rules?.useWoundsAndVigor);
  } catch (_err) {
    return false;
  }
}

export function isWoundsVigorActive(actor) {
  if (!isWoundsVigorAutomationEnabled()) return false;
  return actorUsesWoundsVigor(actor);
}

export function getWvCreatureTypeState(actor) {
  return getCreatureTypeState(actor);
}

export function isWvNoWoundsActor(actor) {
  if (!isWoundsVigorActive(actor)) return false;
  if (!isWvNoWoundsConstructUndeadEnabled()) return false;
  const { isConstruct, isUndead } = getWvCreatureTypeState(actor);
  return isConstruct || isUndead;
}

export function getWvState(actor) {
  const attrs = actor?.system?.attributes ?? {};
  const wounds = attrs.wounds ?? {};
  const vigor = attrs.vigor ?? {};

  const woundsValue = Number(wounds.value ?? 0) || 0;
  const woundsMax = Number(wounds.max ?? 0) || 0;
  const woundThreshold = Number(wounds.threshold ?? 0) || 0;
  const vigorValue = Number(vigor.value ?? 0) || 0;
  const vigorMax = Number(vigor.max ?? 0) || 0;

  const noWounds = isWvNoWoundsActor(actor);
  // House rule: undead/construct use vigor only and are destroyed at 0 vigor.
  const isDead = noWounds ? vigorValue <= 0 : woundsValue <= 0;
  const isWounded = noWounds ? false : (!isDead && woundsValue <= woundThreshold);

  return {
    vigorValue,
    vigorMax,
    woundsValue,
    woundsMax,
    woundThreshold,
    noWounds,
    isDead,
    isWounded
  };
}

export function isWvDead(actor) {
  return getWvState(actor).isDead;
}

export function shouldBeStaggeredFromWv(actor) {
  return getWvState(actor).isWounded;
}

export function isWvWounded(actor) {
  return getWvState(actor).isWounded;
}

export function hasWvHealthUpdate(change) {
  const attrs = change?.system?.attributes;
  if (!attrs) return false;
  const hasWounds =
    attrs.wounds &&
    (attrs.wounds.value !== undefined ||
      attrs.wounds.offset !== undefined ||
      attrs.wounds.threshold !== undefined);
  const hasVigor =
    attrs.vigor &&
    (attrs.vigor.value !== undefined ||
      attrs.vigor.offset !== undefined ||
      attrs.vigor.temp !== undefined);
  return Boolean(hasWounds || hasVigor);
}
