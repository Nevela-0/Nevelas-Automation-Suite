import { MODULE } from "../../../common/module.js";
import { METAMAGIC_DEFINITION as StillSpell, applyStillSpell } from "./stillSpell.js";
import { METAMAGIC_DEFINITION as SilentSpell, applySilentSpell } from "./silentSpell.js";
import { METAMAGIC_DEFINITION as ExtendSpell, applyExtendSpell } from "./extendSpell.js";
import { METAMAGIC_DEFINITION as ReachSpell, applyReachSpell } from "./reachSpell.js";
import { METAMAGIC_DEFINITION as QuickenSpell, QUICKEN_SPELL_NAME, applyQuickenSpell } from "./quickenSpell.js";
import { METAMAGIC_DEFINITION as SelectiveSpell, applySelectiveSpell } from "./selectiveSpell.js";
import { METAMAGIC_DEFINITION as DazingSpell, applyDazingSpell } from "./dazingSpell.js";
import { METAMAGIC_DEFINITION as HeightenSpell, applyHeightenSpell } from "./heightenSpell.js";
import { METAMAGIC_DEFINITION as PersistentSpell, applyPersistentSpell } from "./persistentSpell.js";
import { METAMAGIC_DEFINITION as EmpowerSpell, applyEmpowerSpell } from "./empowerSpell.js";
import { METAMAGIC_DEFINITION as IntensifiedSpell, applyIntensifiedSpell } from "./intensifiedSpell.js";
import { METAMAGIC_DEFINITION as MaximizeSpell, applyMaximizeSpell } from "./maximizeSpell.js";
import { resolveMetamagicNameFromDatabase } from "./metamagic.js";

const SHORT_CAST_TYPES = new Set(["swift", "immediate", "move"]);
const STANDARD_CAST_TYPE = "standard";
const INSTANT_DURATION_UNITS = new Set(["inst", "instantaneous"]);

function canApplySelectiveSpell(context) {
  if (!context?.area?.isAreaOfEffect) return false;
  const units = (context.duration?.units ?? "").toString().toLowerCase();
  if (!INSTANT_DURATION_UNITS.has(units)) return false;
  return true;
}

function getSelectiveMaxExclusions(action) {
  const spellbook = action?.item?.system?.spellbook;
  const mod = action?.shared?.rollData?.attributes?.spells?.spellbooks?.[spellbook]?.abilityMod;
  const value = Number(mod ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function getTargetId(target) {
  const token = target?.object ?? target?.token ?? target;
  return (
    token?.document?.uuid ??
    token?.uuid ??
    token?.id ??
    target?.uuid ??
    target?.id ??
    null
  );
}

function getTargetLabel(target, fallback) {
  const token = target?.object ?? target?.token ?? target;
  return token?.name ?? token?.actor?.name ?? target?.name ?? fallback ?? "Target";
}

function promptSelectiveExclusions(targets, maxSelections) {
  return new Promise((resolve) => {
    const cards = targets
      .map((entry, index) => {
        const token = entry.target?.object ?? entry.target?.token ?? entry.target;
        const tokenImg = token?.document?.texture?.src || token?.texture?.src || "";
        const tokenName = entry.label || token?.name || token?.actor?.name || `Target ${index + 1}`;
        const disposition = token?.document?.disposition ?? token?.disposition;
        const isSameDisposition = disposition === entry?.actionTokenDisposition;
        const borderColor = isSameDisposition ? "green" : "red";
        const tag = isSameDisposition ? "Ally" : "Foe";
        return `
          <div class="selective-target-card" style="display: flex; flex-direction: column; align-items: center; width: 170px; border: 1px solid #ccc; border-radius: 6px; padding: 6px;">
            <div style="align-self: flex-start; margin-bottom: 4px;">
              <input type="checkbox" name="selectiveTarget" value="${entry.id}" />
            </div>
            <img src="${tokenImg}" style="width: 64px; height: 64px; border: 2px solid ${borderColor}; border-radius: 5px;" />
            <label style="margin: 4px 0; font-weight: 600; text-align: center;">${tokenName}</label>
            <small style="color: ${borderColor};">${tag}</small>
          </div>
        `;
      })
      .join("");
    const content = `
      <form>
        <p style="margin: 0 0 8px 0;">Exclude targets: <b><span class="nas-selective-count">0</span>/${maxSelections}</b></p>
        <div class="nas-selective-options" style="max-height: 340px; overflow-y: auto; border: 1px solid #ccc; border-radius: 6px; padding: 8px;">
          <div style="display: flex; flex-wrap: wrap; gap: 12px;">
            ${cards}
          </div>
        </div>
      </form>
    `;
    new Dialog({
      title: "Selective Spell",
      content,
      buttons: {
        ok: {
          label: "Apply",
          callback: (html) => {
            const checked = html.find('input[name="selectiveTarget"]:checked').toArray();
            resolve(checked.map((input) => input.value));
          },
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null),
        },
      },
      default: "ok",
      close: () => resolve(null),
      render: (html) => {
        const app = html.closest('.app');
        if (app?.length) {
          app.css('width', '800px');
        }
        const dlg = ui.windows?.[Object.keys(ui.windows).find((id) => ui.windows[id]?.element?.[0] === app?.[0])];
        if (dlg?.setPosition) {
          dlg.setPosition({ width: 800 });
        }
        const updateCount = () => {
          const count = html.find('input[name="selectiveTarget"]:checked').length;
          html.find('.nas-selective-count').text(count);
        };
        html.find('input[name="selectiveTarget"]').on('change', (event) => {
          const checked = html.find('input[name="selectiveTarget"]:checked').length;
          if (checked > maxSelections) {
            event.currentTarget.checked = false;
          }
          updateCount();
        });
        updateCount();
      },
    }).render(true);
  });
}

function getSpellbookData(action) {
  const actor = action?.token?.actor ?? action?.actor;
  const spellbook = action?.item?.system?.spellbook;
  if (!actor || !spellbook) return null;
  return actor.system?.attributes?.spells?.spellbooks?.[spellbook] ?? null;
}

function applyMetamagicCastTime(action, context) {
  if (!context?.activation) return;
  const spellbookData = getSpellbookData(action);
  if (!spellbookData?.spontaneous) return;
  if (!context?.metamagic?.applied?.length) return;
  if (context.metamagic.applied.includes(QUICKEN_SPELL_NAME)) return;

  const rule = game.settings.get(MODULE.ID, "metamagicCastTimeRule");
  const type = (context.activation.type ?? "").toString().toLowerCase();
  const costValue = Number(context.activation.cost ?? 1);
  const cost = Number.isFinite(costValue) && costValue > 0 ? costValue : 1;

  if (SHORT_CAST_TYPES.has(type) && rule === "standard") {
    return;
  }

  if (type === STANDARD_CAST_TYPE) {
    context.activation.type = "full";
    context.activation.cost = 1;
    if (context.activation.unchained) {
      context.activation.unchained.type = "full";
      context.activation.unchained.cost = 1;
    }
    return;
  }

  if (SHORT_CAST_TYPES.has(type)) {
    context.activation.type = "full";
    context.activation.cost = 1;
    if (context.activation.unchained) {
      context.activation.unchained.type = "full";
      context.activation.unchained.cost = 1;
    }
    return;
  }

  context.activationExtraFullRound = true;
}

function getSpellSlotData(action, slotIncrease) {
  const actor = action.token?.actor ?? action.actor;
  const spellbook = action.item?.system?.spellbook;
  const baseLevel = action.item?.system?.level ?? action.shared?.rollData?.sl ?? 0;
  const targetLevel = baseLevel + slotIncrease;

  if (!actor || !spellbook || targetLevel <= 0) {
    return null;
  }

  const spellbookData = actor.system?.attributes?.spells?.spellbooks?.[spellbook];
  const spellLevelKey = `spell${targetLevel}`;
  const spellLevelData = spellbookData?.spells?.[spellLevelKey];

  if (!spellbookData || !spellLevelData) {
    return null;
  }

  return {
    actor,
    spellbook,
    spellbookData,
    spellLevelKey,
    spellLevelData,
    targetLevel,
  };
}

async function consumeHigherSpellSlot(action, slotIncrease) {
  if (!action?.item || slotIncrease <= 0) return { skipped: true };
  if (action.item.type !== "spell") return { skipped: true };

  const slotData = getSpellSlotData(action, slotIncrease);
  if (!slotData) {
    action.shared.reject = true;
    ui.notifications.warn(
      game.i18n.format("NAS.buffs.NotEnoughSpellSlots", {
        remaining: 0,
        needed: 1,
      })
    );
    return { rejected: true };
  }

  if (!slotData.spellbookData?.spontaneous) {
    return { skipped: true, prepared: true };
  }

  const remainingSlots = Number(slotData.spellLevelData.value ?? 0);
  if (remainingSlots < 1) {
    action.shared.reject = true;
    ui.notifications.warn(
      game.i18n.format("NAS.buffs.NotEnoughSpellSlots", {
        remaining: remainingSlots,
        needed: 1,
      })
    );
    return { rejected: true };
  }

  const updatePath = `system.attributes.spells.spellbooks.${slotData.spellbook}.spells.${slotData.spellLevelKey}.value`;
  await slotData.actor.update({ [updatePath]: remainingSlots - 1 });

  if (typeof action.shared?.rollData?.chargeCost === "number") {
    action.shared.rollData.chargeCost = 0;
  }

  action.shared.rollData.chargeCostBonus =
    (action.shared.rollData.chargeCostBonus ?? 0) + slotIncrease;

  return {
    spellbook: slotData.spellbook,
    spellLevelKey: slotData.spellLevelKey,
    targetLevel: slotData.targetLevel,
    consumed: true,
  };
}

export async function applyMetamagicSelections(action, context) {
  const selections = context?.metamagicNames ?? [];
  if (!selections.length) return;

  const normalizedSelections = selections
    .map((name) => resolveMetamagicNameFromDatabase(name) ?? name)
    .filter(Boolean);

  context.metamagicNames = normalizedSelections;

  const applied = [];
  const appliedNames = context.metamagic?.applied ?? [];
  const baseSpellLevelRaw = action.item?.system?.level ?? action.shared?.rollData?.sl ?? 0;
  const baseSpellLevel = Number(baseSpellLevelRaw ?? 0);

  if (normalizedSelections.includes(StillSpell.name)) {
    applyStillSpell(context);
    applied.push({ name: StillSpell.name });
  }

  if (normalizedSelections.includes(ReachSpell.name)) {
    const steps = Number(context.metamagicOptions?.reachSpellSteps ?? 1);
    const didApply = applyReachSpell(context, Number.isFinite(steps) ? steps : 1);
    if (didApply) {
      applied.push({ name: ReachSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== ReachSpell.name);
    }
  }

  if (normalizedSelections.includes(QuickenSpell.name)) {
    const didApply = applyQuickenSpell(context);
    if (didApply) {
      applied.push({ name: QuickenSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== QuickenSpell.name);
    }
  }

  if (normalizedSelections.includes(SelectiveSpell.name)) {
    if (!canApplySelectiveSpell(context)) {
      context.metamagicNames = normalizedSelections.filter((name) => name !== SelectiveSpell.name);
    } else {
      const targets = Array.isArray(action?.shared?.targets) ? action.shared.targets : [];
      const maxExclusions = getSelectiveMaxExclusions(action);
      let excludedIds = [];
      if (maxExclusions > 0 && targets.length) {
        const actionTokenDisposition = action?.token?.disposition;
        const entries = targets
          .map((target, index) => ({
            id: getTargetId(target) ?? `target-${index}`,
            label: getTargetLabel(target, `Target ${index + 1}`),
            target,
            actionTokenDisposition,
          }))
          .filter((entry) => entry.id);
        if (entries.length) {
          const selected = await promptSelectiveExclusions(entries, maxExclusions);
          if (selected === null) {
            action.shared.reject = true;
            context.metamagicNames = normalizedSelections.filter((name) => name !== SelectiveSpell.name);
          } else {
            excludedIds = selected;
          }
        }
      }

      if (context.metamagicNames.includes(SelectiveSpell.name)) {
        applySelectiveSpell(context);
        applied.push({ name: SelectiveSpell.name });
        if (excludedIds.length) {
          const excludedSet = new Set(excludedIds);
          action.shared.targets = targets.filter((target) => !excludedSet.has(getTargetId(target)));
          context.metamagicOptions = {
            ...(context.metamagicOptions ?? {}),
            selectiveExcluded: excludedIds,
          };
        }
      }
    }
  }

  if (normalizedSelections.includes(DazingSpell.name)) {
    const didApply = await applyDazingSpell(context, action, {
      rounds: Number.isFinite(baseSpellLevel) ? baseSpellLevel : 0,
    });
    if (didApply) {
      applied.push({ name: DazingSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== DazingSpell.name);
    }
  }

  if (normalizedSelections.includes(HeightenSpell.name)) {
    const selectedLevel = Number(context.metamagicOptions?.heightenSpellLevel ?? 0);
    const didApply = applyHeightenSpell(context, {
      originalLevel: Number.isFinite(baseSpellLevel) ? baseSpellLevel : 0,
      targetLevel: Number.isFinite(selectedLevel) ? selectedLevel : 0,
    });
    if (didApply) {
      applied.push({ name: HeightenSpell.name });
      if (action.shared?.rollData) {
        action.shared.rollData.sl = context.spellLevel?.effective ?? action.shared.rollData.sl;
      }
      if (typeof action?.action?.getDC === "function") {
        action.shared.saveDC = action.action.getDC(action.shared.rollData);
      }
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== HeightenSpell.name);
    }
  }

  if (normalizedSelections.includes(PersistentSpell.name)) {
    const didApply = applyPersistentSpell(context);
    if (didApply) {
      applied.push({ name: PersistentSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== PersistentSpell.name);
    }
  }

  if (normalizedSelections.includes(ExtendSpell.name)) {
    const didApply = applyExtendSpell(context);
    if (didApply) {
      applied.push({ name: ExtendSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== ExtendSpell.name);
    }
  }

  if (normalizedSelections.includes(IntensifiedSpell.name)) {
    const clValue = action.shared?.rollData?.cl;
    const didApply = applyIntensifiedSpell(context, clValue);
    if (didApply) {
      applied.push({ name: IntensifiedSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== IntensifiedSpell.name);
    }
  }

  if (normalizedSelections.includes(MaximizeSpell.name)) {
    const didApply = applyMaximizeSpell(context);
    if (didApply) {
      applied.push({ name: MaximizeSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== MaximizeSpell.name);
    }
  }

  if (normalizedSelections.includes(EmpowerSpell.name)) {
    const didApply = applyEmpowerSpell(context);
    if (didApply) {
      applied.push({ name: EmpowerSpell.name });
    } else {
      context.metamagicNames = normalizedSelections.filter((name) => name !== EmpowerSpell.name);
    }
  }

  if (normalizedSelections.includes(SilentSpell.name)) {
    const learnedAt = action.item?.system?.learnedAt?.class;
    const learnedList = Array.isArray(learnedAt)
      ? learnedAt
      : learnedAt
        ? [learnedAt]
        : [];
    const hasBard = learnedList.some((entry) => entry?.toString?.().toLowerCase().includes("bard"));
    if (hasBard) {
      ui.notifications.warn(`${SilentSpell.name} cannot be applied to bard spells.`);
      context.metamagicNames = normalizedSelections.filter((name) => name !== SilentSpell.name);
    } else {
      applySilentSpell(context);
      applied.push({ name: SilentSpell.name });
    }
  }

  if (!context.metamagic) {
    context.metamagic = { applied: [], slotIncrease: 0 };
  }

  applied.forEach((entry) => {
    if (!appliedNames.includes(entry.name)) {
      appliedNames.push(entry.name);
    }
  });
  context.metamagic.applied = appliedNames;

  applyMetamagicCastTime(action, context);

  const heightenLevel = Number(context.metamagic.heightenLevel ?? 0);
  const otherIncrease = Number(context.metamagic.slotIncrease ?? 0);
  const heightenIncrease = Number.isFinite(baseSpellLevel)
    ? Math.max(0, heightenLevel - baseSpellLevel)
    : 0;
  const totalSlotIncrease =
    (Number.isFinite(otherIncrease) ? otherIncrease : 0) +
    (Number.isFinite(heightenIncrease) ? heightenIncrease : 0);
  context.metamagic.slotIncrease = totalSlotIncrease;
  let slotResult = null;
  if (totalSlotIncrease > 0) {
    slotResult = await consumeHigherSpellSlot(action, totalSlotIncrease);
  }
}
