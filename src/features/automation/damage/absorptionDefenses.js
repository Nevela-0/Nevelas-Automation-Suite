import { buildNumericInstances, toDamagePartModel } from './instances.js';
import { applyLegacyPriorityTypes } from './priorityTypes.js';
import { applyNasDefenseBypass } from './nasBypass.js';

const amount = value => Math.max(0, Math.floor(Number(value) || 0));

export function prepareAbsorptionDefenses(actor, value, options = {}) {
    const saved = options._nasAbsorptionDefenses;
    if (saved?.actorUuid === actor?.uuid) return saved;

    if (amount(options.reduction) > 0) return null;
    const Ctor = globalThis.pf1?.applications?.ApplyDamage;
    if (!Ctor) return null;
    const instances = copyDamageInstances(buildNumericInstances(Math.abs(value), options));
    const app = new Ctor({ ...options, value: Math.abs(value), targets: [actor], instances });
    const target = app.targets.get(actor.uuid) ?? app.targets.first();
    target.ratio = options.ratio ?? 1;
    applyLegacyPriorityTypes(app, options, instances, false);
    applyNasDefenseBypass(app, options, { isHealing: false });
    return captureAbsorptionDefenses(app, target);
}

function typesOf(instance) {
    const types = instance?.typeIds ?? instance?.types ?? [];
    return Array.from(types instanceof Set || Array.isArray(types) ? types : types.values ?? []);
}

function copyInstance(instance) {
    const copy = {
        value: Number(instance?.value) || 0,
        types: typesOf(instance),
        _nasDamageRole: instance?._nasDamageRole
    };

    for (const key of ['material', 'materials', 'bypass', 'bypasses', 'bypassTypes', 'drBypassTypes']) {
        if (instance?.[key] != null) copy[key] = foundry.utils.deepClone(instance[key]);
    }
    return copy;
}

export function copyDamageInstances(instances = []) {
    return instances.map((instance) => toDamagePartModel(copyInstance(instance)));
}

function resistanceSignature(entry) {
    return JSON.stringify([typesOf(entry).sort(), String(entry.operator ?? true)]);
}

function copyResistances(entries, actor, kind) {
    const overlays = (actor?.system?.traits?.[kind]?.value ?? [])
        .filter((entry) => entry?.nas?.source === 'damageAbsorption');
    return (entries ?? []).map((entry) => {
        const overlay = overlays.find((candidate) => resistanceSignature(candidate) === resistanceSignature(entry));

        const value = overlay ? Math.min(amount(entry.value), amount(overlay.nas.ordinaryAmount)) : amount(entry.value);
        return {
            value,
            active: entry.active === true && entry.disabled !== true,
            typeIds: typesOf(entry),
            operator: entry.operator,
            custom: entry.custom,
            hasGeneric: entry.hasGeneric
        };
    }).filter((entry) => entry.value > 0);
}

export function captureAbsorptionDefenses(app, target) {
    if (!app || !target?.actor) return null;
    const instances = Array.from(app.instances ?? [], copyInstance);
    if (Number(app.bonus)) instances.push({ value: Number(app.bonus), types: [app.bonusType ?? 'untyped'] });
    return {
        actorUuid: target.actor.uuid,
        instances,
        ratio: target.ratio ?? 1,
        isMagic: app.isMagic === true,
        materials: Array.from(app.materials ?? []),
        adamantine: app.adamantine === true,
        dr: copyResistances(target.dr, target.actor, 'dr'),
        er: copyResistances(target.eres ?? target.er, target.actor, 'eres'),
        di: (target.di ?? []).map((entry) => ({ id: entry.id, active: entry.active === true && entry.disabled !== true })),
        hardness: target.hardness?.active ? amount(target.hardness.effective) : 0,
        manual: amount(target.reduction?.manual),
        general: amount(app.reduction)
    };
}

function evaluationInstance(instance) {
    const types = typesOf(instance);
    const definitions = types.map((type) => pf1.registry.damageTypes.get(type));
    const isPhysical = definitions.some((type) => type?.isPhysical);
    const isEnergy = definitions.some((type) => type?.isEnergy);
    return {
        ...copyInstance(instance),
        total: amount(instance.value),
        typeIds: new Set(types),
        isPhysical,
        isEnergy,
        isUntyped: !isPhysical && !isEnergy
    };
}

function applyCapacity(calculator, target, instances, capacity) {
    const reduction = { available: capacity };
    for (const instance of instances) calculator._applyReduction(target, instance, reduction);
}

function matchingInstances(calculator, target, instances, entry, dr) {
    return instances.filter((instance) => calculator._isReducedBy(target, instance, entry, dr));
}

export function resolveAbsorptionDefenses(context, absorption, options = {}) {
    const value = amount(absorption.value);
    const remaining = absorption.remainingInstances ?? [];
    const fallback = () => ({
        value,
        reduction: Math.min(value, amount(options.reduction)),
        instances: copyDamageInstances(remaining)
    });
    if (!context || options.asWounds || !remaining.length) return fallback();
    const prototype = pf1.applications.ApplyDamage.prototype;
    const calculator = Object.create(prototype);
    Object.assign(calculator, { isMagic: context.isMagic, materials: new Set(context.materials) });
    const instances = remaining.map(evaluationInstance);
    const target = { instances, di: context.di.map((entry) => ({ ...entry })) };
    calculator._processImmunities(target);

    const absorbedDr = (absorption.absorbedInstances ?? []).map((entry) => evaluationInstance({
        ...entry, value: entry.drReduction
    }));
    let best = null;
    for (const raw of context.dr) {
        if (!raw.active) continue;
        const entry = { ...raw, typeIds: new Set(raw.typeIds) };
        const matches = matchingInstances(calculator, target, instances, entry, true);
        const used = matchingInstances(calculator, target, absorbedDr, entry, true)
            .reduce((total, instance) => total + instance.total, 0);
        const capacity = Math.max(0, entry.value - used);
        const benefit = Math.min(capacity, matches.reduce((total, instance) => total + instance.total, 0));
        if (!best || benefit > best.benefit) best = { matches, capacity, benefit };
    }
    if (best) applyCapacity(calculator, target, best.matches, best.capacity);

    const energyEntries = context.er.filter((entry) => entry.active)
        .map((entry) => ({ ...entry, typeIds: new Set(entry.typeIds) }))
        .sort((a, b) => b.value - a.value);
    const energyGroups = new Map();
    for (const instance of instances) {
        const entry = energyEntries.find((candidate) => calculator._isReducedBy(target, instance, candidate, false));
        if (!entry) continue;
        if (!energyGroups.has(entry)) energyGroups.set(entry, []);
        energyGroups.get(entry).push(instance);
    }
    for (const [entry, matches] of energyGroups) applyCapacity(calculator, target, matches, entry.value);
    const typed = instances.filter((instance) => !instance.isUntyped);

    const hardnessTargets = instances.filter(instance => !instance.isUntyped || instance.typeIds.has('force')
        || context.holyUntyped === true && instance.typeIds.has('untyped'));
    applyCapacity(calculator, target, hardnessTargets, context.hardness);
    applyCapacity(calculator, target, typed, context.manual);
    applyCapacity(calculator, target, typed, context.general);
    const finalValue = instances.reduce((total, instance) => total + instance.total, 0);
    return {
        value,
        reduction: Math.min(value, Math.max(0, value - finalValue)),
        instances: instances.map((instance) => {
            const model = toDamagePartModel(copyInstance(instance));
            model.total = instance.total;
            return model;
        })
    };
}
