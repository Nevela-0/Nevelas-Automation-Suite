import { MODULE } from "../../../../common/module.js";
import { elementFromHtmlLike } from "../../../../common/foundryCompat.js";
import { getEligibleSpellbookIds, hasEligibleSpellbooks } from "./eligibility.js";
import {
  clearSpellbookPreparationPending,
  REST_PREPARE_SPELLBOOKS_OPTION,
  setSpellbookPreparationPending
} from "./flags.js";
import { SpellbookPreparationApp } from "./app.js";
import {
  isSpellbookPreparationFullModeEnabled,
  isSpellbookRestResetEnabled,
  shouldAutoOpenSpellbookPreparationAfterRest
} from "./settings.js";

const WRAPPED_ACTOR_TYPES = ["character", "npc", "haunt", "trap", "vehicle"];

function getRestActor(app) {
  return app?.actor ?? app?.document ?? app?.object ?? null;
}

function normalizeId(value) {
  return (value ?? "").toString().trim();
}

function getActorItems(actor) {
  return Array.from(actor?.items ?? []);
}

function getSpellbook(actor, bookId) {
  const normalizedBookId = normalizeId(bookId);
  if (!normalizedBookId) return null;
  return actor?.system?.attributes?.spells?.spellbooks?.[normalizedBookId] ?? null;
}

function getSpellbookMode(actor, bookId) {
  return normalizeId(getSpellbook(actor, bookId)?.spellPreparationMode);
}

function isAtWillSpell(item) {
  return item?.system?.atWill === true;
}

function getOrCreateItemUpdate(itemUpdates, itemId) {
  const normalizedItemId = normalizeId(itemId);
  if (!normalizedItemId) return null;

  let update = itemUpdates.find((entry) => normalizeId(entry?._id) === normalizedItemId);
  if (!update) {
    update = { _id: normalizedItemId };
    itemUpdates.push(update);
  }
  return update;
}

function resetSpellItemPreparation(itemUpdates, item, mode) {
  const update = getOrCreateItemUpdate(itemUpdates, item?.id);
  if (!update) return;

  foundry.utils.setProperty(update, "system.preparation.value", 0);
  if (mode === "prepared") {
    foundry.utils.setProperty(update, "system.preparation.max", 0);
  }
}

function resetPreparedSpellbookRestItemUpdates(actor, options, _updateData, itemUpdates) {
  if (!isSpellbookRestResetEnabled()) return;
  if (options?.restoreDailyUses !== true) return;
  if (!Array.isArray(itemUpdates)) return;

  const eligibleBookIds = new Set(getEligibleSpellbookIds(actor));
  if (!eligibleBookIds.size) return;

  for (const item of getActorItems(actor)) {
    if (item?.type !== "spell" || isAtWillSpell(item)) continue;

    const bookId = normalizeId(item.system?.spellbook);
    if (!eligibleBookIds.has(bookId)) continue;

    const mode = getSpellbookMode(actor, bookId);
    if (mode !== "prepared" && mode !== "hybrid") continue;

    resetSpellItemPreparation(itemUpdates, item, mode);
  }
}

function appendPrepareSpellbookCheckbox(app, html) {
  if (!isSpellbookPreparationFullModeEnabled()) return;

  const root = elementFromHtmlLike(html);
  if (!root) return;

  const actor = getRestActor(app);
  if (!hasEligibleSpellbooks(actor)) return;
  if (root.querySelector(`input[name="${REST_PREPARE_SPELLBOOKS_OPTION}"]`)) return;

  const checkboxGroup = root.querySelector(".form-body .form-group.inline-stacked")
    ?? root.querySelector(".form-group.inline-stacked");
  if (!checkboxGroup) return;

  const label = document.createElement("label");
  label.classList.add("checkbox");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = REST_PREPARE_SPELLBOOKS_OPTION;
  input.checked = true;
  input.dataset.dtype = "Boolean";

  label.append(input, " Prepare Spellbook");
  checkboxGroup.append(label);
}

function openSpellbookPreparationApps(actor, bookIds) {
  for (const bookId of bookIds) {
    SpellbookPreparationApp.open(actor, bookId);
  }
}

async function updateSpellbookPreparationAfterRest(actor, restResult, shouldPrepareSpellbooks, shouldOpenPreparationApps) {
  if (!isSpellbookPreparationFullModeEnabled()) return;
  if (!restResult) return;

  const bookIds = getEligibleSpellbookIds(actor);
  if (shouldPrepareSpellbooks === false || bookIds.length === 0) {
    await clearSpellbookPreparationPending(actor);
    return;
  }

  await setSpellbookPreparationPending(actor, {
    bookIds,
    hours: restResult.options?.hours
  });

  if (shouldOpenPreparationApps) {
    openSpellbookPreparationApps(actor, bookIds);
  }
}

function getActorDocumentClassPath(actorType) {
  return `CONFIG.Actor.documentClasses.${actorType}.prototype.performRest`;
}

function registerPerformRestWrappers() {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications.error(`${MODULE.NAME} requires the 'libWrapper' module. Please install and activate it.`);
    return;
  }

  for (const actorType of WRAPPED_ACTOR_TYPES) {
    const actorClass = CONFIG.Actor.documentClasses?.[actorType];
    if (typeof actorClass?.prototype?.performRest !== "function") continue;

    libWrapper.register(
      MODULE.ID,
      getActorDocumentClassPath(actorType),
      async function (wrapped, options = {}, ...args) {
        const shouldPrepareSpellbooks = options?.[REST_PREPARE_SPELLBOOKS_OPTION] !== false;
        const hasSpellbookPreparationOption = Object.prototype.hasOwnProperty.call(
          options ?? {},
          REST_PREPARE_SPELLBOOKS_OPTION
        );
        const shouldOpenPreparationApps = hasSpellbookPreparationOption && shouldPrepareSpellbooks;
        const canAutoOpenPreparationApps = shouldOpenPreparationApps
          && shouldAutoOpenSpellbookPreparationAfterRest();
        const result = await wrapped.call(this, options, ...args);
        try {
          await updateSpellbookPreparationAfterRest(
            this,
            result,
            shouldPrepareSpellbooks,
            canAutoOpenPreparationApps
          );
        } catch (error) {
          console.warn(`${MODULE.ID} | Failed to update spellbook preparation rest state`, error);
        }
        return result;
      },
      "MIXED"
    );
  }
}

export function registerSpellbookPreparationRestHooks() {
  Hooks.on("renderActorRestDialog", appendPrepareSpellbookCheckbox);
  Hooks.on("pf1PreActorRest", resetPreparedSpellbookRestItemUpdates);
  registerPerformRestWrappers();
}
