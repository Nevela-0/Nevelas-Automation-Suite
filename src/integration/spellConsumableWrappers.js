import { MODULE } from "../common/module.js";
import { SPELL_CONSUMABLE_SOURCE_FLAG } from "../features/automation/utils/spellConsumables.js";

let registered = false;

export function registerSpellConsumableWrappers() {
  if (registered || !game.modules.get("lib-wrapper")?.active) return;
  if (typeof globalThis.pf1?.documents?.item?.ItemSpellPF?.toConsumable !== "function") return;

  libWrapper.register(
    MODULE.ID,
    "pf1.documents.item.ItemSpellPF.toConsumable",
    async function (wrapped, spellData, ...args) {

      const sourceUuid = spellData?.type === "spell" ? [
        spellData._stats?.compendiumSource,
        spellData.flags?.core?.sourceId,
        spellData.flags?.[MODULE.ID]?.sourceId,
        spellData.uuid
      ].find(value => typeof value === "string" && value.trim())?.trim() : "";
      const converted = await wrapped.call(this, spellData, ...args);
      if (!sourceUuid || converted?.type !== "consumable"
        || !["scroll", "potion", "wand"].includes(converted.system?.subType)) return converted;

      return {
        ...converted,
        flags: {
          ...converted.flags,
          [MODULE.ID]: {
            ...converted.flags?.[MODULE.ID],
            [SPELL_CONSUMABLE_SOURCE_FLAG]: sourceUuid
          }
        }
      };
    },
    "WRAPPER"
  );
  registered = true;
}
