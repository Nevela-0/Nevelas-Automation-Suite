import { MODULE } from '../../../common/module.js';
import { damageVulnerabilityCalculation, hasMatchingVulnerability } from './vulnerability.js';

export function getTypeIdsFromInstance(inst) {
    const raw = inst?.typeIds ?? inst?.types ?? [];
    return Array.from(raw);
}

export function toDamagePartModel(data) {
    const Ctor = pf1?.models?.action?.DamagePartModel;
    if (!Ctor) return data;
    const ensureEnumerableValue = (model, source) => {
        const rawValue = Number(source?.value ?? source?.total ?? source?.formula);
        if (!Number.isFinite(rawValue)) return;
        if (Object.prototype.hasOwnProperty.call(model, "value")) {
            model.value = rawValue;
            return;
        }
        Object.defineProperty(model, "value", {
            value: rawValue,
            writable: true,
            enumerable: true,
            configurable: true
        });
    };
    if (data instanceof Ctor) {
        ensureEnumerableValue(data, data);
        return data;
    }

    const base = data?.toObject?.() ?? data;
    const m = new Ctor(base);
    if (!Number.isFinite(m.value)) {
        ensureEnumerableValue(m, data);
    }
    return m;
}

export function buildNumericInstances(valueAbs, options) {
    const instances = Array.isArray(options.instances) ? options.instances : [];

    const hasNumeric = instances.some((i) => Number.isFinite(i?.value));
    if (hasNumeric) {
        const isClusteredShots = options.flags?.[MODULE.ID]?.clusteredShots != null;
        if (isClusteredShots) {
            return instances.map(toDamagePartModel);
        }
        return instances.map(toDamagePartModel);
    }

    const msg = options.message;
    const rolls =
        (msg?.systemRolls && Object.keys(msg.systemRolls).length) ? msg.systemRolls :
        msg?.rolls;

    const idx = Number(options.attackIndex);
    const attack = Number.isInteger(idx) ? rolls?.attacks?.[idx] : null;

    if (attack) {
        const baseParts = Array.isArray(attack.damage) ? attack.damage : [];
        const critParts = Array.isArray(attack.critDamage) ? attack.critDamage : [];
        const parts = options.isCritical ? [...baseParts, ...critParts] : baseParts;

        const out = [];
        for (const p of parts) {
            if (!Number.isFinite(p?.total)) continue;

            const dt = p?.options?.damageType;
            const types = (Array.isArray(dt) && dt.length) ? dt : ["untyped"];

            const Ctor = pf1?.models?.action?.DamagePartModel;
            if (Ctor) {
                const inst = new Ctor({ types });
                inst.value = p.total;
                out.push(inst);
            } else {
                out.push({ types, value: p.total });
            }
        }

        if (out.length) return out;
    }

    const Ctor = pf1?.models?.action?.DamagePartModel;
    if (Ctor) {
        const inst = new Ctor({ types: ["untyped"] });
        inst.value = valueAbs;
        return [inst];
    }
    return [{ types: ["untyped"], value: valueAbs }];
}

export function sumInstanceValues(instances) {
    return instances.reduce((sum, inst) => sum + (Number(inst?.value) || 0), 0);
}

export function getInstanceTypes(inst) {
    return Array.from(inst?.typeIds ?? inst?.types ?? []);
}

export function applyManualVulnerability(instances, dv) {
    if (!hasMatchingVulnerability(dv, instances)) return instances;

    const attackDamage = [];
    const damageSortObjects = [];
    const out = [];

    for (let i = 0; i < instances.length; i += 1) {
        const inst = instances[i];
        const types = getInstanceTypes(inst);
        const value = Number(inst?.value ?? inst?.total ?? inst?.formula) || 0;

        const model = toDamagePartModel({ types, value, formula: String(value) });
        out.push(model);

        attackDamage.push({ total: value });
        damageSortObjects.push({
            names: types,
            amount: value,
            index: i
        });
    }

    damageVulnerabilityCalculation(dv, attackDamage, damageSortObjects);

    for (let i = 0; i < out.length; i += 1) {
        const nextValue = Number(attackDamage[i]?.total ?? attackDamage[i]?.number);
        if (Number.isFinite(nextValue)) {
            out[i].value = nextValue;
            out[i].formula = String(nextValue);
        }
    }

    return out;
}
