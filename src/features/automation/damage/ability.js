import { MODULE } from '../../../common/module.js';

export function abilityDamageCalculation(damageImmunities, conditionImmunities, abilities, abilityDmg) {
    if (!abilityDmg || abilityDmg.length === 0) return;
    const translations = game.settings.get(MODULE.ID, "translations") || {};
    const constructTranslation = translations.construct || "Construct Traits";
    const undeadTranslation = translations.undead || "Undead Traits";
    const abilityFullNames = { 
        str: translations.str || "Strength",
        dex: translations.dex || "Dexterity",
        con: translations.con || "Constitution",
        int: translations.int || "Intelligence",
        wis: translations.wis || "Wisdom",
        cha: translations.cha || "Charisma"
    };
    const reverseAbilityMap = Object.entries(abilityFullNames).reduce((acc, [key, fullName]) => {
        acc[key] = key;
        acc[fullName.toLowerCase()] = key;
        return acc;
    }, {});
    const abilityPatterns = Object.entries(abilityFullNames).map(
        ([key, fullName]) => `${key}|${fullName}`
    ).join("|");
    const patterns = {
        allAbilities: /^All Ability Damage$/i,
        allDamage: /^Ability Damage$/i,
        allDrain: /^Ability Drain$/i,
        allPenalty: /^Ability Penalty$/i,
        keyDamage: new RegExp(`^(${abilityPatterns}) Damage$`, "i"),
        keyDrain: new RegExp(`^(${abilityPatterns}) Drain$`, "i"),
        keyPenalty: new RegExp(`^(${abilityPatterns}) Penalty$`, "i"),
        allKey: new RegExp(`^All (${abilityPatterns}) Damage$`, "i"),
        mentalDamage: /^Mental Ability Damage$/i,
        mentalDrain: /^Mental Ability Drain$/i,
        mentalPenalty: /^Mental Ability Penalty$/i,
        allMental: /^All Mental Abilities$/i,
        physicalDamage: /^Physical Ability Damage$/i,
        physicalDrain: /^Physical Ability Drain$/i,
        physicalPenalty: /^Physical Ability Penalty$/i,
        allPhysical: /^All Physical Abilities$/i
    };
    for (const dmg of abilityDmg) {
        const { vs, amount, ablDmgType, type } = dmg;
        if (amount <= 0) continue; 

        let isImmune = false;
        if (damageImmunities.standard.find(v => v.toLowerCase() === type.toLowerCase())) {
            isImmune = true;
            break;
        }
        if (conditionImmunities.custom.some(trait => trait.toLowerCase() === constructTranslation.toLowerCase())) {
            dmg.amount = 0;
            continue;
        } else if (conditionImmunities.custom.some(trait => trait.toLowerCase() === undeadTranslation.toLowerCase())) {
            if (ablDmgType === "damage" && (vs === "str" || vs === "dex" || vs === "con")) {
                dmg.amount = 0;
            } else if (ablDmgType === "drain" || ablDmgType === "penalty") {
                dmg.amount = 0;
            }
            continue;
        }
        for (const immunity of damageImmunities.custom) {
            const matchedKey = immunity.match(patterns.keyDamage) || immunity.match(patterns.keyDrain) || immunity.match(patterns.keyPenalty);
            const immunityKey = matchedKey && reverseAbilityMap[matchedKey[1].toLowerCase()];

            if (patterns.allAbilities.test(immunity)) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.allDamage.test(immunity) && ablDmgType === "damage") {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.allDrain.test(immunity) && ablDmgType === "drain") {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.allPenalty.test(immunity) && ablDmgType === "penalty") {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.keyDamage.test(immunity) && ablDmgType === "damage" && immunityKey === vs) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.keyDrain.test(immunity) && ablDmgType === "drain" && immunityKey === vs) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.keyPenalty.test(immunity) && ablDmgType === "penalty" && immunityKey === vs) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.allKey.test(immunity) && immunityKey === vs) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.mentalDamage.test(immunity) && ablDmgType === "damage" && (vs === "int" || vs === "wis" || vs === "cha")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.mentalDrain.test(immunity) && ablDmgType === "drain" && (vs === "int" || vs === "wis" || vs === "cha")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.mentalPenalty.test(immunity) && ablDmgType === "penalty" && (vs === "int" || vs === "wis" || vs === "cha")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.allMental.test(immunity) && (vs === "int" || vs === "wis" || vs === "cha")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.physicalDamage.test(immunity) && ablDmgType === "damage" && (vs === "str" || vs === "dex" || vs === "con")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.physicalDrain.test(immunity) && ablDmgType === "drain" && (vs === "str" || vs === "dex" || vs === "con")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.physicalPenalty.test(immunity) && ablDmgType === "penalty" && (vs === "str" || vs === "dex" || vs === "con")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            } else if (patterns.allPhysical.test(immunity) && (vs === "str" || vs === "dex" || vs === "con")) {
                dmg.amount = 0;
                isImmune = true;
                break;
            }
        }
        if (!isImmune && abilities.hasOwnProperty(vs) && dmg.amount > 0) {
            switch (ablDmgType) {
                case "damage":
                    abilities[vs].damage += dmg.amount;
                    break;
                case "drain":
                    abilities[vs].drain += dmg.amount;
                    break;
                case "penalty":
                    abilities[vs].userPenalty += dmg.amount;
                    break;
            }
        }
    }
}

export function abilityDeltaCalculation(damageImmunities, conditionImmunities, abilities, abilityDmg) {
    if (!abilityDmg || abilityDmg.length === 0) return;
    const translations = game.settings.get(MODULE.ID, "translations") || {};
    const constructTranslation = (translations.construct || "Construct Traits").toLowerCase();
    const undeadTranslation = (translations.undead || "Undead Traits").toLowerCase();
    const abilityFullNames = {
        str: translations.str || "Strength",
        dex: translations.dex || "Dexterity",
        con: translations.con || "Constitution",
        int: translations.int || "Intelligence",
        wis: translations.wis || "Wisdom",
        cha: translations.cha || "Charisma"
    };
    const abilityAliasToKey = Object.entries(abilityFullNames).reduce((acc, [key, fullName]) => {
        acc[key] = key;
        acc[fullName.toLowerCase()] = key;
        return acc;
    }, {});
    const abilityPatterns = Object.entries(abilityFullNames).map(
        ([key, fullName]) => `${key}|${fullName}`
    ).join("|");
    const mentalSet = new Set(["int", "wis", "cha"]);
    const physicalSet = new Set(["str", "dex", "con"]);
    const standardSet = new Set((damageImmunities.standard || []).map((v) => v.toLowerCase()));
    const conditionSet = new Set((conditionImmunities.custom || []).map((v) => v.toLowerCase()));

    const ruleMatchers = [
        { re: /^All Ability Damage$/i, rule: { scope: "all", kind: "any" } },
        { re: /^Ability (Damage|Drain|Penalty)$/i, rule: (m) => ({ scope: "all", kind: m[1].toLowerCase() }) },
        { re: /^All Mental Abilities$/i, rule: { scope: "mental", kind: "any" } },
        { re: /^Mental Ability (Damage|Drain|Penalty)$/i, rule: (m) => ({ scope: "mental", kind: m[1].toLowerCase() }) },
        { re: /^All Physical Abilities$/i, rule: { scope: "physical", kind: "any" } },
        { re: /^Physical Ability (Damage|Drain|Penalty)$/i, rule: (m) => ({ scope: "physical", kind: m[1].toLowerCase() }) },
        { re: new RegExp(`^All (${abilityPatterns}) Damage$`, "i"), rule: (m) => ({ scope: "key", ability: abilityAliasToKey[m[1].toLowerCase()], kind: "any" }) },
        { re: new RegExp(`^(${abilityPatterns}) (Damage|Drain|Penalty)$`, "i"), rule: (m) => ({ scope: "key", ability: abilityAliasToKey[m[1].toLowerCase()], kind: m[2].toLowerCase() }) }
    ];

    const parsedRules = (damageImmunities.custom || []).map((immunity) => {
        const text = immunity.trim();
        for (const entry of ruleMatchers) {
            const match = text.match(entry.re);
            if (match) {
                const rule = typeof entry.rule === "function" ? entry.rule(match) : entry.rule;
                return rule;
            }
        }
        return null;
    }).filter(Boolean);

    function blocksAbility(rule, vs, ablDmgType) {
        const kindMatch = rule.kind === "any" || rule.kind === ablDmgType;
        if (!kindMatch) return false;
        if (rule.scope === "all") return true;
        if (rule.scope === "key") return rule.ability === vs;
        if (rule.scope === "mental") return mentalSet.has(vs);
        if (rule.scope === "physical") return physicalSet.has(vs);
        return false;
    }

    const fieldByType = {
        damage: "damage",
        drain: "drain",
        penalty: "userPenalty"
    };

    for (const dmg of abilityDmg) {
        const { vs, amount, ablDmgType, type } = dmg;
        if (!Number.isFinite(amount) || amount === 0) continue;

        if (standardSet.has(String(type).toLowerCase())) continue;
        if (conditionSet.has(constructTranslation)) continue;
        if (conditionSet.has(undeadTranslation)) {
            if (ablDmgType === "damage" && (vs === "str" || vs === "dex" || vs === "con")) continue;
            if (ablDmgType === "drain" || ablDmgType === "penalty") continue;
        }

        if (parsedRules.some((rule) => blocksAbility(rule, vs, ablDmgType))) continue;
        if (!abilities.hasOwnProperty(vs)) continue;

        const field = fieldByType[ablDmgType];
        abilities[vs][field] = Math.max(abilities[vs][field] + amount, 0);
    }
}



