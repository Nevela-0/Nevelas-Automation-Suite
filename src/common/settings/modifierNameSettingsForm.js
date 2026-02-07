import { MODULE } from '../module.js';

export class ModifierNameSettingsForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'modifier-name-settings-form',
      title: 'Customize Buff/Spell Modifiers',
      template: `modules/${MODULE.ID}/src/templates/modifier-name-settings-form.html`,
      width: 400,
      height: 'auto',
      closeOnSubmit: true
    });
  }

  getData() {
    const modifierNames = game.settings.get(MODULE.ID, 'modifierNames') || {};
    modifierNames.lesser ||= 'Lesser';
    modifierNames.minor ||= 'Minor';
    modifierNames.improved ||= 'Improved';
    modifierNames.greater ||= 'Greater';
    modifierNames.major ||= 'Major';
    modifierNames.supreme ||= 'Supreme';
    modifierNames.mass ||= 'Mass';
    modifierNames.communal ||= 'Communal';
    return modifierNames;
  }

  async _updateObject(event, formData) {
    const modifierNames = {
      lesser: formData.lesser?.trim() || 'Lesser',
      minor: formData.minor?.trim() || 'Minor',
      improved: formData.improved?.trim() || 'Improved',
      greater: formData.greater?.trim() || 'Greater',
      major: formData.major?.trim() || 'Major',
      supreme: formData.supreme?.trim() || 'Supreme',
      mass: formData.mass?.trim() || 'Mass',
      communal: formData.communal?.trim() || 'Communal'
    };
    await game.settings.set(MODULE.ID, 'modifierNames', modifierNames);
    ui.notifications.info(`${MODULE.NAME} | Saved custom modifier names.`);
  }
}



