import { MODULE } from '../module.js';

export class EditDamageType extends FormApplication {
    constructor(item, index, onSubmit) {
        super();
        this.item = item;
        this.index = index;
        this.onSubmitCallback = onSubmit;

        this.initialImg = item.value.img;
        this.initialIcon = item.value.icon;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "edit-damage-type",
            title: game.i18n.localize("NAS.forms.drTypeEditor.title"),
            template: "modules/nevelas-automation-suite/src/templates/damage-type-editor.html",
            width: 400,
            height: "auto",
            closeOnSubmit: true
        });
    }

    getData() {
        let categoryDisplay = this.item.value.category;
    
        if (!["physical", "energy", "misc"].includes(this.item.value.category)) {
            categoryDisplay = this.item.value.category.capitalize();
        }
    
        return {
            item: {
                ...this.item.value,
                category: categoryDisplay  
            },
            moduleId: MODULE.ID
        };
    }

    activateListeners(html) {
        super.activateListeners(html);
        this.selectedRadio = html.find('input[name="flag-type"]:checked');
    
        html.find(`input[name="flag-type"][value="${this.item.value.flags[MODULE.ID]?.type}"]`).prop('checked', true);
    
        html.find(`select[name="flag-ability"]`).val(this.item.value.flags[MODULE.ID]?.abilities || '');
    
        html.find('button.file-picker').click(this._onFilePicker.bind(this));
        html.find('input[name="custom-category"]').on('focus', this._onCustomCategoryFocus.bind(this));
        html.find('input[name="flag-type"]').on('click', this._onRadioClick.bind(this));
    
        html.find('button[name="save"]').on('click', (event) => {
            this._onSubmit(event);
        });
    }

    async _onFilePicker(event) {
        event.preventDefault();
        const options = {};
        const filePicker = new FilePicker({
            type: event.currentTarget.dataset.type,
            current: this.form.img.value,
            callback: (path) => {
                this.form.img.value = path;
            },
            options: options
        });
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

    async _onSubmit(event, options = {}) {
        event.preventDefault();
        const formData = new FormData(this.element.find('form')[0]);

        const name = formData.get("name").trim().capitalize();
        const img = formData.get("img").trim();
        let category = formData.get("category");
        const customCategory = formData.get("custom-category").trim();
        if (!["physical", "energy", "misc"].includes(category)) {
            category = customCategory.toLowerCase().trim()
        }

        const abbr = formData.get("abbr").trim();
        const icon = formData.get("icon").trim();
        const color = formData.get("color").trim();
        const isModifier = formData.get("isModifier") === "on";

        const flagType = formData.get("flag-type");
        const flagAbility = formData.get("flag-ability");

        let vsAbility = false;
        let abilities = "";

        if (!name) {
            ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.nameRequired"));
            return;
        }
        if (!img && !icon) {
            ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.imgOrIconRequired"));
            return;
        }
        if (!category) {
            ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.categoryRequired"));
            return;
        }
        if (flagType && !flagAbility) {
            ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.selectAbility"));
            return;
        }

        if (!flagType && flagAbility) {
            ui.notifications.error(game.i18n.localize("NAS.forms.damageTypeForm.errors.flagTypeRequired"));
            return;
        }

        if (flagType && flagAbility) {
            vsAbility = true;
            abilities = flagAbility;
        }

        const updatedFlags = {
            ...this.item.value.flags,
            [MODULE.ID]: {
                vsAbility: vsAbility,
                abilities: abilities,
                type: flagType || ""
            }
        };

        const updatedItem = {
            name,
            img: (this.initialImg && img === this.initialImg && icon && !this.initialIcon) ? "" : img, 
            category,
            abbr,
            icon: (this.initialIcon && icon === this.initialIcon && img && !this.initialImg) ? "" : icon, 
            color,
            isModifier,
            flags: updatedFlags
        };

        this.item.value = updatedItem;

        this.onSubmitCallback(updatedItem);

        let savedDamageTypes = game.settings.get(MODULE.ID, "customDamageTypes");
        savedDamageTypes[this.index] = this.item;
        await game.settings.set(MODULE.ID, "customDamageTypes", savedDamageTypes);

        this.close();
    }

    async _updateObject(event, formData) {
    }
}



