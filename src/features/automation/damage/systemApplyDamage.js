import { MODULE } from '../../../common/module.js';
import { chatMessageStyle } from '../../../common/foundryCompat.js';
import { checkMassiveDamage } from '../../../integration/moduleSockets.js';
import { abilityDeltaCalculation } from './ability.js';
import { buildAbilityDmgEntries, splitAbilityInstances } from './abilityTags.js';
import { applyNasDefenseBypass } from './nasBypass.js';
import { applyLegacyPriorityTypes } from './priorityTypes.js';
import { applyManualVulnerability, buildNumericInstances, sumInstanceValues } from './instances.js';
import { normalizeTargets } from '../utils/targeting.js';
import { actorHasGrantedCriticalImmunity, getActorGrantedFortification } from '../defenses/grantedDefenses.js';
import { isWoundsVigorActive, isWoundsVigorAutomationEnabled, isWvNoWoundsActor } from '../utils/woundsVigor.js';
import { getCasterLevelEquivalentFromFormula, getDiceCountFromFormula, getDiceCountFromRoll } from '../utils/formulaUtils.js';
import { applyReactiveEffectsForHit, resolveSourceActorFromOptions } from './reactiveTriggers.js';
import { resolveMirrorImageForApplyDamage } from '../buffs/mirrorImage.js';
import { applyDamageAbsorption, postDamageAbsorptionChatSummary } from '../buffs/damageAbsorption.js';
import { spendNasTemporaryHp } from '../buffs/temporaryHpPools.js';
import { recordCombatTextContext } from '../utils/combatTextContext.js';
import { showAbsorptionCombatText, showTemporaryHpCombatText } from '../utils/healthDeltaText.js';
import { getRuntimeCasterLevel, rollDataWithRuntimeLevels } from '../utils/spellLevels.js';

async function callApplyDamageNoop(wrapped, actor, options = {}) {
    return wrapped.call(actor, 0, {
        ...options,
        ratio: 1,
        reduction: 0,
        asWounds: false,
        _nasAbsorptionApplied: true
    });
}

async function applyDamageAfterNasTemporaryHp(wrapped, actor, value = 0, options = {}) {
    if (!actor || options?._nasTemporaryHpApplied) return { handled: false };
    if (options?.asWounds === true) return { handled: false };
    const amount = Number(value) || 0;
    const isHealing = amount < 0 || options?.isHealing === true;
    if (isHealing || amount <= 0) return { handled: false };

    const rawFinalDamage = Math.floor(Math.max(0, Math.floor(Math.max(0, amount) * (options?.ratio ?? 1))));
    const finalDamage = Math.max(0, rawFinalDamage - Math.min(rawFinalDamage, options?.reduction ?? 0));
    if (finalDamage <= 0) return { handled: false };

    const tempHp = await spendNasTemporaryHp(actor, finalDamage, {
        ...options,
        _nasTemporaryHpCombatText: false
    });
    if (!tempHp?.changed) return { handled: false };
    const remaining = Math.max(0, Math.floor(Number(tempHp.remainingDamage) || 0));
    const spent = (tempHp.spentPools ?? []).reduce((sum, pool) => {
        return sum + Math.max(0, Math.floor(Number(pool?.spent) || 0));
    }, 0);
    if (remaining <= 0) {
        await callApplyDamageNoop(wrapped, actor, {
            ...options,
            _nasTemporaryHpApplied: true
        });
        await showTemporaryHpCombatText(actor, spent);
        return { handled: true, result: true, spentPools: tempHp.spentPools ?? [] };
    }

    if (spent > 0) {
        recordCombatTextContext(actor, {
            nasTemporaryHpSpent: spent,
            isCritical: options?.isCritical === true,
            critMult: options?.critMult,
            messageUuid: options?.message?.uuid ?? options?.messageUuid ?? null,
            attackIndex: options?.attackIndex
        });
    }
    const result = await wrapped.call(actor, remaining, {
        ...options,
        ratio: 1,
        reduction: 0,
        _nasTemporaryHpApplied: true
    });
    return { handled: true, result, spentPools: tempHp.spentPools ?? [] };
}

function actorHasAbsorptionData(actor) {
    return (actor?.items ?? []).some((item) => {
        if (item?.type !== "buff") return false;
        return Boolean(item?.flags?.[MODULE.ID]?.itemReactiveEffects?.absorption);
    });
}

function summarizeApplyDamageInstance(instance) {
    return {
        value: instance?.value,
        type: instance?.type,
        typeIds: instance?.typeIds ?? instance?.types,
        damageType: instance?.damageType,
        damageTypes: instance?.damageTypes,
        material: instance?.material,
        materials: instance?.materials,
        alignment: instance?.alignment,
        alignments: instance?.alignments,
        bypass: instance?.bypass,
        bypasses: instance?.bypasses,
        formula: instance?.formula,
        keys: instance && typeof instance === "object" ? Object.keys(instance).sort() : []
    };
}

function summarizeReductionOptions(options = {}) {
    const out = {};
    for (const key of Object.keys(options).sort()) {
        if (/dr|reduc|resist|bypass|immune|vulner|type|instance|damage/i.test(key)) {
            const value = options[key];
            out[key] = Array.isArray(value)
                ? value.map((entry) => typeof entry === "object" ? summarizeApplyDamageInstance(entry) : entry)
                : value;
        }
    }
    return out;
}

function typeValuesFrom(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.flatMap(typeValuesFrom);
    if (value instanceof Set) return Array.from(value).flatMap(typeValuesFrom);
    if (value?.values) return typeValuesFrom(value.values);
    if (value?.value) return typeValuesFrom(value.value);
    if (value?.id) return [String(value.id).toLowerCase()];
    return [String(value).toLowerCase()];
}

function damageTypesFromApplyDamageOptions(options = {}) {
    const ids = new Set();
    for (const instance of options.instances ?? []) {
        for (const key of ["typeIds", "types", "type", "damageType", "damageTypes"]) {
            for (const id of typeValuesFrom(instance?.[key])) {
                if (id) ids.add(id);
            }
        }
    }
    return [...ids];
}

function escHtml(value) {
    return foundry.utils.escapeHTML(String(value ?? ""));
}

function actorChatName(actor) {
    return actor?.name ?? game.i18n.localize("NAS.common.labels.target");
}

function damageTypeIdsFromInstance(instance = {}) {
    const ids = new Set();
    for (const key of ["typeIds", "types", "type", "damageType", "damageTypes"]) {
        for (const id of typeValuesFrom(instance?.[key])) {
            if (id) ids.add(String(id).toLowerCase());
        }
    }
    for (const id of typeValuesFrom(instance?.options?.damageType)) {
        if (id) ids.add(String(id).toLowerCase());
    }
    return [...ids];
}

function instanceDamageAmount(instance = {}) {
    const value = Number(instance?.value ?? instance?.total ?? instance?.number ?? instance?.formula);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isCriticalExtraDamageInstance(instance = {}) {
    return String(instance?._nasDamageRole ?? instance?._nasDamageSource ?? "").toLowerCase() === "critical";
}

function damageTypeIsPrecision(typeId) {
    const raw = String(typeId ?? "").trim().toLowerCase();
    if (raw === "precision") return true;
    const entry = resolveDamageType(raw);
    const candidates = [entry?.id, entry?.name, entry?.shortName];
    return candidates.some((candidate) => String(candidate ?? "").trim().toLowerCase() === "precision");
}

function isPrecisionDamageInstance(instance = {}) {
    return damageTypeIdsFromInstance(instance).some(damageTypeIsPrecision);
}

function fortificationDamageReport(instances = [], { includeCritical = true, includePrecision = true } = {}) {
    const entries = [];
    let total = 0;
    let criticalAmount = 0;
    let precisionAmount = 0;

    for (const instance of instances) {
        const amount = instanceDamageAmount(instance);
        if (amount <= 0) continue;
        const critical = isCriticalExtraDamageInstance(instance);
        const precision = isPrecisionDamageInstance(instance);
        if ((!includeCritical || !critical) && (!includePrecision || !precision)) continue;
        entries.push({ instance, amount, critical, precision });
        total += amount;
        if (critical) criticalAmount += amount;
        if (precision) precisionAmount += amount;
    }

    return { entries, total, criticalAmount, precisionAmount };
}

function removeReportedDamageInstances(instances = [], report = {}) {
    const removed = new Set((report.entries ?? []).map((entry) => entry.instance));
    return instances.filter((instance) => !removed.has(instance));
}

function fortificationTierChatLabel(tier = {}) {
    const label = game.i18n.localize(tier.labelKey ?? "") || String(tier.id ?? "");
    return String(label).replace(/\s*\(\s*\d+%\s*\)\s*$/, "");
}

function inlineRollHtml(roll, fallbackTotal = null) {
    try {
        const anchor = roll?.toAnchor?.();
        if (anchor?.outerHTML) return anchor.outerHTML;
    } catch (_err) {
    }
    const total = Math.max(1, Math.floor(Number(fallbackTotal ?? roll?.total) || 0));
    return escHtml(total);
}

function postFortificationChatSummary({
    actor,
    otherActor,
    tier,
    roll = null,
    rollTotal = null,
    success = false,
    negatedDamage = 0
} = {}) {
    const chance = Math.max(0, Math.floor(Number(tier?.chance) || 0));
    const amount = Math.max(0, Math.floor(Number(negatedDamage) || 0));
    const title = game.i18n.format("NAS.reactive.chatSummary.fortificationTitle", {
        actor: escHtml(actorChatName(actor))
    });
    const subtitle = game.i18n.format("NAS.reactive.chatSummary.fortificationSubtitle", {
        other: escHtml(actorChatName(otherActor)),
        tier: escHtml(fortificationTierChatLabel(tier)),
        chance: String(chance)
    });
    const line = chance >= 100
        ? game.i18n.format("NAS.reactive.chatSummary.lineFortificationImmune", { amount })
        : success
            ? game.i18n.format("NAS.reactive.chatSummary.lineFortificationSuccess", {
                roll: inlineRollHtml(roll, rollTotal),
                chance: String(chance),
                amount
            })
            : game.i18n.format("NAS.reactive.chatSummary.lineFortificationFailure", {
                roll: inlineRollHtml(roll, rollTotal),
                chance: String(chance),
                amount
            });

    const content = [
        `<div class="nas-reactive-chat-summary" data-nas-reactive-summary>`,
        `<div class="nas-reactive-chat-header"><strong>${title}</strong></div>`,
        `<div class="nas-reactive-chat-subtitle">${subtitle}</div>`,
        `<ul class="nas-reactive-chat-lines"><li>${line}</li></ul>`,
        `</div>`
    ].join("");

    ChatMessage.create({
        ...chatMessageStyle("OTHER"),
        user: game.user?.id,
        speaker: ChatMessage.getSpeaker({ actor: actor ?? null }),
        content
    });
}

function postCriticalImmunityChatSummary({
    actor,
    otherActor,
    negatedDamage = 0
} = {}) {
    const amount = Math.max(0, Math.floor(Number(negatedDamage) || 0));
    if (amount <= 0) return;
    const title = game.i18n.format("NAS.reactive.chatSummary.criticalImmunityTitle", {
        actor: escHtml(actorChatName(actor))
    });
    const subtitle = game.i18n.format("NAS.reactive.chatSummary.criticalImmunitySubtitle", {
        other: escHtml(actorChatName(otherActor))
    });
    const line = game.i18n.format("NAS.reactive.chatSummary.lineCriticalImmunity", { amount });

    const content = [
        `<div class="nas-reactive-chat-summary" data-nas-reactive-summary>`,
        `<div class="nas-reactive-chat-header"><strong>${title}</strong></div>`,
        `<div class="nas-reactive-chat-subtitle">${subtitle}</div>`,
        `<ul class="nas-reactive-chat-lines"><li>${line}</li></ul>`,
        `</div>`
    ].join("");

    ChatMessage.create({
        ...chatMessageStyle("OTHER"),
        user: game.user?.id,
        speaker: ChatMessage.getSpeaker({ actor: actor ?? null }),
        content
    });
}

async function applyFortificationForTarget({ actor, instances = [], options = {}, sourceActor = null } = {}) {
    const currentValue = Math.max(0, Math.floor(Math.abs(Number(options?.value) || sumInstanceValues(instances) || 0)));
    if (!actor || currentValue <= 0 || options?._nasFortificationApplied || options?.isHealing === true) {
        return { checked: false, instances, value: currentValue, options };
    }

    let workingInstances = instances;
    let workingValue = currentValue;
    let workingOptions = { ...options };
    let criticalImmunityChecked = false;
    let criticalImmunityChanged = false;
    let criticalImmunityDamage = 0;

    if (actorHasGrantedCriticalImmunity(actor)) {
        const criticalReport = fortificationDamageReport(workingInstances, { includeCritical: true, includePrecision: false });
        if (criticalReport.total > 0) {
            criticalImmunityChecked = true;
            criticalImmunityChanged = true;
            criticalImmunityDamage = criticalReport.total;
            postCriticalImmunityChatSummary({
                actor,
                otherActor: sourceActor,
                negatedDamage: criticalReport.total
            });
            workingInstances = removeReportedDamageInstances(workingInstances, criticalReport);
            workingValue = Math.max(0, Math.floor(sumInstanceValues(workingInstances)));
            workingOptions = {
                ...workingOptions,
                instances: workingInstances,
                value: workingValue,
                isCritical: false,
                critMult: 0,
                _nasCriticalImmunityApplied: true,
                _nasCriticalImmunityNegatedDamage: criticalReport.total
            };
        }
    }

    const tier = getActorGrantedFortification(actor);
    const chance = Math.max(0, Math.floor(Number(tier?.chance) || 0));
    if (chance <= 0) {
        return {
            checked: criticalImmunityChecked,
            success: criticalImmunityChanged,
            changed: criticalImmunityChanged,
            instances: workingInstances,
            value: workingValue,
            options: workingOptions,
            negatedDamage: criticalImmunityDamage
        };
    }

    const report = fortificationDamageReport(workingInstances);
    if (report.total <= 0) {
        return {
            checked: criticalImmunityChecked,
            success: criticalImmunityChanged,
            changed: criticalImmunityChanged,
            instances: workingInstances,
            value: workingValue,
            options: workingOptions,
            negatedDamage: criticalImmunityDamage
        };
    }

    let rollTotal = null;
    let roll = null;
    let success = chance >= 100;
    if (!success) {
        roll = await new Roll("1d100").evaluate();
        rollTotal = Math.max(1, Math.floor(Number(roll.total) || 0));
        success = rollTotal <= chance;
    }

    postFortificationChatSummary({
        actor,
        otherActor: sourceActor,
        tier,
        roll,
        rollTotal,
        success,
        negatedDamage: success ? report.total : 0
    });

    if (!success) {
        return {
            checked: true,
            success: criticalImmunityChanged,
            changed: criticalImmunityChanged,
            instances: workingInstances,
            value: workingValue,
            options: {
                ...workingOptions,
                _nasFortificationApplied: true
            },
            negatedDamage: criticalImmunityDamage
        };
    }

    const remainingInstances = removeReportedDamageInstances(workingInstances, report);
    const nextValue = Math.max(0, Math.floor(sumInstanceValues(remainingInstances)));
    const nextOptions = {
        ...workingOptions,
        instances: remainingInstances,
        value: nextValue,
        _nasFortificationApplied: true,
        _nasFortificationNegatedDamage: report.total + criticalImmunityDamage,
        _nasFortificationNegatedPrecisionDamage: report.precisionAmount
    };
    if (report.criticalAmount > 0) {
        nextOptions.isCritical = false;
        nextOptions.critMult = 0;
        nextOptions._nasFortificationNegatedCritical = true;
    }

    return {
        checked: true,
        success: true,
        changed: true,
        instances: remainingInstances,
        value: nextValue,
        options: nextOptions,
        negatedDamage: report.total + criticalImmunityDamage
    };
}

function drBypassTypesFromEntry(entry = {}) {
    return typeValuesFrom(entry?.types).filter(Boolean);
}

function drEntryBypassed(entry, damageTypes = []) {
    const bypassTypes = drBypassTypesFromEntry(entry);
    if (!bypassTypes.length) return false;
    const attackTypes = new Set(damageTypes.map((type) => String(type).toLowerCase()));
    if (String(entry?.operator ?? "true").toLowerCase() === "false") {
        return bypassTypes.every((type) => attackTypes.has(type));
    }
    return bypassTypes.some((type) => attackTypes.has(type));
}

function isNasAbsorptionResistanceEntry(entry = {}) {
    return entry?.nas?.source === "damageAbsorption";
}

function nativeDamageReductionForApplyDamage(actor, value, options = {}, { ignoreNasAbsorption = false } = {}) {
    if (Number.isFinite(Number(options?.reduction)) && Number(options.reduction) > 0) {
        return { reduction: 0, reason: "already-has-reduction" };
    }
    if (options?.asWounds || value <= 0) return { reduction: 0, reason: "not-hp-damage" };

    const damageTypes = damageTypesFromApplyDamageOptions(options);
    const entries = Array.isArray(actor?.system?.traits?.dr?.value) ? actor.system.traits.dr.value : [];
    const candidates = [];
    for (const entry of entries) {
        if (ignoreNasAbsorption && isNasAbsorptionResistanceEntry(entry)) continue;
        const amount = Math.max(0, Math.floor(Number(entry?.amount ?? entry?.value) || 0));
        if (amount <= 0) continue;
        const bypassed = drEntryBypassed(entry, damageTypes);
        candidates.push({
            entry: foundry.utils.deepClone(entry),
            amount,
            bypassed
        });
    }
    const reduction = Math.min(value, Math.max(0, ...candidates.filter((candidate) => !candidate.bypassed).map((candidate) => candidate.amount)));
    return { reduction, damageTypes, candidates };
}

function resistanceEntryMatchesDamageTypes(entry, damageTypes = []) {
    const resistanceTypes = typeValuesFrom(entry?.types).filter(Boolean);
    if (!resistanceTypes.length) return false;
    const attackTypes = new Set(damageTypes.map((type) => String(type).toLowerCase()));
    if (String(entry?.operator ?? "true").toLowerCase() === "false") {
        return resistanceTypes.every((type) => attackTypes.has(type));
    }
    return resistanceTypes.some((type) => attackTypes.has(type));
}

function nativeEnergyResistanceForApplyDamage(actor, value, options = {}, { ignoreNasAbsorption = false } = {}) {
    if (Number.isFinite(Number(options?.reduction)) && Number(options.reduction) > 0) {
        return { reduction: 0, reason: "already-has-reduction" };
    }
    if (options?.asWounds || options?.asNonlethal || value <= 0) return { reduction: 0, reason: "not-energy-hp-damage" };

    const damageTypes = damageTypesFromApplyDamageOptions(options);
    if (!damageTypes.some((type) => isEnergyTypeId(type))) return { reduction: 0, damageTypes, reason: "not-energy" };

    const entries = Array.isArray(actor?.system?.traits?.eres?.value) ? actor.system.traits.eres.value : [];
    const candidates = [];
    for (const entry of entries) {
        if (ignoreNasAbsorption && isNasAbsorptionResistanceEntry(entry)) continue;
        const amount = Math.max(0, Math.floor(Number(entry?.amount ?? entry?.value) || 0));
        if (amount <= 0) continue;
        const matches = resistanceEntryMatchesDamageTypes(entry, damageTypes);
        candidates.push({
            entry: foundry.utils.deepClone(entry),
            amount,
            matches
        });
    }
    const reduction = Math.min(value, Math.max(0, ...candidates.filter((candidate) => candidate.matches).map((candidate) => candidate.amount)));
    return { reduction, damageTypes, candidates };
}

function additionalReductionAfterAbsorption(actor, value, options = {}, absorption = {}) {
    const remaining = Math.max(0, Math.floor(Number(value) || 0));
    if (remaining <= 0) return 0;

    let reduction = 0;
    if (Math.max(0, Number(absorption?.drReduction) || 0) > 0) {
        const nativeDr = nativeDamageReductionForApplyDamage(actor, remaining, { ...options, reduction: 0 }, { ignoreNasAbsorption: true });
        reduction = Math.max(reduction, Math.max(0, nativeDr.reduction - Math.max(0, Math.floor(Number(absorption.drReduction) || 0))));
    }
    if (Math.max(0, Number(absorption?.erReduction) || 0) > 0) {
        const nativeEr = nativeEnergyResistanceForApplyDamage(actor, remaining, { ...options, reduction: 0 }, { ignoreNasAbsorption: true });
        reduction = Math.max(reduction, nativeEr.reduction);
    }
    return Math.min(remaining, reduction);
}

function buildConvertedDamageInstances(amount, damageType) {
    const value = Math.max(0, Math.floor(Number(amount) || 0));
    const type = String(damageType ?? "untyped").trim() || "untyped";
    return [{
        formula: String(value),
        types: { values: [type], custom: "" },
        type: { values: [type], custom: "" }
    }];
}

function getConfiguredWoundDamageTypeIds() {
    const fallback = ['negative', 'positive'];
    try {
        const raw = game.settings.get(MODULE.ID, 'woundsVigorWoundDamageTypeIds');
        if (!Array.isArray(raw)) return new Set(fallback);
        return new Set(raw.map((id) => String(id).toLowerCase()).filter(Boolean));
    } catch (_err) {
        return new Set(fallback);
    }
}

function getMessageDamageParts(options) {
    const msg = options?.message;
    const rolls =
        (msg?.systemRolls && Object.keys(msg.systemRolls).length) ? msg.systemRolls :
        msg?.rolls;
    const idx = Number(options?.attackIndex);
    if (!Number.isInteger(idx)) return [];
    const attack = rolls?.attacks?.[idx];
    if (!attack) return [];
    const baseParts = Array.isArray(attack.damage) ? attack.damage : [];
    const critParts = Array.isArray(attack.critDamage) ? attack.critDamage : [];
    return options?.isCritical ? [...baseParts, ...critParts] : baseParts;
}

function countDiceFromMessageParts(options) {
    const parts = getMessageDamageParts(options);
    if (!parts.length) return 0;
    const rollData = options?.action?.getRollData?.()
        ?? options?.item?.getRollData?.()
        ?? {};
    let total = 0;
    for (const part of parts) {
        const fromRoll = getDiceCountFromRoll(part?.roll);
        if (fromRoll > 0) {
            total += fromRoll;
            continue;
        }
        total += getDiceCountFromFormula(part?.formula ?? part?.roll?.formula, rollData);
    }
    return total;
}

function countDiceFromInstances(instances, rollData = {}) {
    if (!Array.isArray(instances) || !instances.length) return 0;
    let total = 0;
    for (const inst of instances) {
        const fromRoll = getDiceCountFromRoll(inst?.roll);
        if (fromRoll > 0) {
            total += fromRoll;
            continue;
        }
        total += getDiceCountFromFormula(inst?.formula ?? inst?.roll?.formula, rollData);
    }
    return total;
}

function getTypeIdsFromInstance(inst) {
    const raw = inst?.typeIds ?? inst?.types ?? [];
    return Array.from(raw).map((t) => String(t).toLowerCase());
}

function resolveDamageType(typeId) {
    const reg = pf1?.registry?.damageTypes;
    if (!reg?.get) return null;
    const direct = reg.get(typeId);
    if (direct) return direct;
    const needle = String(typeId).toLowerCase();
    for (const [, value] of reg.entries()) {
        const id = String(value?.id ?? '').toLowerCase();
        const name = String(value?.name ?? '').toLowerCase();
        const shortName = String(value?.shortName ?? '').toLowerCase();
        if (needle && (needle === id || needle === name || needle === shortName)) return value;
    }
    return null;
}

function matchesConfiguredWoundType(typeId, configuredTypeIds) {
    const entry = resolveDamageType(typeId);
    const raw = String(typeId).toLowerCase();
    if (configuredTypeIds.has(raw)) return true;
    const id = String(entry?.id ?? raw).toLowerCase();
    const name = String(entry?.name ?? '').toLowerCase();
    const shortName = String(entry?.shortName ?? '').toLowerCase();
    return configuredTypeIds.has(id) || configuredTypeIds.has(name) || configuredTypeIds.has(shortName);
}

function isEnergyTypeId(typeId) {
    const entry = resolveDamageType(typeId);
    return Boolean(entry?.isEnergy || entry?.category === 'energy');
}

function gatherMessagePartTypeIds(options) {
    const out = [];
    const parts = getMessageDamageParts(options);
    for (const part of parts) {
        const dt = part?.options?.damageType;
        if (Array.isArray(dt)) out.push(...dt.map((t) => String(t).toLowerCase()));
    }
    return out;
}

function isLifeEnergyContext(options, instances) {
    const typeIds = [];
    for (const inst of instances ?? []) typeIds.push(...getTypeIdsFromInstance(inst));
    if (!typeIds.length) typeIds.push(...gatherMessagePartTypeIds(options));
    if (!typeIds.length) return false;

    const configuredTypeIds = getConfiguredWoundDamageTypeIds();
    const hasLifeType = typeIds.some((t) => matchesConfiguredWoundType(t, configuredTypeIds));
    if (!hasLifeType) return false;

    const hasEnergy = typeIds.some((t) => isEnergyTypeId(t)) || hasLifeType;
    return hasLifeType && hasEnergy;
}

function inferCasterLevel(options, actor) {
    const runtimeCasterLevel = getRuntimeCasterLevel(options?.action, options?.item);
    if (Number.isFinite(runtimeCasterLevel) && runtimeCasterLevel > 0) return Math.floor(runtimeCasterLevel);

    const fromActionShared = Number(options?.action?.shared?.rollData?.cl);
    if (Number.isFinite(fromActionShared) && fromActionShared > 0) return Math.floor(fromActionShared);

    const fromAction = Number(options?.action?.getRollData?.()?.cl);
    if (Number.isFinite(fromAction) && fromAction > 0) return Math.floor(fromAction);

    const fromItem = Number(options?.item?.getRollData?.()?.cl);
    if (Number.isFinite(fromItem) && fromItem > 0) return Math.floor(fromItem);

    const bookKey = options?.action?.item?.system?.spellbook ?? options?.item?.system?.spellbook;
    const fromBook = Number(actor?.system?.attributes?.spells?.spellbooks?.[bookKey]?.cl?.total);
    if (Number.isFinite(fromBook) && fromBook > 0) return Math.floor(fromBook);

    return 0;
}

function looksCasterLevelScaled(options, instances) {
    const item = options?.item ?? options?.action?.item ?? options?.message?.itemSource;
    if (item?.type === 'spell') return true;

    const formulas = [];
    for (const inst of instances ?? []) {
        if (typeof inst?.formula === 'string') formulas.push(inst.formula);
    }
    for (const part of getMessageDamageParts(options)) {
        if (typeof part?.formula === 'string') formulas.push(part.formula);
        if (typeof part?.roll?.formula === 'string') formulas.push(part.roll.formula);
    }
    return formulas.some((f) => /@cl|\/\s*level|caster\s*level|per\s*level/i.test(f));
}

function getRuleWoundMagnitude(options, instances, actor, fallbackValue) {
    const casterLevel = inferCasterLevel(options, actor);
    const rollData = rollDataWithRuntimeLevels(options?.action?.shared?.rollData
        ?? options?.action?.getRollData?.()
        ?? options?.item?.getRollData?.()
        ?? actor?.getRollData?.()
        ?? {}, { casterLevel });
    const diceCount = countDiceFromMessageParts(options) || countDiceFromInstances(instances, rollData);
    if (diceCount > 0) return diceCount;

    const formulas = new Set();
    for (const part of getMessageDamageParts(options)) {
        if (typeof part?.formula === 'string') formulas.add(part.formula);
        if (typeof part?.roll?.formula === 'string') formulas.add(part.roll.formula);
    }
    for (const inst of instances ?? []) {
        if (typeof inst?.formula === 'string') formulas.add(inst.formula);
        if (typeof inst?.roll?.formula === 'string') formulas.add(inst.roll.formula);
    }

    let clEquivalentTotal = 0;
    for (const formula of formulas) {
        clEquivalentTotal += getCasterLevelEquivalentFromFormula(formula, { rollData, casterLevel });
    }
    if (clEquivalentTotal > 0) return clEquivalentTotal;

    if (looksCasterLevelScaled(options, instances) && casterLevel > 0) {
        return casterLevel;
    }

    return Math.max(0, Math.floor(Math.abs(Number(fallbackValue) || 0)));
}

function getApplyModeFromElement(options) {
    const mode = options?.element?.closest?.('.chat-attack')?.getAttribute?.('data-nas-health-mode');
    return mode === 'wounds' ? 'wounds' : 'vigor';
}

function resistanceCheckWouldForceDialog(options) {
    const moduleId = "pf1-resistance-check";
    if (!game.modules.get(moduleId)?.active) return false;
    if (options?._nasDamageDialog) return false;

    try {
        if (!game.settings.get(moduleId, "enableCheck")) return false;
    } catch (_err) {
        return false;
    }

    const relevantKeys = ["dr", "di", "dv", "eres", "cr", "ci"];
    const keysToCheck = [];
    for (const key of relevantKeys) {
        try {
            if (game.settings.get(moduleId, `check${key}`)) {
                keysToCheck.push(key);
            }
        } catch (_err) {
        }
    }
    if (!keysToCheck.length) return false;

    const evt = options?.event ?? globalThis.event;
    if (evt?.shiftKey || evt?.ctrlKey || evt?.metaKey) return false;

    const emptyIWR = {
        ci: [],
        cres: "",
        di: [],
        dr: { value: [], custom: "" },
        dv: [],
        eres: { value: [], custom: "" }
    };

    for (const token of canvas?.tokens?.controlled ?? []) {
        const traits = token?.actor?.toObject?.()?.system?.traits;
        if (!traits) continue;
        const traitDiffKeys = Object.keys(foundry.utils.diffObject(emptyIWR, traits));
        if (traitDiffKeys.some((k) => keysToCheck.includes(k))) return true;
    }

    return false;
}

function resolveCriticalWoundBonus({ options, actor, applyDamageOpts, appliedValue, preVigor, preTemp, isCritical }) {
    if (!isCritical) return 0;
    if (!isWoundsVigorActive(actor)) return 0;
    if (isWvNoWoundsActor(actor)) return 0;
    if (options?.asNonlethal) return 0;

    const critMult = Math.max(0, Number(options?.critMult ?? applyDamageOpts?.critMult ?? 0) || 0);
    if (critMult <= 0) return 0;

    if (options?.asWounds) return critMult;

    let finalDamage = Math.floor(Math.max(0, appliedValue) * (applyDamageOpts?.ratio ?? 1));
    finalDamage -= Math.min(finalDamage, applyDamageOpts?.reduction ?? 0);
    finalDamage = Math.floor(finalDamage);
    const vigorBuffer = Math.max(0, Number(preVigor) || 0) + Math.max(0, Number(preTemp) || 0);
    if (finalDamage > vigorBuffer) return 0;

    return critMult;
}

function recordDamageCombatTextContext(actor, options = {}) {
    if (options?.isCritical !== true) return;
    recordCombatTextContext(actor, {
        isCritical: true,
        critMult: options?.critMult,
        messageUuid: options?.message?.uuid ?? options?.reference ?? null,
        attackIndex: options?.attackIndex
    });
}

function numericHpValue(actor) {
    const value = Number(actor?.system?.attributes?.hp?.value);
    return Number.isFinite(value) ? value : 0;
}

function numericHpMax(actor) {
    const value = Number(actor?.system?.attributes?.hp?.max);
    return Number.isFinite(value) ? value : 0;
}

function tokenDocumentKey(tokenDocument) {
    return String(tokenDocument?.uuid ?? tokenDocument?.id ?? "");
}

function messageTargetTokenDocuments(message) {
    const ids = message?.system?.targets;
    if (!Array.isArray(ids) || !ids.length) return [];
    return ids.map((id) => {
        return canvas?.scene?.tokens?.get?.(id) ?? globalThis.fromUuidSync?.(id) ?? null;
    }).filter(Boolean);
}

function hasInvalidControlledTargets(options = {}) {
    const cardTargets = messageTargetTokenDocuments(options.message);
    const controlled = Array.from(canvas?.tokens?.controlled ?? []).map((token) => token.document).filter(Boolean);
    if (!cardTargets.length || !controlled.length) return false;
    const cardTargetKeys = new Set(cardTargets.map(tokenDocumentKey).filter(Boolean));
    return controlled.some((tokenDocument) => !cardTargetKeys.has(tokenDocumentKey(tokenDocument)));
}

function buildChatApplyDamageData(message, eventLike) {
    const button = eventLike?.currentTarget ?? eventLike?.target;
    if (button?.dataset?.action !== "applyDamage") return null;

    let asNonlethal;
    if (message?.system?.config?.nonlethal) asNonlethal = true;
    const tags = new Set(button.dataset.tags?.split(";") ?? []);
    if (tags.has("nonlethal")) asNonlethal = true;

    const value = parseInt(button.dataset.value);
    if (Number.isNaN(value)) return null;

    const attackIndex = parseInt(button.closest("[data-index]")?.dataset.index);
    const attackType = button.dataset.type;
    const attack = message?.systemRolls?.attacks?.[attackIndex];
    const isCritical = attackType === "critical";
    const instances = [];
    const addInstances = (damageRolls, role) => {
        if (!damageRolls) return;
        for (const dmg of damageRolls) {
            const d = new pf1.models.action.DamagePartModel(dmg.damageType.toObject());
            d.value = dmg.total;
            d._nasDamageRole = role;
            instances.push(d);
        }
    };

    if (attack) {
        addInstances(attack.damage, "base");
        if (isCritical) addInstances(attack.critDamage, "critical");
    }

    const item = message.itemSource;
    const action = message.actionSource;
    return {
        value,
        options: {
            asNonlethal,
            event: eventLike,
            element: button,
            message,
            item,
            action,
            attackIndex,
            reference: message.uuid,
            isCritical,
            critMult: isCritical ? (message.system.config.critMult ?? 0) : 0,
            instances,
            interactive: true
        }
    };
}

export async function applyNasHeadlessDamage(value = 0, options = {}) {
    if (!game.settings.get(MODULE.ID, "enableDamageAutomation")) {
        return { handled: false };
    }

    if (value === 0 || !Number.isFinite(value)) return { handled: false };

    if (isWoundsVigorAutomationEnabled() && !options.asWounds && getApplyModeFromElement(options) === "wounds") {
        options = { ...options, asWounds: true };
    }

    let showDialog = (typeof options.dialog === "boolean") ? options.dialog : false;
    if (options.event?.shiftKey) showDialog = !showDialog;
    if (showDialog) return { handled: false };

    if (resistanceCheckWouldForceDialog(options)) {
        return { handled: false, options: { ...options, dialog: true } };
    }

    if (!pf1?.applications?.ApplyDamage) return { handled: false };

    if (hasInvalidControlledTargets(options)) {
        return { handled: false };
    }

    const targets = normalizeTargets(options);
    if (!targets.length) return { handled: true, result: false };

    const isHealing = (value < 0) || options.isHealing === true;
    const sourceActor = resolveSourceActorFromOptions(options);
    const sourceItem = options?.item ?? options?.action?.item ?? options?.message?.itemSource ?? null;

    const hasExplicitTargets = options?.targets != null;
    const hasClickContext = options?.element != null || options?.event != null || options?.message != null;
    if (isHealing && hasExplicitTargets && !hasClickContext) {
        return { handled: false };
    }

    let ratio = Number(options?.ratio);
    if (!(Number.isFinite(ratio) && ratio > 0)) {
        const elRatio = Number(options?.element?.dataset?.ratio);
        if (Number.isFinite(elRatio) && elRatio > 0 && Array.isArray(options?.instances) && options.instances.length) {
            ratio = elRatio;
        }
    }
    const hasRatio = Number.isFinite(ratio) && ratio > 0 && ratio !== 1;

    const calcOpts = {
        ...options,
        targets,
        value,          
    };

    const allInstances = buildNumericInstances(Math.abs(value), calcOpts);
    const { abilityInstances, hpInstances } = splitAbilityInstances(allInstances);
    calcOpts.instances = hpInstances;

    if (abilityInstances.length && !isHealing) {
        const abilityDmg = buildAbilityDmgEntries(abilityInstances, hasRatio ? ratio : 1, false);
        for (const target of targets) {
            const traits = target.system.traits;
            const abilities = foundry.utils.deepClone(target.system.abilities);
            abilityDeltaCalculation(traits.di, traits.ci, abilities, abilityDmg);
            const updates = {};
            for (const key in abilities) {
                updates[`system.abilities.${key}.damage`] = abilities[key].damage;
                updates[`system.abilities.${key}.drain`] = abilities[key].drain;
                updates[`system.abilities.${key}.userPenalty`] = abilities[key].userPenalty;
            }
            recordDamageCombatTextContext(target, options);
            await target.update(updates);
        }
    }

    const hpValue = sumInstanceValues(hpInstances);
    if (isHealing) {
        calcOpts.value = -Math.abs(hpValue);
    } else if (hpValue > 0) {
        calcOpts.value = Math.abs(hpValue);
    } else {
        calcOpts.value = Math.abs(Number(value) || 0);
    }

    if (isHealing) {
        const promises = [];
        for (const actor of targets) {
            const targetInstances = calcOpts.instances;
            let targetValue = Math.abs(calcOpts.value);
            const targetAsWounds = Boolean(options?.asWounds) && !isWvNoWoundsActor(actor);
            const targetOpts = {
                ...calcOpts,
                targets: [actor],
                instances: targetInstances,
                value: -Math.abs(targetValue),
                asWounds: targetAsWounds
            };

            const useRuleWounds = Boolean(targetOpts?.asWounds) && isWoundsVigorActive(actor);
            const useRuleMagnitude = useRuleWounds && (isHealing || isLifeEnergyContext(targetOpts, targetInstances));
            if (useRuleMagnitude) {
                targetValue = getRuleWoundMagnitude(targetOpts, targetInstances, actor, targetValue);
                targetOpts.value = -Math.abs(targetValue);
            }

            const app = new pf1.applications.ApplyDamage(targetOpts);

            if (hasRatio) {
                for (const target of app.targets) {
                    target.ratio = ratio;
                }
                if (typeof app._refreshTargets === "function") {
                    app._refreshTargets();
                }
            }

            applyLegacyPriorityTypes(app, options, targetOpts.instances, isHealing);
            applyNasDefenseBypass(app, options, { isHealing });

            if (options?.element?.dataset && hasRatio && ratio === 0.5) {
                options.element.dataset.tooltip = "PF1.ApplyHalf";
            }

            let appliedValue = Math.max(0, app.value);
            if (app.isHealing) appliedValue = -appliedValue;
            appliedValue += app.bonus || 0;

            const targetModel = app.targets.get(actor.uuid) ?? app.targets.first();
            const applyDamageOpts = app._getTargetDamageOptions(targetModel);
            applyDamageOpts._nasDamageDialog = true;

            recordDamageCombatTextContext(actor, options);
            promises.push((async () => {
                const targetPreHp = numericHpValue(actor);
                const targetMaxHp = numericHpMax(actor);
                const requestedHealing = Math.max(0, Math.abs(Number(appliedValue) || 0));
                const result = await actor.applyDamage(appliedValue, applyDamageOpts);
                const targetPostHp = numericHpValue(actor);
                const finalHealing = Math.max(0, Math.floor(targetPostHp - targetPreHp));
                const excessByDelta = Math.max(0, Math.floor(requestedHealing - finalHealing));
                const excessByMax = Math.max(0, Math.floor(targetPreHp + requestedHealing - targetMaxHp));
                const excessHealing = Math.max(excessByDelta, excessByMax);
                const willCallReactive = Boolean(sourceActor && sourceItem && requestedHealing > 0 && (result || excessHealing > 0));
                if (willCallReactive) {
                    await applyReactiveEffectsForHit({
                        sourceActor,
                        sourceItem,
                        targetActor: actor,
                        options: {
                            ...options,
                            _nasReactiveHealing: true
                        },
                        finalDamage: 0,
                        finalHealing,
                        excessHealing,
                        targetPreHp
                    });
                }
                return result;
            })());
        }

        return { handled: true, result: Promise.all(promises) };
    }

    const promises = [];
    for (const actor of targets) {
        promises.push((async () => {
            const mirrorImage = await resolveMirrorImageForApplyDamage({
                sourceActor,
                targetActor: actor,
                options
            });
            if (mirrorImage?.blockDamage) {
                return false;
            }

            let targetInstances = calcOpts.instances;
            let targetBaseValue = Math.abs(Number(calcOpts.value) || 0);
            let targetCalcOpts = calcOpts;
            const fortification = await applyFortificationForTarget({
                actor,
                instances: targetInstances,
                options: calcOpts,
                sourceActor
            });
            if (fortification?.checked) {
                targetInstances = fortification.instances;
                targetBaseValue = Math.max(0, Math.floor(Number(fortification.value) || 0));
                targetCalcOpts = {
                    ...calcOpts,
                    ...fortification.options
                };
            }

            const dv = actor?.system?.traits?.dv;
            const vulnInstances = applyManualVulnerability(targetInstances, dv);
            const vulnTotal = sumInstanceValues(vulnInstances);
            let vulnValue = vulnTotal > 0
                ? Math.abs(vulnTotal)
                : targetBaseValue;

            const targetAsWounds = Boolean(options?.asWounds) && !isWvNoWoundsActor(actor);
            const targetOpts = {
                ...targetCalcOpts,
                targets: [actor],
                instances: vulnInstances,
                value: vulnValue,
                asWounds: targetAsWounds
            };

            const useRuleWounds = Boolean(targetOpts?.asWounds) && isWoundsVigorActive(actor);
            const useRuleMagnitude = useRuleWounds && isLifeEnergyContext(targetOpts, vulnInstances);
            if (useRuleMagnitude) {
                vulnValue = getRuleWoundMagnitude(targetOpts, vulnInstances, actor, vulnValue);
                targetOpts.value = Math.abs(vulnValue);
            }

            if (Math.abs(Number(targetOpts.value) || 0) <= 0) {
                return Boolean(fortification?.success);
            }

            const app = new pf1.applications.ApplyDamage(targetOpts);

            if (hasRatio) {
                for (const target of app.targets) {
                    target.ratio = ratio;
                }
                if (typeof app._refreshTargets === "function") {
                    app._refreshTargets();
                }
            }

            applyLegacyPriorityTypes(app, targetOpts, targetOpts.instances, false);
            applyNasDefenseBypass(app, targetOpts, { isHealing: false });

            let appliedValue = Math.max(0, app.value);
            if (app.isHealing) appliedValue = -appliedValue;
            appliedValue += app.bonus || 0;

            const targetModel = app.targets.get(actor.uuid) ?? app.targets.first();
            const applyDamageOpts = app._getTargetDamageOptions(targetModel);
            applyDamageOpts._nasDamageDialog = true;
            if (targetOpts?._nasFortificationApplied) {
                applyDamageOpts._nasFortificationApplied = true;
                applyDamageOpts.isCritical = targetOpts.isCritical === true;
                applyDamageOpts.critMult = targetOpts.critMult ?? 0;
            }

            const preVigor = Number(actor?.system?.attributes?.vigor?.value ?? 0) || 0;
            const preTemp = Number(actor?.system?.attributes?.vigor?.temp ?? 0) || 0;
            const targetPreHp = numericHpValue(actor);
            const originalApplyDamageOpts = applyDamageOpts;
            let convertedNonlethal = 0;
            let convertedTypedApplied = 0;
            let absorptionChanged = false;
            const rawFinalDamage = Math.floor(Math.max(0, Math.floor(Math.max(0, appliedValue) * (originalApplyDamageOpts?.ratio ?? 1))));
            const incomingFinalDamage = Math.floor(
                rawFinalDamage - Math.min(rawFinalDamage, originalApplyDamageOpts?.reduction ?? 0)
            );
            const absorption = await applyDamageAbsorption({
                actor,
                value: rawFinalDamage,
                applyDamageOptions: originalApplyDamageOpts,
                sourceOptions: targetOpts
            });
            applyDamageOpts._nasAbsorptionApplied = true;
            if (absorption?.changed) {
                absorptionChanged = true;
                appliedValue = Math.max(0, Math.floor(Number(absorption.value) || 0));
                convertedNonlethal = Math.max(0, Math.floor(Number(absorption.convertedNonlethal) || 0));
                applyDamageOpts.ratio = 1;
                applyDamageOpts.reduction = additionalReductionAfterAbsorption(actor, appliedValue, originalApplyDamageOpts, absorption);
                postDamageAbsorptionChatSummary({
                    actor,
                    otherActor: sourceActor,
                    incomingDamage: rawFinalDamage,
                    events: absorption.events
                });
                await showAbsorptionCombatText(actor, absorption.damageReduction);
            }

            recordDamageCombatTextContext(actor, targetOpts);
            let result = appliedValue > 0 ? await actor.applyDamage(appliedValue, applyDamageOpts) : false;
            if (convertedNonlethal > 0) {
                recordDamageCombatTextContext(actor, targetOpts);
                const nonlethalResult = await actor.applyDamage(convertedNonlethal, {
                    ...applyDamageOpts,
                    ratio: 1,
                    reduction: 0,
                    asWounds: false,
                    asNonlethal: true,
                    _nasDamageDialog: true,
                    _nasAbsorptionApplied: true
                });
                result = Boolean(result || nonlethalResult);
            }
            for (const converted of absorption?.convertedDamage ?? []) {
                const amount = Math.max(0, Math.floor(Number(converted?.amount) || 0));
                if (amount <= 0) continue;
                const convertedInstances = buildConvertedDamageInstances(amount, converted.damageType);
                const convertedResistance = nativeEnergyResistanceForApplyDamage(actor, amount, {
                    ...applyDamageOpts,
                    instances: convertedInstances,
                    asWounds: false,
                    asNonlethal: false,
                    reduction: 0
                });
                const convertedApplied = Math.max(0, amount - convertedResistance.reduction);
                convertedTypedApplied += convertedApplied;
                if (convertedApplied <= 0) continue;
                recordDamageCombatTextContext(actor, targetOpts);
                const convertedResult = await actor.applyDamage(amount, {
                    ...applyDamageOpts,
                    ratio: 1,
                    reduction: convertedResistance.reduction,
                    instances: convertedInstances,
                    asWounds: false,
                    asNonlethal: false,
                    _nasDamageDialog: true,
                    _nasAbsorptionApplied: true
                });
                result = Boolean(result || convertedResult);
            }

            const critBonus = resolveCriticalWoundBonus({
                options: targetOpts,
                actor,
                applyDamageOpts,
                appliedValue,
                preVigor,
                preTemp,
                isCritical: Boolean(targetOpts?.isCritical)
            });
            if (result && critBonus > 0) {
                recordDamageCombatTextContext(actor, targetOpts);
                await actor.applyDamage(critBonus, {
                    asWounds: true,
                    _nasDamageDialog: true
                });
            }

            let finalDamage = Math.floor(Math.max(0, appliedValue) * (applyDamageOpts?.ratio ?? 1));
            finalDamage -= Math.min(finalDamage, applyDamageOpts?.reduction ?? 0);
            finalDamage = Math.floor(finalDamage) + (absorptionChanged ? convertedNonlethal + convertedTypedApplied : 0);

            if (result && finalDamage >= 0 && !isHealing) {
                await applyReactiveEffectsForHit({
                    sourceActor,
                    sourceItem,
                    targetActor: actor,
                    options: targetOpts,
                    finalDamage,
                    targetPreHp
                });
            }

            if (result && game.settings.get(MODULE.ID, "massiveDamage")) {
                const token =
                    actor?.token?.object ??
                    actor?.token ??
                    actor?.getActiveTokens?.(true, true)?.[0] ??
                    actor?.getActiveTokens?.()?.[0] ??
                    null;

                if (token) {
                    if (finalDamage > 0) {
                        const maxHP = actor?.system?.attributes?.hp?.max ?? 0;
                        checkMassiveDamage(finalDamage, maxHP, token);
                    }
                }
            }

            return result;
        })());
    }

    return { handled: true, result: Promise.all(promises) };
}

export async function applyNasChatDamageButton(message, eventLike) {
    const button = eventLike?.currentTarget ?? eventLike?.target;
    if (button?.dataset?.action !== "applyDamage") return { handled: false };
    if (message?.flags?.[MODULE.ID]?.source === "command") return { handled: false };

    const data = buildChatApplyDamageData(message, eventLike);
    if (!data) {
        return { handled: false };
    }

    const applied = await applyNasHeadlessDamage(data.value, data.options);
    if (!applied?.handled) {
        if (applied?.options) {
            pf1?.documents?.actor?.ActorPF?.applyDamage?.(data.value, applied.options);
            button.disabled = false;
            return { handled: true, result: false };
        }
        return { handled: false };
    }

    eventLike?.preventDefault?.();
    button.disabled = false;
    return { handled: true, result: applied.result };
}

export function registerSystemApplyDamage() {
    if (!globalThis.libWrapper) return false;

    function markDialogUse(wrapped, ...args) {
        const rv = wrapped(...args);
        if (rv && typeof rv === "object") {
            rv._nasDamageDialog = true;
        }
        return rv;
    }

    libWrapper.register(
        MODULE.ID,
        "pf1.applications.ApplyDamage.prototype._getTargetDamageOptions",
        markDialogUse,
        libWrapper.WRAPPER
    );

    libWrapper.register(
        MODULE.ID,
        "pf1.documents.actor.ActorPF.prototype.applyDamage",
        async function (wrapped, value = 0, options = {}) {
            if (actorHasAbsorptionData(this)) {
            }
            let nasWrappedCallCount = 0;
            const isHealing = (value < 0) || options?.isHealing === true;
            const applyNasTempHp = async (damageValue, damageOptions = {}) => applyDamageAfterNasTemporaryHp(wrapped, this, damageValue, damageOptions);
            if (!isHealing && !options?._nasFortificationApplied) {
                const rawValue = Math.max(0, Math.floor(Math.abs(Number(value) || 0)));
                if (rawValue > 0) {
                    const fortificationInstances = buildNumericInstances(rawValue, { ...options, value: rawValue });
                    const fortification = await applyFortificationForTarget({
                        actor: this,
                        instances: fortificationInstances,
                        options: {
                            ...options,
                            value: rawValue
                        },
                        sourceActor: resolveSourceActorFromOptions(options)
                    });
                    if (fortification?.checked) {
                        options = {
                            ...options,
                            ...fortification.options,
                            instances: fortification.instances,
                            value: fortification.value
                        };
                        value = Math.max(0, Math.floor(Number(fortification.value) || 0));
                        if (fortification.success && value <= 0) {
                            await callApplyDamageNoop(wrapped, this, options);
                            return true;
                        }
                    }
                }
            }
            if (
                actorHasAbsorptionData(this)
                && !options?._nasAbsorptionApplied
                && !isHealing
                && !Boolean(options?.asWounds)
            ) {
                const rawFinalDamage = Math.floor(Math.max(0, Math.floor(Math.max(0, value) * (options?.ratio ?? 1))));
                const nativeDr = nativeDamageReductionForApplyDamage(this, rawFinalDamage, { ...options, reduction: 0 }, { ignoreNasAbsorption: true });
                const incomingFinalDamage = Math.max(0, rawFinalDamage - Math.min(rawFinalDamage, options?.reduction ?? 0) - nativeDr.reduction);
                const absorption = await applyDamageAbsorption({
                    actor: this,
                    value: rawFinalDamage,
                    applyDamageOptions: options,
                    sourceOptions: options
                });
                if (absorption?.changed) {
                    const remainingDamage = Math.max(0, Math.floor(Number(absorption.value) || 0));
                    const convertedNonlethal = Math.max(0, Math.floor(Number(absorption.convertedNonlethal) || 0));
                    const nonlethalReduction = Math.max(0, Math.floor(Number(absorption.nonlethalReduction) || 0));
                    postDamageAbsorptionChatSummary({
                        actor: this,
                        incomingDamage: rawFinalDamage,
                        events: absorption.events
                    });
                    await showAbsorptionCombatText(this, absorption.damageReduction);

                    let result = false;
                    const remainingReduction = additionalReductionAfterAbsorption(this, remainingDamage, options, absorption);
                    if (remainingDamage > 0) {
                        nasWrappedCallCount += 1;
                        const tempResult = await applyNasTempHp(remainingDamage, {
                            ...options,
                            ratio: 1,
                            reduction: remainingReduction,
                            _nasAbsorptionApplied: true
                        });
                        result = tempResult.handled ? tempResult.result : await wrapped.call(this, remainingDamage, {
                            ...options,
                            ratio: 1,
                            reduction: remainingReduction,
                            _nasAbsorptionApplied: true
                        });
                    }
                    if (convertedNonlethal > 0) {
                        nasWrappedCallCount += 1;
                        const nonlethalOptions = {
                            ...options,
                            ratio: 1,
                            reduction: 0,
                            asWounds: false,
                            asNonlethal: true,
                            _nasAbsorptionApplied: true
                        };
                        const tempResult = await applyNasTempHp(convertedNonlethal, nonlethalOptions);
                        const nonlethalResult = tempResult.handled ? tempResult.result : await wrapped.call(this, convertedNonlethal, nonlethalOptions);
                        result = Boolean(result || nonlethalResult);
                    }
                    for (const converted of absorption?.convertedDamage ?? []) {
                        const amount = Math.max(0, Math.floor(Number(converted?.amount) || 0));
                        if (amount <= 0) continue;
                        const convertedInstances = buildConvertedDamageInstances(amount, converted.damageType);
                        const convertedResistance = nativeEnergyResistanceForApplyDamage(this, amount, {
                            ...options,
                            instances: convertedInstances,
                            asWounds: false,
                            asNonlethal: false,
                            reduction: 0
                        });
                        if (amount - convertedResistance.reduction <= 0) {
                            result = true;
                            continue;
                        }
                        nasWrappedCallCount += 1;
                        const convertedOptions = {
                            ...options,
                            ratio: 1,
                            reduction: convertedResistance.reduction,
                            instances: convertedInstances,
                            asWounds: false,
                            asNonlethal: false,
                            _nasAbsorptionApplied: true
                        };
                        const tempResult = await applyNasTempHp(amount, convertedOptions);
                        const convertedResult = tempResult.handled ? tempResult.result : await wrapped.call(this, amount, convertedOptions);
                        result = Boolean(result || convertedResult);
                    }
                    if (nasWrappedCallCount === 0) {
                        await callApplyDamageNoop(wrapped, this, options);
                    }
                    return Boolean(result || nonlethalReduction > 0 || absorption.changed);
                }
                if (nativeDr.reduction > 0) {
                    if (incomingFinalDamage <= 0) {
                        await callApplyDamageNoop(wrapped, this, options);
                        return true;
                    }
                    const nativeDrOptions = {
                        ...options,
                        ratio: 1,
                        reduction: 0,
                        _nasAbsorptionApplied: true
                    };
                    const tempResult = await applyNasTempHp(incomingFinalDamage, nativeDrOptions);
                    return tempResult.handled ? tempResult.result : wrapped.call(this, incomingFinalDamage, nativeDrOptions);
                }
            }
            const tempResult = await applyNasTempHp(value, options);
            if (tempResult.handled) return tempResult.result;
            if (!options?._nasDamageDialog) return wrapped.call(this, value, options);
            if (!Boolean(options?.asWounds)) return wrapped.call(this, value, options);
            if (!isWoundsVigorActive(this)) return wrapped.call(this, value, options);

            if (isWvNoWoundsActor(this)) {
                return wrapped.call(this, value, { ...options, asWounds: false });
            }

            const instances = Array.isArray(options?.instances) ? options.instances : [];
            const useRuleMagnitude = isHealing || isLifeEnergyContext(options, instances);
            if (!useRuleMagnitude) return wrapped.call(this, value, options);

            const adjustedMagnitude = getRuleWoundMagnitude(
                options,
                instances,
                this,
                Math.abs(Number(value) || 0)
            );
            const adjustedValue = isHealing
                ? -Math.abs(adjustedMagnitude)
                : Math.abs(adjustedMagnitude);

            return wrapped.call(this, adjustedValue, options);
        },
        libWrapper.WRAPPER
    );

    return true;
}
