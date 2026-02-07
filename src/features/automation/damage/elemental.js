export function elementalResistancesCalculation(eRes, attackDamage, damageTypes, damageSortObjects, itemOptionsForSort) {
    function getBypassResTypes() {
        let types = [];
        let inherit = true;
        if (itemOptionsForSort?.attackSettings?.resistance?.bypass) {
            const atk = itemOptionsForSort.attackNAS.settings.resistance.bypass;
            if (atk.inherit === false || atk.inherit === undefined) {
                if (atk.enabled && Array.isArray(atk.types)) {
                    if (atk.types.includes('all')) return ['all'];
                    types = atk.types.map(t => t.toLowerCase());
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
            if (actionObj?.resistance?.bypass) {
                const act = actionObj.resistance.bypass;
                if (act.inherit === false || act.inherit === undefined) {
                    if (act.enabled && Array.isArray(act.types)) {
                        if (act.types.includes('all')) return ['all'];
                        types = act.types.map(t => t.toLowerCase());
                        inherit = false;
                    }
                }
            }
        }
        if (inherit && itemOptionsForSort?.globalItemSettings?.resistance?.bypass) {
            const glob = itemOptionsForSort.globalItemNAS.settings.resistance.bypass;
            if (glob.enabled && Array.isArray(glob.types)) {
                if (glob.types.includes('all')) return ['all'];
                types = glob.types.map(t => t.toLowerCase());
            }
        }
        return types;
    }

    const erCustom = eRes.custom.split(';').map(name => name.toLowerCase());

    const totalER = [];
    if (erCustom.length > 0 && erCustom[0].length > 0) {
        const andOrRegex = /\b(and|or)\b/;
        const damageAmount = /\d+/;

        erCustom.forEach(string => {
            const regexResult = string.match(andOrRegex);
            const damageAmountResult = string.match(damageAmount);
            if (!damageAmountResult) return console.warn('Amount missing from reduction');
            let types = [];
            if (regexResult) {
                let splitted = string.split(regexResult[0]);
                for (let i = 0; i < splitted.length; i++) {
                    splitted[i] = splitted[i].replace('/', ' ').replace(/\d+/, '').toLowerCase().replace('dr', '').trim();
                }
                if (splitted[1] == '') {
                    splitted = splitted[0].split(' ');
                }
                types = splitted;
                totalER.push({ amount: parseInt(damageAmountResult[0]), types, operator: regexResult[0] == 'and' ? false : true })
            } else {
                let splitted = string.replace('/', ' ').replace(/\d+/, '').toLowerCase().replace('dr', '').trim();
                types = [splitted];
                totalER.push({ amount: parseInt(damageAmountResult[0]), types, operator: true })
            };
        });
    };

    const erValue = eRes.value;
    totalER.unshift(...erValue);

    const bypassResTypes = (itemOptionsForSort ? getBypassResTypes() : []);

    totalER.forEach(er => {
        let found = false;
        let remainder = {
            types: null,
            index: null,
            value: null
        };
        const shouldBypass = er.types.some(erType => {
            const erTypeLower = erType.toLowerCase();
            return damageTypes.includes(erTypeLower) || bypassResTypes.includes(erTypeLower);
        });
        if (er.operator === false) {
            for (let i = 0; i < er.types.length; i++) {
                const erType = er.types[i];
                const hasDamageType = damageTypes.includes(erType);
                const hasBypassType = bypassResTypes.includes(erType);
                const hasAllBypass = bypassResTypes.includes('all');
                if ((!hasDamageType && !hasBypassType && !hasAllBypass)) {
                    found = false;
                    break;
                } else {
                    found = true;
                };
            };
            if (found) {
                for (let j = 0; j < damageSortObjects.length; j++) {
                    const currentDamageSortObject = damageSortObjects[j];
                    if (er.types.every(type => currentDamageSortObject.names.includes(type))) {
                        if (attackDamage[currentDamageSortObject.index].total) { 
                            if (attackDamage[currentDamageSortObject.index].total-er.amount < 0) {
                                remainder.value = attackDamage[currentDamageSortObject.index].total-er.amount;
                                remainder.index = currentDamageSortObject.index
                                remainder.types = currentDamageSortObject.names

                                for (let index = 0; index < attackDamage.length; index++) {
                                    const damageRoll = attackDamage[index];
                                    if (index !== currentDamageSortObject.index) {
                                        const allDamageTypes = damageRoll.options.damageType;
                                        const exactMatch = remainder.types.every(type => allDamageTypes.includes(type));
                                        if (exactMatch) {
                                            attackDamage[index].total =  Math.max(0, attackDamage[index].total+remainder.value);
                                            if(attackDamage[index].total >= 0) {
                                                break;
                                            }
                                        };
                                    };
                                };
                            };
                            const newTotal = Math.max(0, attackDamage[currentDamageSortObject.index].total - er.amount);
                            attackDamage[currentDamageSortObject.index].total = newTotal;
                        } else { 
                            const newTotal = Math.max(0, attackDamage[currentDamageSortObject.index].number - er.amount);
                            attackDamage[currentDamageSortObject.index].number = newTotal;
                        };
                    };
                };
            };
        } else {
            for (let i = 0; i < er.types.length; i++) {
                const erType = er.types[i];
                const hasDamageType = damageTypes.includes(erType);
                const hasBypassType = bypassResTypes.includes(erType);
                const hasAllBypass = bypassResTypes.includes('all');
                if ((hasDamageType && !hasBypassType && !hasAllBypass)) {
                    for (let j = 0; j < damageSortObjects.length; j++) {
                        const currentDamageSortObject = damageSortObjects[j];
                        if (currentDamageSortObject.names.includes(erType)) {
                            if (attackDamage[currentDamageSortObject.index].total) {
                                if (attackDamage[currentDamageSortObject.index].total-er.amount < 0) {
                                    remainder.value = attackDamage[currentDamageSortObject.index].total-er.amount;
                                    remainder.index = currentDamageSortObject.index
                                    remainder.types = currentDamageSortObject.names

                                    for (let index = 0; index < attackDamage.length; index++) {
                                        const damageRoll = attackDamage[index];
                                        if (index !== currentDamageSortObject.index) {
                                            const allDamageTypes = damageRoll.options.damageType;
                                            const exactMatch = remainder.types.every(type => allDamageTypes.includes(type));
                                            if (exactMatch) {
                                                attackDamage[index].total =  Math.max(0, attackDamage[index].total+remainder.value);
                                                if(attackDamage[index].total >= 0) {
                                                    break;
                                                }
                                            };
                                        };
                                    };
                                };
                                const newTotal = Math.max(0, attackDamage[currentDamageSortObject.index].total - er.amount);
                                attackDamage[currentDamageSortObject.index].total = newTotal;
                                break;
                            } else {
                                const newTotal = Math.max(0, attackDamage[currentDamageSortObject.index].number - er.amount);
                                attackDamage[currentDamageSortObject.index].number = newTotal;
                                break;

                            };
                        };
                    };
                    break;
                };
            };
        };
    });
}



