export function hasHpUpdate(updateData) {
  return updateData.system && 
         updateData.system.attributes && 
         updateData.system.attributes.hp && 
         (updateData.system.attributes.hp.value !== undefined || updateData.system.attributes.hp.offset !== undefined);
}

export function getNewHp(actor, updateData) {
  if (updateData.system.attributes.hp.value !== undefined) {
    return updateData.system.attributes.hp.value;
  }
  else if (updateData.system.attributes.hp.offset !== undefined) {
    return actor.system.attributes.hp.value;
  }
  return actor.system.attributes.hp.value;
}

export function hasNegativeLevelUpdate(updateData) {
  return updateData.system && 
         updateData.system.attributes && 
         updateData.system.attributes.energyDrain !== undefined;
}

export function getNewNegativeLevels(actor, updateData) {
  return updateData.system.attributes.energyDrain;
}
