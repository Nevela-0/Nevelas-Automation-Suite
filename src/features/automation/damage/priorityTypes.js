import { moduleConfig } from '../../../common/config.js';
import { getInstanceTypes } from './instances.js';

export function normalizePriorityType(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";

    const normalized = raw.toLowerCase().replace(/\s+/g, "");

    const materialTypes = pf1?.registry?.materials ?? [];
    for (const material of materialTypes) {
        const id = String(material?.id ?? "");
        const name = String(material?.name ?? "");
        if (id && normalized === id.toLowerCase()) return id;
        if (name && normalized === name.toLowerCase().replace(/\s+/g, "")) return id || raw;
    }

    const materials = pf1?.registry?.materials;
    if (materials?.forEach) {
        let match = "";
        materials.forEach((mat) => {
            const id = String(mat?.id ?? "");
            const name = String(mat?.name ?? "");
            if (!match && id && normalized === id.toLowerCase()) match = id;
            if (!match && name && normalized === name.toLowerCase().replace(/\s+/g, "")) match = id || name;
        });
        if (match) return match;
    }

    const drMap = pf1?.config?.damageResistances ?? {};
    for (const [key, label] of Object.entries(drMap)) {
        if (normalized === String(key).toLowerCase()) return key;
        if (label && normalized === String(label).toLowerCase().replace(/\s+/g, "")) return key;
    }

    const damageTypes = pf1?.registry?.damageTypes;
    if (damageTypes?.forEach) {
        let match = "";
        damageTypes.forEach((dt, key) => {
            const id = String(dt?.id ?? key ?? "");
            const name = String(dt?.name ?? "");
            if (!match && id && normalized === id.toLowerCase()) match = id;
            if (!match && name && normalized === name.toLowerCase().replace(/\s+/g, "")) match = id || name;
        });
        if (match) return match;
    }

    return normalized;
}

export function getDamageTypePriorityConfig() {
    const weaponDamageTypes = moduleConfig?.damageConfig?.weaponDamageTypes;
    if (!Array.isArray(weaponDamageTypes) || weaponDamageTypes.length === 0) return [];
    return weaponDamageTypes.map((segment) => Array.isArray(segment) ? [...segment] : []);
}

function getDamageTypesFromInstances(instances) {
    const types = new Set();
    for (const inst of instances ?? []) {
        for (const t of getInstanceTypes(inst)) {
            const normalized = normalizePriorityType(t);
            if (normalized) types.add(normalized);
        }
    }
    return types;
}

export function isWeaponAttack(options) {
    const action = options?.action;
    const item = options?.item ?? action?.item ?? options?.message?.itemSource;
    const type = item?.type ?? action?.item?.type ?? options?.message?.itemSource?.type;
    const subType = item?.subType ?? action?.item?.subType ?? options?.message?.itemSource?.subType;
    return (type === "attack" && (subType === "weapon" || subType === "natural")) || type === "weapon";
}

export function getAmmoItemFromMessage(options) {
    const msg = options?.message;
    if (!msg?.content) return null;
    const item = options?.item ?? options?.action?.item ?? msg?.itemSource;
    const parent = item?.parent;
    if (!parent?.items?.get) return null;
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(msg.content, "text/html");
        const ammoElement = doc.querySelector("[data-ammo-id]");
        const ammoId = ammoElement ? ammoElement.getAttribute("data-ammo-id") : null;
        return ammoId ? parent.items.get(ammoId) : null;
    } catch (_) {
        return null;
    }
}

export function getEnhancementBonusFromOptions(options) {
    const action = options?.action;
    const item = options?.item ?? action?.item ?? options?.message?.itemSource;
    const actionEnhBonus = Number(action?.enhancementBonus) || 0;
    const hasAmmo = item?.system?.ammo;
    const rangedAction = !!action?.isRanged;
    const addons = item?.system?.material?.addon;

    if (hasAmmo?.type !== "" && rangedAction) {
        const ammoItem = getAmmoItemFromMessage(options);
        if (!ammoItem) return actionEnhBonus;
        const api = game.modules.get("ckl-roll-bonuses")?.api;
        if (api) {
            const actionId = options?.action?.id || options?.actionId || options?.message?.system?.action?.id || "";
            const actionObj = item?.actions?.get?.(actionId);
            const targets = options?.targets ?? [];
            const enhData = api.utils.getEnhancementBonusForAction({ action: actionObj, ammo: ammoItem, targets });
            return Number(enhData?.total) || 0;
        }
        const ckl = ammoItem?.["ckl-roll-bonuses"] ?? {};
        if (Object.prototype.hasOwnProperty.call(ckl, "ammo-enhancement") || Object.prototype.hasOwnProperty.call(ckl, "ammo-enhancement-stacks")) {
            const enh = Number(ckl["ammo-enhancement"]) || 0;
            const stacks = Number(ckl["ammo-enhancement-stacks"]) || 0;
            return enh + stacks;
        }
        if (actionEnhBonus > 0) return 1;
        const magicFlag = ammoItem?.system?.flags?.boolean ?? {};
        for (const key in magicFlag) {
            if (String(key).toLowerCase() === "magic") return 1;
        }
        return 0;
    }

    if (Array.isArray(addons) && addons.includes("magic")) return 1;
    if (Array.isArray(addons) && addons.includes("epic") && actionEnhBonus >= 6) return Math.max(6, actionEnhBonus);
    return actionEnhBonus;
}

export function getPriorityTypesForOptions(options, instances) {
    const damagePriorityArray = getDamageTypePriorityConfig();
    if (!damagePriorityArray.length) return [];
    let biggestDamageTypePriority = 0;

    if (isWeaponAttack(options)) {
        const enhBonus = getEnhancementBonusFromOptions(options);
        biggestDamageTypePriority = Math.max(0, Math.floor(enhBonus));
    } else {
        const damageTypes = getDamageTypesFromInstances(instances);
        for (let i = damagePriorityArray.length - 1; i > -1; i -= 1) {
            const currentPrioritySegment = damagePriorityArray[i] ?? [];
            if (currentPrioritySegment.some((priorityType) => damageTypes.has(normalizePriorityType(priorityType)))) {
                biggestDamageTypePriority = i;
                break;
            }
        }
    }

    if (biggestDamageTypePriority <= 0) return [];
    damagePriorityArray.splice(biggestDamageTypePriority + 1);
    const flattenedTypes = damagePriorityArray
        .flat()
        .map((type) => normalizePriorityType(type))
        .filter((type) => type);
    return Array.from(new Set(flattenedTypes));
}

export function applyLegacyPriorityTypes(app, options, instances, isHealing) {
    if (isHealing) return false;
    if (!app || !app.materials) return false;
    const types = getPriorityTypesForOptions(options, instances);
    if (!types.length) return false;

    const priorMagic = app.isMagic;
    const priorMaterials = new Set(app.materials);
    const priorAdamantine = app.adamantine;

    app.isMagic = false;
    app.materials.clear();
    app.adamantine = false;

    let changed = priorMagic || priorAdamantine || priorMaterials.size > 0;
    for (const type of types) {
        if (type === "magic") {
            app.isMagic = true;
            changed = true;
        } else {
            if (!app.materials.has(type)) {
                app.materials.add(type);
                changed = true;
            }
            if (type === "adamantine") {
                app.adamantine = true;
                changed = true;
            }
        }
    }
    if (changed) {
        for (const target of app.targets) {
            if (app.hasPhysical) {
                target.dr = app.getResistances(target.actor, "dr", target.defenses);
            } else {
                target.dr = [];
            }
            if (app.hasEnergy) {
                target.er = app.getResistances(target.actor, "er", target.defenses);
            } else {
                target.er = [];
            }
            target.haveDER = target.dr.length || target.er.length || target.hardness?.effective;
            if (typeof app._refreshTarget === "function") {
                app._refreshTarget(target.uuid);
            }
        }
    }

    return changed;
}
