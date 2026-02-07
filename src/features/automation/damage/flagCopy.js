import { MODULE } from '../../../common/module.js';


function itemAttackFromItemFlagCopy(wrapped, item) {
    const data = wrapped(item);

    const flags = item.flags?.[MODULE.ID] || {};
    data.flags ||= {};
    data.flags[MODULE.ID] = foundry.utils.mergeObject(flags, data.flags[MODULE.ID] || {});

    const newActions = data.system?.actions;
    const copiedActions = data.flags[MODULE.ID]?.itemActionSettings?.actions;
    if (Array.isArray(newActions) && Array.isArray(copiedActions) && newActions.length === copiedActions.length) {
        for (let i = 0; i < copiedActions.length; i++) {
            copiedActions[i].id = newActions[i]._id;
        }
    }

    return data;
}

export function initItemAttackFlagCopy() {
    if (!globalThis.libWrapper) {
        console.error(`[${MODULE.ID}] libWrapper is required for item attack flag copying.`);
        return;
    }
    globalThis.libWrapper.register(
        MODULE.ID,
        'pf1.documents.item.ItemAttackPF.fromItem',
        itemAttackFromItemFlagCopy,
        'WRAPPER'
    );
} 
