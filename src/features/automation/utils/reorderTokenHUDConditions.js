import { MODULE } from '../../../common/module.js';

export function reorderTokenHUDConditions(html, data) {
  let conditions;
  const isV12 = typeof html.find === 'function';
  if (isV12) {
    conditions = html.find('.status-effects');
  } else {
    conditions = html.querySelectorAll('.status-effects');
  }
  const reorderAllConditions = game.settings.get(MODULE.ID, 'reorderAllConditions');
  const allConditions = pf1.registry.conditions.map(condition => condition._id);

  const conditionEffects = Object.values(data.statusEffects).filter(effect => allConditions.includes(effect.id));
  const buffEffects = Object.values(data.statusEffects).filter(effect => !allConditions.includes(effect.id) && effect.id !== "dead");
  const deadCondition = Object.values(data.statusEffects).filter(effect => effect.id === "dead");

  let sortedEffects;
  if (reorderAllConditions) {
    sortedEffects = Object.values(data.statusEffects).sort((a, b) => a.title.localeCompare(b.title));
  } else {
    const otherConditions = conditionEffects.filter(effect => effect.id !== "dead");
    sortedEffects = otherConditions.sort((a, b) => a.title.localeCompare(b.title));
  }

  if (isV12) {
    conditions.empty();
    if (deadCondition && !reorderAllConditions) {
      const deadIcon = `<img class="effect-control ${deadCondition[0].cssClass}" data-status-id="${deadCondition[0].id}" src="${deadCondition[0].src}" title="${deadCondition[0].title}"/>`;
      conditions.append(deadIcon);
    }
    for (const effect of sortedEffects) {
      const conditionIcon = `<img class="effect-control ${effect.cssClass}" data-status-id="${effect.id}" src="${effect.src}" title="${effect.title}"/>`;
      conditions.append(conditionIcon);
    }
    if (!reorderAllConditions) {
      for (const effect of buffEffects) {
        const buffIcon = `<img class="effect-control ${effect.cssClass}" data-status-id="${effect.id}" src="${effect.src}" title="${effect.title}"/>`;
        conditions.append(buffIcon);
      }
    }
  } else {
    conditions.forEach(el => {
      const icons = Array.from(el.querySelectorAll('img'));
      const iconMap = {};
      icons.forEach(img => {
        iconMap[img.dataset.statusId] = img;
      });
      let newOrder = [];
      if (deadCondition && !reorderAllConditions && deadCondition[0]) {
        if (iconMap[deadCondition[0].id]) newOrder.push(iconMap[deadCondition[0].id]);
      }
      sortedEffects.forEach(effect => {
        if (iconMap[effect.id]) newOrder.push(iconMap[effect.id]);
      });
      if (!reorderAllConditions) {
        buffEffects.forEach(effect => {
          if (iconMap[effect.id]) newOrder.push(iconMap[effect.id]);
        });
      }
      newOrder.forEach(img => el.appendChild(img));
    });
  }
}



