import { setHealthCondition } from '../healthConditions.js';
import { detectHardToKillItems } from '../../utils/hardToKill.js';
import { isWoundsVigorActive } from '../../utils/woundsVigor.js';

export async function syncDiehardStability(actor, htkItems = null) {
  if (isWoundsVigorActive(actor) || actor.statuses?.has?.('dead')) return false;
  const hp = Number(actor.system?.attributes?.hp?.value ?? 0) || 0;
  const con = Number(actor.system?.abilities?.con?.total ?? actor.system?.abilities?.con?.value ?? 0) || 0;
  if (hp >= 0 || (con > 0 && hp <= -con)) return false;
  const items = htkItems ?? await detectHardToKillItems(actor);
  if (!items.diehard) return false;

  await setHealthCondition(actor, 'dying', false);

  if (!actor.statuses?.has?.('disabled') || actor.statuses?.has?.('unconscious')) {
    await setHealthCondition(actor, 'stable', true);
  }
  return true;
}
