import { MODULE } from '../module.js';
import { getModifierNames, resolveModifierNames } from './modifierNames.js';

export class ModifierNameSettingsForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'modifier-name-settings-form',
      title: game.i18n.localize("NAS.forms.modifierNames.title"),
      template: `modules/${MODULE.ID}/src/templates/modifier-name-settings-form.html`,
      width: 400,
      height: 'auto',
      closeOnSubmit: true
    });
  }

  getData() {
    return getModifierNames();
  }

  async _updateObject(event, formData) {
    const modifierNames = resolveModifierNames(formData);
    await game.settings.set(MODULE.ID, 'modifierNames', modifierNames);
    ui.notifications.info(game.i18n.localize("NAS.forms.modifierNames.savedInfo"));
  }
}
