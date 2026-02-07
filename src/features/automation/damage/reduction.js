import { moduleConfig } from '../../../common/config.js';

export function damageReductionCalculation (attackDamage, damageReductions, damageTypes, damageSortObjects, itemSource, itemAction, message, hardness, itemOptionsForSort) {
    function getBypassDRTypes() {
        const attackDR = itemOptionsForSort?.attackSettings?.damageReduction;
        if (attackDR && attackDR.inherit === false) {
            const bypass = attackDR.bypass;
            if (bypass?.enabled && Array.isArray(bypass.types)) {
                if (bypass.types.includes('all')) return ['all'];
                return bypass.types.map(t => t === 'dr-none' ? '-' : t.toLowerCase());
            }
            return [];
        }
        const actions = itemOptionsForSort?.itemActionSettings?.actions;
        if (Array.isArray(actions) && actions.length > 0) {
            let actionObj = null;
            if (itemOptionsForSort.actionId) {
                actionObj = actions.find(a => a.id === itemOptionsForSort.actionId);
            }
            if (!actionObj) actionObj = actions[0];
            const actionDR = actionObj?.damageReduction;
            if (actionDR && actionDR.inherit === false) {
                const bypass = actionDR.bypass;
                if (bypass?.enabled && Array.isArray(bypass.types)) {
                    if (bypass.types.includes('all')) return ['all'];
                    return bypass.types.map(t => t === 'dr-none' ? '-' : t.toLowerCase());
                }
                return [];
            }
        }
        const globalBypass = itemOptionsForSort?.globalItemSettings?.damageReduction?.bypass;
        if (globalBypass?.enabled && Array.isArray(globalBypass.types)) {
            if (globalBypass.types.includes('all')) return ['all'];
            return globalBypass.types.map(t => t === 'dr-none' ? '-' : t.toLowerCase());
        }
        return [];
    }

    const drCustom = damageReductions.custom.split(';');
    const totalDR = [];
    if(drCustom.length > 0 && drCustom[0].length > 0) {
        
        const andOrRegex = /\b(and|or)\b/;
        const damageAmount = /\d+/;

        drCustom.forEach(string=>{
        const regexResult = string.match(andOrRegex);
        const damageAmountResult = string.match(damageAmount);
        if(!damageAmountResult) return console.warn('Amount missing from reduction');
            let types = [];
            if(regexResult) {
                let splitted = string.split(regexResult[0]);
                for(let i=0;i<splitted.length;i++) {
                    splitted[i] = splitted[i].replace('/',' ').replace(/\d+/,'').toLowerCase().replace('dr','').trim();
                };
                if(splitted[1]=='') {
                    splitted = splitted[0].split(' ');
                };
                types = splitted;
                totalDR.push({amount:parseInt(damageAmountResult[0]),types,operator:regexResult[0]=='and'?false:true});
            } else {
                let splitted = string.replace('/',' ').replace(/\d+/,'').toLowerCase().replace('dr','').trim();
                types = [splitted];
                totalDR.push({amount:parseInt(damageAmountResult[0]), types, operator:true})
            };
        });
    };
    const damagePriorityArray = [...moduleConfig?.damageConfig?.weaponDamageTypes];
    let biggestDamageTypePriority = 0;
    if((itemSource?.type == "attack" && (itemSource?.subType == "weapon" || itemSource?.subType == "natural")) || itemSource?.type == "weapon") {
        let enhBonus = 0;
        const actionEnhBonus = itemAction?.enhancementBonus;
        const addons = itemSource.system.material?.addon;
        const hasAmmo = itemSource.system?.ammo;
        const rangedAction = itemAction?.isRanged
        if (hasAmmo?.type !== "" && rangedAction) { 
            let parser = new DOMParser();
            let doc = parser.parseFromString(message.content, 'text/html');
            let ammoElement = doc.querySelector('[data-ammo-id]');
            let ammoId = ammoElement ? ammoElement.getAttribute('data-ammo-id') : null;
            const ammoItem = itemSource.parent.items.get(ammoId);
            const api = game.modules.get("ckl-roll-bonuses")?.api;
            if(api) {
                const dataActionId = itemOptionsForSort.actionId;
                const action = itemSource?.actions?.get(dataActionId);
                const targets = [itemOptionsForSort.token];
                const enhData = api.utils.getEnhancementBonusForAction({ action, ammo: ammoItem, targets });
                enhBonus = enhData.total;
            } else {
                let ckl = ammoItem?.['ckl-roll-bonuses'] ?? {};
                if (ckl.hasOwnProperty('ammo-enhancement') || ckl.hasOwnProperty('ammo-enhancement-stacks')) {
                    const enh = +ckl['ammo-enhancement'] || 0;
                    const stacks = +ckl['ammo-enhancement-stacks'] || 0;
                    enhBonus = enh + stacks;
                } else if (actionEnhBonus > 0) {
                    enhBonus = 1;
                } else {
                    const magicFlag = ammoItem?.system?.flags?.boolean;
                    for (let key in magicFlag) {
                        if (key.toLowerCase() == "magic") {
                            enhBonus = 1;
                            break;
                        };
                    };
                };
            }
        } else { 
            if (addons?.includes("magic")) {
                enhBonus = 1;
            } else if (addons?.includes("epic") && actionEnhBonus >= 6) {
                enhBonus = Math.max(6, actionEnhBonus);
            } else {
                enhBonus = actionEnhBonus || 0;
            };
        };
        biggestDamageTypePriority = enhBonus;
    } else {
        for(let i=damagePriorityArray.length-1;i>-1;i--) {
            const currentPrioritySegment = damagePriorityArray[i];
            if(currentPrioritySegment.find(priorityType=>damageTypes.includes(priorityType))) {
                biggestDamageTypePriority = i;
                break;
            };
        };
    };
    
    if(biggestDamageTypePriority>0) {
        damagePriorityArray.splice(biggestDamageTypePriority+1);
        const flattenedTypes = damagePriorityArray.flat().map(type => type.toLowerCase().replace(/\s+/g, ''));
        damageTypes = [...new Set([...damageTypes, ...flattenedTypes])];
    };
    
    const drValue = damageReductions.value;
    totalDR.unshift(...drValue);
    let highestDR = 0
    for(let i=0;i<totalDR.length;i++) {
        totalDR.forEach(dr => {
            if (dr.types.length === 2 && dr.types[0] === "" && dr.types[1] === "") {
                dr.types = ["-"];
            } else if (dr.types.length === 0) {
                dr.types = ["-"];
            } else {
                dr.types = dr.types.filter(type => type !== "");
            }
            if(dr.amount > highestDR) {
                highestDR = dr.amount;
            };
        });
    };
    let appliedDR = false;

    const bypassDRTypes = (itemOptionsForSort ? getBypassDRTypes() : []);

    totalDR.forEach(dr => {
        const allWeaponDamageTypes = [...moduleConfig?.damageConfig?.weaponDamageTypes,...moduleConfig?.damageConfig?.additionalPhysicalDamageTypes].flat(2);

        let remainder = {
            types: null,
            index: null,
            value: null
        };

        const shouldBypass = dr.types.some(drType => {
            const drTypeLower = drType.toLowerCase();
            return damageTypes.includes(drTypeLower) || bypassDRTypes.includes(drTypeLower);
        });

        if(dr.operator == false) {
            for(let i = 0; i < dr.types.length ;i++) {
                const drType = dr.types[i].toLowerCase();
                const hasDamageType = damageTypes.includes(drType);
                const hasBypassType = bypassDRTypes.includes(drType);
                const hasAllBypass = bypassDRTypes.includes('all');
                if((!hasDamageType && !hasBypassType && !hasAllBypass) && dr.amount == highestDR && !appliedDR) { 
                    let found = false;
                    for(let i=0;i<damageSortObjects.length;i++) {
                        const currentDamageSortObject = damageSortObjects[i];
                        for(let t=0;t<allWeaponDamageTypes.length;t++) {
                            const currentWeaponDamageType = allWeaponDamageTypes[t];
                            if(currentDamageSortObject.names.includes(currentWeaponDamageType)) {
                                found = true;
                                if (attackDamage[currentDamageSortObject.index].total) { 
                                    if (attackDamage[currentDamageSortObject.index].total-dr.amount < 0) {
                                        remainder.value = attackDamage[currentDamageSortObject.index].total-dr.amount;
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
                                    attackDamage[currentDamageSortObject.index].total = Math.max(0, attackDamage[currentDamageSortObject.index].total-dr.amount);
                                    break;
                                } else { 
                                    attackDamage[currentDamageSortObject.index].number = Math.max(0, attackDamage[currentDamageSortObject.index].number-dr.amount);
                                    break;
                                };
                            };
                        };
                        if(found) break;
                    };
                    appliedDR = true;
                    break;
                };
            };
        
        } else {
            let passes = 0
            for(let i = 0; i < dr.types.length ;i++) {
                const drType = dr.types[i].toLowerCase();
                const typeIndex = damageTypes.includes(drType);
                const bypassIndex = bypassDRTypes.includes(drType);
                const hasAllBypass = bypassDRTypes.includes('all');
                if((!typeIndex && !bypassIndex && !hasAllBypass)) {
                    passes++
                    if((passes == 2||dr.types.length==1) && dr.amount == highestDR && !appliedDR) {
                        let found = false;
                        for(let i=0;i<damageSortObjects.length;i++) {
                            const currentDamageSortObject = damageSortObjects[i];
                            for(let t=0;t<allWeaponDamageTypes.length;t++) {
                                const currentWeaponDamageType = allWeaponDamageTypes[t];
                                if(currentDamageSortObject.names.includes(currentWeaponDamageType)) {
                                    found = true;
                                    if (attackDamage[currentDamageSortObject.index].total) { 
                                        if (attackDamage[currentDamageSortObject.index].total-dr.amount < 0) {
                                            remainder.value = attackDamage[currentDamageSortObject.index].total-dr.amount;
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
                                        attackDamage[currentDamageSortObject.index].total = Math.max(0, attackDamage[currentDamageSortObject.index].total-dr.amount);
                                        break;
                                    } else { 
                                        attackDamage[currentDamageSortObject.index].number = Math.max(0, attackDamage[currentDamageSortObject.index].number-dr.amount);
                                        break;

                                    };
                                };
                            };
                            appliedDR = true;
                            if(found) break;
                        };
                    };
                };
            };
        };
    });
};
