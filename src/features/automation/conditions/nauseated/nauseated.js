import { MODULE } from '../../../../common/module.js';

export function handleNauseatedPreActionUse(action) {
  const actionType = action.action.activation?.type;
  const token = action.token;
  const actor = token?.actor;
  const nauseatedHandling = game.settings.get(MODULE.ID, 'nauseatedHandling');
  if (nauseatedHandling && actor?.statuses.has("nauseated")) {
    if (nauseatedHandling === "disabled") return;
    if (nauseatedHandling === "strict" && actionType !== "move") {
      action.shared.reject = true;
      ui.notifications.info(game.i18n.format('NAS.conditions.main.NauseatedStrict', { name: token.name }));
      return;
    } else if (nauseatedHandling === "lenient") {
      ui.notifications.info(game.i18n.format('NAS.conditions.main.NauseatedLenient', { name: token.name }));
    }
  }
}

export function handleNauseatedPreConcentration(rollContext) {
  const nauseatedHandling = game.settings.get(MODULE.ID, 'nauseatedHandling');
  if (nauseatedHandling && rollContext.token?.actor?.statuses?.has("nauseated")) {
    if (nauseatedHandling === "disabled") return true; 
    const token = rollContext.token;
    if (nauseatedHandling === "strict") {
      ui.notifications.info(game.i18n.format('NAS.conditions.main.NauseatedStrict', { name: token.name }));
      return false; 
    } else if (nauseatedHandling === "lenient") {
      ui.notifications.info(game.i18n.format('NAS.conditions.main.NauseatedLenient', { name: token.name }));
    }
  }
}



