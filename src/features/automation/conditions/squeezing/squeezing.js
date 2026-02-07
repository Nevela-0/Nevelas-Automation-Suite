import { MODULE } from '../../../../common/module.js';

export function handleSqueezingPreActionUse(action) {
  const actionType = action.action.activation?.type;
  const token = action.token;
  const actor = token?.actor;
  const squeezingHandling = game.settings.get(MODULE.ID, 'squeezingHandling');
  if (squeezingHandling && actor?.statuses.has("squeezing")) {
    if (squeezingHandling === "disabled") return;
    if (squeezingHandling === "strict" && (actionType === "attack" || actionType === "aoo")) {
      action.shared.reject = true;
      ui.notifications.info(game.i18n.format('NAS.conditions.main.SqueezingStrict', { name: token.name }));
    } else if (squeezingHandling === "lenient") {
      ui.notifications.info(game.i18n.format('NAS.conditions.main.SqueezingLenient', { name: token.name }));
    }
  }
}



