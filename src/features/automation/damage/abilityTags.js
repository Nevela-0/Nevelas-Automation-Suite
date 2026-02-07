import { MODULE } from '../../../common/module.js';
import { getTypeIdsFromInstance } from './instances.js';

export function getAbilityTagsForInstance(instance) {
    const typeIds = getTypeIdsFromInstance(instance);
    const tags = [];
    for (const typeId of typeIds) {
        const entry = pf1?.registry?.damageTypes?.get?.(typeId);
        const flags = entry?.flags?.[MODULE.ID];
        if (!flags?.vsAbility) continue;
        const abilities = Array.isArray(flags.abilities)
            ? flags.abilities
            : (flags.abilities ? [flags.abilities] : []);
        for (const ability of abilities) {
            tags.push({ typeId, ability, ablDmgType: flags.type });
        }
    }
    return tags;
}

export function splitAbilityInstances(instances) {
    const abilityInstances = [];
    const hpInstances = [];
    for (const instance of instances) {
        const tags = getAbilityTagsForInstance(instance);
        if (tags.length) {
            abilityInstances.push({ instance, tags });
        } else {
            hpInstances.push(instance);
        }
    }
    return { abilityInstances, hpInstances };
}

export function buildAbilityDmgEntries(abilityInstances, ratio, isHealing) {
    const abilityDmg = [];
    for (const { instance, tags } of abilityInstances) {
        const baseAmount = Math.floor((instance.value || 0) * (ratio ?? 1));
        if (!Number.isFinite(baseAmount) || baseAmount === 0) continue;
        const signedAmount = isHealing ? -Math.abs(baseAmount) : Math.abs(baseAmount);
        for (const tag of tags) {
            abilityDmg.push({
                type: tag.typeId,
                amount: signedAmount,
                vs: tag.ability,
                ablDmgType: tag.ablDmgType
            });
        }
    }
    return abilityDmg;
}
