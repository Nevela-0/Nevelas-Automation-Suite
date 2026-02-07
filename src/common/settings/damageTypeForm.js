import { MODULE } from '../module.js';
import { EditDamageType } from './editDamageType.js';

export class DamageTypeFormApplication extends FormApplication {
    constructor(...args) {
        super(...args);
        this.customData = {
            name: "", img: "", category: "", abbr: "", icon: "", isModifier: false, color: "#000000", flag: ""
        };
        this.savedDamageTypes = game.settings.get(MODULE.ID, "customDamageTypes");
    }
  
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "damage-type-form",
            title: game.i18n.localize("NAS.settings.customSetting.name"),
            template: `modules/${MODULE.ID}/src/templates/custom-damage-type-form.html`,
            width: 600,
            height: "auto",
            closeOnSubmit: true
        });
    }
  
    getData() {
        return {
            customData: this.customData,
            savedDamageTypes: this.savedDamageTypes,
            hassavedDamageTypes: this.savedDamageTypes.length > 0 
        };
    }
  
    activateListeners(html) {
        super.activateListeners(html);
        html.find('button[name="save"]').click(this._onSave.bind(this));
        html.find('button[name="clear"]').click(this._onClear.bind(this));
        html.find('button.file-picker').click(this._onFilePicker.bind(this));
        html.find('button.edit-btn').click(this._onEdit.bind(this));
        html.find('button.delete-btn').click(this._onDelete.bind(this));
        
        html.find('input[name="custom-category"]').on('focus', this._onCustomCategoryFocus.bind(this));

        html.find('input[name="flag-type"]').on('click', this._onRadioClick.bind(this));
    
        html.find('input[name="custom-category"]').on('focus', this._onCustomCategoryFocus.bind(this));
    }
  
    _onCustomCategoryFocus(event) {
        $('input[name="category"]').prop('checked', false);
    }

    _onRadioClick(event) {
        const clickedRadio = $(event.currentTarget);
    
        if (this.selectedRadio && this.selectedRadio[0] === clickedRadio[0]) {
            clickedRadio.prop('checked', false);
            this.selectedRadio = null; 
        } else {
            this.selectedRadio = clickedRadio;
        }
    }
  
    async _onSave(event) {
        event.preventDefault(); 
        const form = $(event.currentTarget).parents("form")[0]; 
        const name = form.name.value.capitalize().trim();
        const img = form.img.value.trim();
        let category = form.category.value.trim();
        const customCategory = form["custom-category"].value.trim();
        if (customCategory) {
            category = customCategory.toLowerCase().trim()
        }
        const abbr = form.abbr.value.trim();
        const icon = form.icon.value.trim();
        const color = form.color.value; 
        const isModifier = form.isModifier.checked;
  
        const flagType = form["flag-type"].value;
        const flagAbility = form["flag-ability"].value;
        let vsAbility = false;
        let abilities = [];

        if (flagType && !flagAbility) {
            return ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.selectAbility"));
        }

        if (!flagType && flagAbility) {
            ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.flagTypeRequired"));
            return;
        }
  
        if (flagType && flagAbility) {
            vsAbility = true;
            abilities.push(flagAbility); 
        }
    
        const flags = {
            [MODULE.ID]: {
                vsAbility: vsAbility,
                abilities: abilities.join(','), 
                type: flagType || "" 
            }
        };
  
        if (!name) return ui.notifications.error(game.i18n.localize("NAS.common.errors.nameRequired"));
        if (!img && !icon) return ui.notifications.error(game.i18n.localize("NAS.common.errors.imgOrIconRequired"));
        if (!category) return ui.notifications.error(game.i18n.localize("NAS.common.errors.categoryRequired"));
  
        const key = name.toLowerCase(); 
        const newDamageType = {
            key,
            value: {
                name,
                img,
                category,
                flags,
                namespace: MODULE.ID,
                _id: key,
                abbr,
                icon,
                isModifier,
                color
            }
        };
  
        this.savedDamageTypes.push(newDamageType);
        await game.settings.set(MODULE.ID, "customDamageTypes", this.savedDamageTypes);
        this.render(); 
              
        this._promptReload();
    }
  
    async _onClear(event) {
        event.preventDefault(); 
        const dialog = new Dialog({
            title: game.i18n.localize("NAS.forms.damageTypeForm.clearTitle"),
            content: `<p>${game.i18n.localize("NAS.common.confirmations.clearAll")}</p>`,
            buttons: {
                yes: {
                    icon: '<i class="fas fa-check"></i>',
                    label: game.i18n.localize("NAS.common.buttons.yes"),
                    callback: async () => {
                        await game.settings.set(MODULE.ID, "customDamageTypes", []);
                        this.savedDamageTypes = game.settings.get(MODULE.ID, "customDamageTypes");
                        this.render(); 
                    }
                },
                no: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("NAS.common.buttons.no")
                }
            },
            default: "no"
        });
        dialog.render(true);
    }
  
    async _onFilePicker(event) {
        event.preventDefault(); 
        const options = {}; 
        const filePicker = new FilePicker({
            type: event.currentTarget.dataset.type,
            current: this.form.img.value,
            callback: path => {
                this.form.img.value = path; 
            },
            options: options
        });
    }
  
    async _onEdit(event) {
        event.preventDefault(); 
        const index = event.currentTarget.dataset.index; 
        const item = this.savedDamageTypes[index]; 
    
        new EditDamageType(item, index, async (newValues) => {
            const key = newValues.name.toLowerCase(); 
    
            this.savedDamageTypes[index] = {
                key,
                value: {
                    ...newValues,
                    flags: {
                        ...item.value.flags, 
                        [MODULE.ID]: {
                            ...item.value.flags[MODULE.ID], 
                            ...newValues.flags[MODULE.ID], 
                        }
                    },
                    namespace: MODULE.ID,
                    _id: key,
                    color: newValues.color 
                }
            };
    
            await game.settings.set(MODULE.ID, "customDamageTypes", this.savedDamageTypes);
            this.render(); 
    
            this._promptReload();
        }).render(true);
    }
  
    _promptReload() {
        new Dialog({
            title: game.i18n.localize("NAS.common.confirmations.reloadRequired"),
            content: `<p>${game.i18n.localize("NAS.common.confirmations.reload")}</p>`,
            buttons: {
                yes: {
                    icon: '<i class="fas fa-check"></i>',
                    label: game.i18n.localize("NAS.common.buttons.yes"),
                    callback: () => window.location.reload()
                },
                no: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("NAS.common.buttons.no")
                }
            },
            default: "yes"
        }).render(true);
    }
  
    async _onDelete(event) {
        event.preventDefault(); 
        const index = event.currentTarget.dataset.index; 
        const item = this.savedDamageTypes[index]; 
        const dialog = new Dialog({
            title: game.i18n.localize("NAS.forms.damageTypeForm.deleteTitle").replace("{value}", item.value.name),
            content: `<p>${game.i18n.localize("NAS.common.confirmations.deleteValue").replace("{value}", item.value.name)}</p>`,
            buttons: {
                yes: {
                    icon: '<i class="fas fa-check"></i>',
                    label: game.i18n.localize("NAS.common.buttons.yes"),
                    callback: async () => {
                        this.savedDamageTypes.splice(index, 1);
                        await game.settings.set(MODULE.ID, "customDamageTypes", this.savedDamageTypes);
                        this.render(); 
                    }
                },
                no: {
                    icon: '<i class="fas fa-times"></i>',
                    label: game.i18n.localize("NAS.common.buttons.no")
                }
            },
            default: "no"
        });
        dialog.render(true);
    }
  
    async _updateObject(event, formData) {
    }
}



