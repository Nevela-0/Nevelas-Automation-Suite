import { MODULE } from '../../../../common/module.js';
import { getNewNegativeLevels, hasNegativeLevelUpdate } from '../../utils/healthUpdates.js';

export async function handleEnergyDrainOnUpdate(actorDocument, change) {
  if (game.settings.get(MODULE.ID, 'autoApplyED') && hasNegativeLevelUpdate(change)) {
    const newNegativeLevels = getNewNegativeLevels(actorDocument, change);
    if (newNegativeLevels > 0) {
      await actorDocument.setCondition("energyDrained", true);
    } else {
      await actorDocument.setCondition("energyDrained", false);
    }
  }
}



