import { MODULE } from '../../../../common/module.js';
import { getNewHp, hasHpUpdate } from '../../utils/healthUpdates.js';

export async function handleDeadOnUpdate(actorDocument, change) {
  const deadConditionSetting = game.settings.get(MODULE.ID, 'applyDeadCondition');

  if (deadConditionSetting !== 'none' && hasHpUpdate(change)) {
    const newHp = getNewHp(actorDocument, change);
    const conScore = actorDocument.system.abilities.con.total;
    const isNPC = actorDocument.type === 'npc';
    
    let shouldApply = false;
    
    if (deadConditionSetting === 'everyone') {
      shouldApply = newHp <= -conScore;
    } else if (deadConditionSetting === 'npc' && isNPC) {
      shouldApply = newHp <= -conScore;
    } else if (deadConditionSetting === 'player' && !isNPC) {
      shouldApply = newHp <= -conScore;
    } else if (deadConditionSetting === 'player-negative-con-npc-negative-hp') {
      if (isNPC) {
        shouldApply = newHp < 0;
      } else {
        shouldApply = newHp <= -conScore;
      }
    }
    
    if (shouldApply) {
      await actorDocument.setCondition('dead', {overlay: true});
      await actorDocument.setCondition('prone', true); 
    }
  }

  const removeDeadSetting = game.settings.get(MODULE.ID, 'removeDeadCondition');
  if (removeDeadSetting !== 'disabled' && hasHpUpdate(change) && actorDocument.statuses?.has?.('dead')) {
    const newHp = getNewHp(actorDocument, change);
    const conScore = actorDocument.system.abilities.con.total;

    let shouldRemove = false;
    if (removeDeadSetting === 'aboveNegativeCon') {
      shouldRemove = newHp > -conScore;
    } else if (removeDeadSetting === 'nonNegative') {
      shouldRemove = newHp >= 0;
    }

    if (shouldRemove) {
      await actorDocument.setCondition('dead', false);
    }
  }
}



