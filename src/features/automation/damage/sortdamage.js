import { MODULE } from '../../../common/module.js';

export function sortDamage(attackDamage, itemOptionsForSort) {
    const damageSortObjects = [];
    const dataActionId = itemOptionsForSort.actionId;
    const itemSource = itemOptionsForSort.itemSource;
    const damageMult = itemOptionsForSort.damageMult;
    const itemAction = itemSource?.actions?.get(dataActionId);
    const abilityDmg = [];
    
    const damageTypes = attackDamage.map((damage, index) => {
        if(damage.options?.damageType && itemSource) { 
            const dmgNames = [];
            const dmgTypes = damage.options.damageType;
            for (const [key, value] of pf1.registry.damageTypes.entries()) {
                for (const type of dmgTypes) {
                    if (type === key) {
                        const flags = value.flags?.[MODULE.ID];
                        if (!flags) {
                            dmgNames.push(type);
                        } else {
                            if (flags?.vsAbility) {
                                const vsAbility = flags?.abilities;
                                const ablType = flags?.type;
                                abilityDmg.push({ type: type, amount: Math.floor(damage.total * damageMult), vs: vsAbility, ablDmgType: ablType });
                            } else {
                                dmgNames.push(type);
                            };
                        };
                    };
                };
            };
            const alignments = itemSource?.system?.alignments;
            const materials = itemSource?.system?.material;
            const hasAmmo = itemSource?.system?.ammo;
            const rangedAction = itemAction?.isRanged;
            if (hasAmmo?.type !== "" && rangedAction) {
                let ammoItems = itemOptionsForSort.ammoItem;
                if (ammoItems) {
                    if (!Array.isArray(ammoItems)) ammoItems = [ammoItems];
                    for (const ammoItem of ammoItems) {
                        const ammoAddons = ammoItem?.system?.flags?.dictionary;
                        for (let addon in ammoAddons) {
                            if (addon.toLowerCase() == "material" || addon.toLowerCase() == "alignment") {
                                dmgNames.push(ammoAddons[addon].toLowerCase());
                            }
                        }
                    }
                }
            } else {
                const overrideMaterials = itemAction?.material?.normal?.value;
                const overrideAddons = itemAction?.material?.addon;
                const overrideAlignments = itemAction?.alignments;
                if (overrideAlignments && Object.values(overrideAlignments).some(value => value !== null)) {
                    for (const [alignment, value] of Object.entries(overrideAlignments)) {
                        if (value === true && alignments[alignment] === false) {
                            dmgNames.push(alignment);
                        } else if (value === null && alignments[alignment] === true) {
                            dmgNames.push(alignment);
                        };
                    };
                };
            
                for (const [alignment, value] of Object.entries(alignments || {})) {
                    if (value === true && !(overrideAlignments && overrideAlignments[alignment] === false)) {
                        if (!dmgNames.includes(alignment)) {
                            dmgNames.push(alignment);
                        };
                    };
                };
                if (overrideMaterials && overrideMaterials.trim() !== "") {
                    if (itemAction?.material?.custom) {
                        const customMaterials = overrideMaterials.split(',').map(name => name.trim().toLowerCase());
                        dmgNames.push(...customMaterials);
                    } else {
                        dmgNames.push(overrideMaterials);
                    };
                } else {
                    if (materials?.normal?.value) {
                        if (!materials.normal.custom) {
                            const material = materials.normal.value;
                            dmgNames.push(material);
                        } else {
                            const customMaterials = materials.normal.value.split(',').map(name => name.trim().toLowerCase());
                            dmgNames.push(...customMaterials);
                        };
                    };
                };

                if (materials?.addon?.length > 0) {
                    materials.addon.forEach(addon => {
                        if (!dmgNames.includes(addon)) {
                            dmgNames.push(addon);
                        };
                    });
                };
                
                if (overrideAddons?.length > 0) {
                    overrideAddons.forEach(addon => {
                        if (!dmgNames.includes(addon)) {
                            dmgNames.push(addon);
                        };
                    });
                };
            };
            const damageAmount = Math.floor(damage.total * damageMult);
            damage.total = damageAmount; 
            dmgNames.forEach((name, i) => {
                dmgNames[i] = name.trim().toLowerCase();
            });
            if (dmgNames.length > 0) {
                damageSortObjects.push({ names: dmgNames, amount: damageAmount, index });
            }
            return dmgNames;
        } else { 
            if (damage.class === "NumericTerm" || damage.class === "Die") {
                if (!damage.options?.flavor && !damage.options?.damageType) {
                    const dmgNames = ["untyped"]
                    const originalAmount = damage.class === "NumericTerm"
                    ? damage.number
                    : damage.results.filter(result => result.active).reduce((sum, result) => sum + result.result, 0);
                    const damageAmount = Math.floor(originalAmount * damageMult);
                    damage.total = damageAmount; 
                    
                    if (damage.class === "NumericTerm") {
                        damage.number = damageAmount;
                    }
                    
                    dmgNames.forEach((name, i) => {
                        dmgNames[i] = name.trim().toLowerCase();
                    });
                    damageSortObjects.push({ names: dmgNames, amount: damageAmount, index });
                    return dmgNames;
                } else {
                    const flavor = damage.options?.flavor;
                    const damageType = damage.options?.damageType;
                    const dmgNames = damageType ? damageType.map(name => name.trim()) : flavor.split(',').map(name => name.trim());
                    const originalAmount = damage.class === "NumericTerm"
                    ? damage.number
                    : damage.results.filter(result => result.active).reduce((sum, result) => sum + result.result, 0);
                    const damageAmount = Math.floor(originalAmount * damageMult);
                    damage.total = damageAmount; 
                    
                    if (damage.class === "NumericTerm") {
                        damage.number = damageAmount;
                    }
                    
                    dmgNames.forEach((name, i) => {
                        dmgNames[i] = name.trim().toLowerCase();
                    });
                    damageSortObjects.push({ names: dmgNames, amount: damageAmount, index });
                    return dmgNames;
                };
            };
        };
    }).flat();
    damageSortObjects.sort((a, b) => b.amount - a.amount);

    return { damageSortObjects, damageTypes, itemAction, abilityDmg };
}
