import { MODULE } from '../../../../common/module.js';
import { hasWvHealthUpdate, isWoundsVigorActive, isWvNoWoundsActor, shouldBeStaggeredFromWv } from '../../utils/woundsVigor.js';

const WV_STAGGERED_FLAG = 'wvThresholdStaggered';

export async function handleWoundsVigorThresholdSync(actorDocument, change) {
  if (!actorDocument?.isOwner) return;
  if (!isWoundsVigorActive(actorDocument)) return;
  if (isWvNoWoundsActor(actorDocument)) return;
  if (!hasWvHealthUpdate(change)) return;

  const shouldStagger =
    shouldBeStaggeredFromWv(actorDocument) &&
    !actorDocument.statuses?.has?.('dead') &&
    !actorDocument.statuses?.has?.('unconscious');

  const hasStaggered = actorDocument.statuses?.has?.('staggered');
  const wasFromWv = Boolean(actorDocument.getFlag(MODULE.ID, WV_STAGGERED_FLAG));

  if (shouldStagger) {
    if (!hasStaggered) {
      await actorDocument.setCondition('staggered', true);
    }
    if (!wasFromWv) {
      await actorDocument.setFlag(MODULE.ID, WV_STAGGERED_FLAG, true);
    }
    return;
  }

  if (wasFromWv && hasStaggered) {
    await actorDocument.setCondition('staggered', false);
  }
  if (wasFromWv) {
    await actorDocument.unsetFlag(MODULE.ID, WV_STAGGERED_FLAG);
  }
}
