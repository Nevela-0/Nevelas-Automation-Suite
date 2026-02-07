import { MODULE } from '../../../common/module.js';

export function hardnessCalculation(attackDamage, eRes, damageReductions, damageTypes, damageSortObjects, itemSource, hardness, itemOptionsForSort) {
    if (hardness <= 0) return;

    function getHardnessSetting(type) {
        let setting = null;
        let inherit = true;
        if (itemOptionsForSort?.attackSettings?.hardness?.[type]) {
            const atk = itemOptionsForSort.attackSettings.hardness[type];
            if (atk.inherit === false || atk.inherit === undefined) {
                if (atk.enabled) {
                    setting = atk;
                    inherit = false;
                }
            }
        }
        if (inherit && itemOptionsForSort?.itemActionSettings?.actions?.length > 0) {
            let actionObj = null;
            if (itemOptionsForSort.actionId) {
                actionObj = itemOptionsForSort.itemActionSettings.actions.find(a => a.id === itemOptionsForSort.actionId);
            }
            if (!actionObj) actionObj = itemOptionsForSort.itemActionSettings.actions[0];
            if (actionObj?.hardness?.[type]) {
                const act = actionObj.hardness[type];
                if (act.inherit === false || act.inherit === undefined) {
                    if (act.enabled) {
                        setting = act;
                        inherit = false;
                    }
                }
            }
        }
        if (inherit && itemOptionsForSort?.globalItemSettings?.hardness?.[type]) {
            const glob = itemOptionsForSort.globalItemSettings.hardness[type];
            if (glob.enabled) {
                setting = glob;
            }
        }
        return setting;
    }

    const bypassSetting = getHardnessSetting('bypass');
    if (bypassSetting) {
        return;
    }

    const ignoreSetting = getHardnessSetting('ignore');
    let hardnessToIgnore = 0;
    if (ignoreSetting && typeof ignoreSetting.value === 'number') {
        hardnessToIgnore = ignoreSetting.value;
    }

    const booleanFlags = itemSource?.system?.flags?.boolean || {};
    const dictionaryFlags = itemSource?.system?.flags?.dictionary || {};
    let usedDeprecatedFlags = false;
    for (let key in booleanFlags) {
        if (key.toLowerCase() === "bypasshardness" && booleanFlags[key]) {
            usedDeprecatedFlags = true;
            return;
        }
    }
    for (let key in dictionaryFlags) {
        if (key.toLowerCase() === "ignorehardness") {
            const value = parseInt(dictionaryFlags[key], 10);
            if (!isNaN(value)) {
                usedDeprecatedFlags = true;
                hardnessToIgnore = Math.max(hardnessToIgnore, value); 
            }
        }
    }
    if (usedDeprecatedFlags && typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.warn(`[${MODULE.ID}] Hardness boolean/dictionary flags are deprecated and will not be supported in the future. Please update to use item options.`);
    }

    if (hardnessToIgnore > 0) {
        hardness -= hardnessToIgnore;
    }
    if (hardness <= 0) return;

    const materials = itemSource?.system?.material;
    let isAdamantine = false;
    if (materials) {
        if (materials.normal?.value?.toLowerCase() === 'adamantine' ||
            materials.addon?.includes('adamantine')) {
            isAdamantine = true;
        }
    }
    if (isAdamantine && hardness < 20) {
        return; 
    }

    let remainingHardness = hardness;
    for (let i = 0; i < damageSortObjects.length && remainingHardness > 0; i++) {
        const object = damageSortObjects[i];
        const index = object.index;
        const damageTerm = attackDamage[index];
        let damageValue = 0;
        if (damageTerm.total !== undefined) {
            damageValue = damageTerm.total;
        } else if (damageTerm.number !== undefined) {
            damageValue = damageTerm.number;
        } else {
            continue; 
        }
        const damageAfterHardness = Math.max(0, damageValue - remainingHardness);
        const hardnessUsed = damageValue - damageAfterHardness;
        remainingHardness -= hardnessUsed;
        if (damageTerm.total !== undefined) {
            attackDamage[index].total = damageAfterHardness;
        } else if (damageTerm.number !== undefined) {
            attackDamage[index].number = damageAfterHardness;
        }
    }
}



