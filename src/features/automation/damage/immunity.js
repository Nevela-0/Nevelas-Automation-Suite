export function damageImmunityCalculation(damageImmunities, attackDamage, damageSortObjects, itemOptionsForSort) {
    const diCustom = damageImmunities.custom.map(name => name.toLowerCase());
    const globalItemSettings = itemOptionsForSort?.globalItemSettings;
    const itemActionSettings = itemOptionsForSort?.itemActionSettings;
    const attackSettings = itemOptionsForSort?.attackSettings;

    damageSortObjects.forEach(object => {
        object.names.forEach(type => {
            let bypassImmunity = false;
            let typeLower = type.toLowerCase();
            if (attackDamage[object.index].total !== undefined) {
                let useAction = false;
                let useGlobal = false;
                if (attackSettings && attackSettings.immunity) {
                    if (attack.settings.immunity.inherit) {
                        useAction = true;
                    } else {
                        if (attackSettings.immunity.bypass?.enabled && Array.isArray(attackSettings.immunity.bypass.types)) {
                            if (attackSettings.immunity.bypass.types.includes('all')) {
                                bypassImmunity = true;
                            } else if (attackSettings.immunity.bypass.types.map(t => t.toLowerCase()).includes(typeLower)) {
                                bypassImmunity = true;
                            }
                        }
                    }
                } else {
                    useAction = true;
                }
                if (useAction && itemActionSettings && Array.isArray(itemActionSettings.actions)) {
                    let actionObj = null;
                    if (itemOptionsForSort.actionId) {
                        actionObj = itemActionSettings.actions.find(a => a.id === itemOptionsForSort.actionId);
                    }
                    if (!actionObj) actionObj = itemActionSettings.actions[0];
                    if (actionObj && actionObj.immunity) {
                        if (actionObj.immunity.inherit) {
                            useGlobal = true;
                        } else {
                            if (actionObj.immunity.bypass?.enabled && Array.isArray(actionObj.immunity.bypass.types)) {
                                if (actionObj.immunity.bypass.types.includes('all')) {
                                    bypassImmunity = true;
                                } else if (actionObj.immunity.bypass.types.map(t => t.toLowerCase()).includes(typeLower)) {
                                    bypassImmunity = true;
                                }
                            }
                        }
                    } else {
                        useGlobal = true;
                    }
                }
                if (useGlobal && globalItemSettings && globalItemSettings.immunity) {
                    if (globalItemSettings.immunity.bypass?.enabled && Array.isArray(globalItemSettings.immunity.bypass.types)) {
                        if (globalItemSettings.immunity.bypass.types.includes('all')) {
                            bypassImmunity = true;
                        } else if (globalItemSettings.immunity.bypass.types.map(t => t.toLowerCase()).includes(typeLower)) {
                            bypassImmunity = true;
                        }
                    }
                }
            }
            if ((damageImmunities.standard.has(type) || diCustom.has(type)) && !bypassImmunity) {
                object.amount = 0;
                if (attackDamage[object.index].total) { 
                    attackDamage[object.index].total = object.amount
                } else { 
                    attackDamage[object.index].number = object.amount
                };
            };
        });
    });
}



