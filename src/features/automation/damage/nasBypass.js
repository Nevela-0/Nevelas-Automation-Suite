import { MODULE } from '../../../common/module.js';

function normalizeTypeList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase());
    if (value instanceof Set) return Array.from(value).map((v) => String(v).toLowerCase());
    return [String(value).toLowerCase()];
}

function getNasFlagsFromOptions(options) {
    return (
        options?.item?.flags?.[MODULE.ID] ||
        options?.message?.itemSource?.flags?.[MODULE.ID] ||
        null
    );
}

function getActionSettings(flags, actionId) {
    const actions = flags?.itemActionSettings?.actions;
    if (!Array.isArray(actions) || actions.length === 0) return null;
    if (actionId) {
        const found = actions.find((a) => a.id === actionId);
        if (found) return found;
    }
    return actions[0] ?? null;
}

function getAttackNameFromOptions(options) {
    const msg = options?.message;
    const rolls =
        (msg?.systemRolls && Object.keys(msg.systemRolls).length) ? msg.systemRolls :
        msg?.rolls;
    const idx = Number(options?.attackIndex);
    const attack = Number.isInteger(idx) ? rolls?.attacks?.[idx] : null;
    return attack?.attack?.options?.flavor || attack?.attack?.name || "";
}

function getAttackSettings(actionSettings, attackName) {
    const attacks = actionSettings?.attacks;
    if (!Array.isArray(attacks) || attacks.length === 0) return null;
    if (attackName) {
        const found = attacks.find((a) => a.name === attackName || a.key === attackName);
        if (found) return found;
    }
    return attacks[0] ?? null;
}

function resolveBypassTypes(defKey, attackSettings, actionSettings, globalSettings) {
    const attackDef = attackSettings?.[defKey];
    if (attackDef) {
        const inherit = attackDef.inherit;
        if (inherit === false || inherit === undefined) {
            const bypass = attackDef.bypass;
            if (bypass?.enabled && Array.isArray(bypass.types)) return normalizeTypeList(bypass.types);
            return [];
        }
    }

    const actionDef = actionSettings?.[defKey];
    if (actionDef) {
        if (actionDef.inherit === true) {
        } else {
            const bypass = actionDef.bypass;
            if (bypass?.enabled && Array.isArray(bypass.types)) return normalizeTypeList(bypass.types);
            return [];
        }
    }

    const globalDef = globalSettings?.[defKey];
    if (globalDef?.bypass?.enabled && Array.isArray(globalDef.bypass.types)) {
        return normalizeTypeList(globalDef.bypass.types);
    }
    return [];
}

function resolveHardnessSettings(attackSettings, actionSettings, globalSettings) {
    const fromBlock = (block) => {
        const bypass = block?.bypass;
        const ignore = block?.ignore;
        const bypassEnabled = bypass?.enabled === true;
        const ignoreEnabled = ignore?.enabled === true;
        const ignoreValue = Number.isFinite(Number(ignore?.value)) ? Number(ignore.value) : 0;
        return { bypassEnabled, ignoreEnabled, ignoreValue };
    };

    const attackHardness = attackSettings?.hardness;
    if (attackHardness) {
        const bypassInherit = attackHardness.bypass?.inherit;
        const ignoreInherit = attackHardness.ignore?.inherit;
        const bypassLocal = bypassInherit === false || bypassInherit === undefined;
        const ignoreLocal = ignoreInherit === false || ignoreInherit === undefined;
        if (bypassLocal || ignoreLocal) {
            const { bypassEnabled, ignoreEnabled, ignoreValue } = fromBlock(attackHardness);
            return {
                hardnessBypass: bypassLocal ? bypassEnabled : false,
                hardnessIgnore: ignoreLocal && ignoreEnabled ? ignoreValue : 0
            };
        }
    }

    const actionHardness = actionSettings?.hardness;
    if (actionHardness) {
        const bypassInherit = actionHardness.bypass?.inherit;
        const ignoreInherit = actionHardness.ignore?.inherit;
        if (bypassInherit === true && ignoreInherit === true) {
        } else {
            const { bypassEnabled, ignoreEnabled, ignoreValue } = fromBlock(actionHardness);
            return {
                hardnessBypass: bypassEnabled,
                hardnessIgnore: ignoreEnabled ? ignoreValue : 0
            };
        }
    }

    const globalHardness = globalSettings?.hardness;
    if (globalHardness) {
        const { bypassEnabled, ignoreEnabled, ignoreValue } = fromBlock(globalHardness);
        return {
            hardnessBypass: bypassEnabled,
            hardnessIgnore: ignoreEnabled ? ignoreValue : 0
        };
    }

    return { hardnessBypass: false, hardnessIgnore: 0 };
}

function normalizeNasSettingsFromOptions(options) {
    const flags = getNasFlagsFromOptions(options);
    if (!flags) return null;

    const actionId = options?.action?.id || options?.actionId || options?.message?.system?.action?.id || "";
    const actionSettings = getActionSettings(flags, actionId);
    const attackName = getAttackNameFromOptions(options);
    const attackSettings = getAttackSettings(actionSettings, attackName);
    const globalSettings = flags?.globalItemSettings;

    const { hardnessBypass, hardnessIgnore } = resolveHardnessSettings(
        attackSettings,
        actionSettings,
        globalSettings
    );

    return {
        drBypassTypes: resolveBypassTypes("damageReduction", attackSettings, actionSettings, globalSettings),
        erBypassTypes: resolveBypassTypes("resistance", attackSettings, actionSettings, globalSettings),
        immunityBypassTypes: resolveBypassTypes("immunity", attackSettings, actionSettings, globalSettings),
        hardnessIgnore,
        hardnessBypass,
        debug: flags?.debug === true
    };
}

function getResistanceTypeIds(entry) {
    const ids = new Set();
    if (entry?.typeIds) {
        for (const id of entry.typeIds) ids.add(String(id).toLowerCase());
    }
    if (Array.isArray(entry?.types)) {
        for (const t of entry.types) {
            const id = t?.id ?? t;
            if (id) ids.add(String(id).toLowerCase());
        }
    }
    return ids;
}

function shouldBypassEntry(entry, bypassTypes) {
    if (!bypassTypes?.length) return false;
    if (bypassTypes.includes("all")) return true;
    const ids = getResistanceTypeIds(entry);
    const hasGeneric = entry?.hasGeneric || ids.size === 0;
    if (hasGeneric && bypassTypes.includes("-")) return true;
    for (const id of ids) {
        if (bypassTypes.includes(id)) return true;
    }
    return false;
}

function shouldBypassImmunity(entry, bypassTypes) {
    if (!bypassTypes?.length) return false;
    if (bypassTypes.includes("all")) return true;
    const id = entry?.id ? String(entry.id).toLowerCase() : "";
    if (id && bypassTypes.includes(id)) return true;
    const label = entry?.label ? String(entry.label).toLowerCase() : "";
    return label && bypassTypes.includes(label);
}

export function applyNasDefenseBypass(app, options, { isHealing }) {
    if (isHealing) return false;
    const nas = normalizeNasSettingsFromOptions(options);
    if (!nas) return false;

    let changed = false;
    for (const target of app.targets) {
        if (nas.drBypassTypes.length) {
            for (const entry of target.dr ?? []) {
                if (shouldBypassEntry(entry, nas.drBypassTypes)) {
                    entry.active = false;
                    entry.disabled = true;
                    changed = true;
                }
            }
        }

        if (nas.erBypassTypes.length) {
            for (const entry of target.er ?? []) {
                if (shouldBypassEntry(entry, nas.erBypassTypes)) {
                    entry.active = false;
                    entry.disabled = true;
                    changed = true;
                }
            }
        }

        if (nas.immunityBypassTypes.length) {
            for (const entry of target.di ?? []) {
                if (shouldBypassImmunity(entry, nas.immunityBypassTypes)) {
                    entry.active = false;
                    entry.disabled = true;
                    changed = true;
                }
            }
        }

        if (nas.hardnessBypass || nas.hardnessIgnore > 0) {
            const hardness = target.hardness;
            if (hardness) {
                const base = Number.isFinite(hardness.effective) ? hardness.effective : Number(hardness.value) || 0;
                const next = nas.hardnessBypass ? 0 : Math.max(0, base - nas.hardnessIgnore);
                hardness.effective = next;
                hardness.active = next > 0;
                hardness.disabled = next <= 0;
                changed = true;
            }
        }

        if (changed && typeof app._refreshTarget === "function") {
            app._refreshTarget(target.uuid);
        }
    }

    return changed;
}
