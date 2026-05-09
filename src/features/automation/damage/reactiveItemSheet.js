import { MODULE } from "../../../common/module.js";
import { elementFromHtmlLike } from "../../../common/foundryCompat.js";
import { createNasId } from "../utils/nasIds.js";
import { buildReactiveOptionChoices, ReactiveOptionSelector } from "./reactiveOptionSelector.js";
import { getGrantedDefenseOptions, normalizeGrantedDefenses } from "../defenses/grantedDefenses.js";
import {
  absorptionPresetDefaults,
  absorptionPresetRules,
  absorptionPresetUsesEnergyType,
  getAbsorptionPresetEnergyOptions,
  normalizeAbsorptionPresetEnergyType,
  normalizeAbsorptionPresetId
} from "../buffs/damageAbsorptionPresets.js";

const REACTIVE_FLAG_KEY = "itemReactiveEffects";

const ON_HIT_ACTION_SHEET_KEY = "onHitByActionOverride";
const BUFF_SAVE_ACTION_SHEET_KEY = "buffSaveByAction";
const TRACKED_APPS = new Map();
const SAVE_TIMEOUTS = new Map();
let BUFF_OPTIONS_CACHE = null;

class ReactiveUiState {
  static get(appId, key) {
    return TRACKED_APPS.get(appId)?.get(key);
  }

  static set(appId, key, value) {
    if (!TRACKED_APPS.has(appId)) TRACKED_APPS.set(appId, new Map());
    TRACKED_APPS.get(appId)?.set(key, value);

    const staleIds = [...TRACKED_APPS.keys()].filter((id) => !ui.windows?.[id]);
    for (const staleId of staleIds) TRACKED_APPS.delete(staleId);
  }
}

function localize(path) {
  return game.i18n.localize(`NAS.reactive.${path}`);
}

function localizeSystem(path) {
  return game.i18n.localize(path);
}

function isItemActionSheetContext(sheet) {
  return (
    sheet?.constructor?.name === "ItemActionSheet" ||
    (Array.isArray(sheet?.options?.classes) && sheet.options.classes.includes("item-action"))
  );
}

function deepClone(value) {
  return foundry.utils.deepClone(value ?? {});
}

function normalizeTemporaryHpStackingMode(value) {
  const mode = String(value ?? "replaceSameSource");
  return ["replaceSameSource", "keepHigherSameSource", "stackSeparate"].includes(mode) ? mode : "replaceSameSource";
}

function normalizeTemporaryHpCompatibilityMode(value) {
  const mode = String(value ?? "stacksWithAll");
  return ["stacksWithAll", "noNative", "noNas", "noAny"].includes(mode) ? mode : "stacksWithAll";
}

function normalizeTemporaryHpCapMode(value) {
  const mode = String(value ?? "none");
  return ["none", "sourceMaxHp", "sourceNormalMaxHp", "targetHpPlusCon"].includes(mode) ? mode : "none";
}

function normalizeBuffSaveHandlingMode(value) {
  const mode = String(value ?? "ignore");
  return ["ignore", "failed", "successful"].includes(mode) ? mode : "ignore";
}

function normalizeBuffSaveAlliesBypassMode(value) {
  const mode = String(value ?? "setting");
  return ["setting", "enabled", "disabled"].includes(mode) ? mode : "setting";
}

function normalizeBuffSaveOverrideConfig(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    override: value.override === true,
    mode: normalizeBuffSaveHandlingMode(value.mode),
    alliesBypass: normalizeBuffSaveAlliesBypassMode(value.alliesBypass)
  };
}

function toBuffSaveOverridePayload(state = {}) {
  return {
    override: state.override === true,
    mode: normalizeBuffSaveHandlingMode(state.mode),
    alliesBypass: normalizeBuffSaveAlliesBypassMode(state.alliesBypass)
  };
}

function isHealingAction(action) {
  if (!action) return false;
  if (action.hasHealing === true || action.isHealing === true) return true;
  const actionType = String(action.actionType ?? action.type ?? "").toLowerCase();
  return actionType.includes("heal");
}

function itemActionsArray(item) {
  if (!item?.actions) return [];
  try {
    return [...item.actions];
  } catch {
    return Object.values(item.actions ?? {});
  }
}

function getSheetActionId(action) {
  return String(action?.id ?? action?._id ?? action?.action?.id ?? action?.action?._id ?? "").trim();
}

function itemHasDamageOrHealing(item) {
  const actions = itemActionsArray(item);
  return Boolean(
    item?.hasDamage
    || item?.hasHealing
    || actions.some((entry) => entry?.hasDamage || entry?.hasHealing || entry?.isHealing)
  );
}

function itemHasHealingAction(item) {
  return Boolean(item?.hasHealing || itemActionsArray(item).some((entry) => isHealingAction(entry)));
}

function normalizeOnHitModeForAction(value, { healing = false } = {}) {
  const mode = String(value ?? "formula");
  if (mode === "percentOfExcessHealing") return healing ? mode : "formula";
  return ["percentOfFinalDamage", "formula"].includes(mode) ? mode : "formula";
}

function onHitModeOptionsHtml(selected, { healing = false } = {}) {
  const current = normalizeOnHitModeForAction(selected, { healing });
  const options = [
    ["percentOfFinalDamage", localize("modePercentFinal")],
    ...(healing ? [["percentOfExcessHealing", localize("modePercentExcessHealing")]] : []),
    ["formula", game.i18n.localize("NAS.common.labels.formula")]
  ];
  return options.map(([id, label]) =>
    `<option value="${foundry.utils.escapeHTML(id)}" ${id === current ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`
  ).join("");
}

function temporaryHpStackingOptionsHtml(selected) {
  const current = normalizeTemporaryHpStackingMode(selected);
  return [
    ["replaceSameSource", localize("temporaryHpStackReplaceSameSource")],
    ["keepHigherSameSource", localize("temporaryHpStackKeepHigherSameSource")],
    ["stackSeparate", localize("temporaryHpStackSeparate")]
  ].map(([id, label]) =>
    `<option value="${foundry.utils.escapeHTML(id)}" ${id === current ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`
  ).join("");
}

function temporaryHpCapOptionsHtml(selected) {
  const current = normalizeTemporaryHpCapMode(selected);
  return [
    ["none", game.i18n.localize("NAS.common.labels.none")],
    ["sourceMaxHp", localize("temporaryHpCapSourceMaxHp")],
    ["sourceNormalMaxHp", localize("temporaryHpCapSourceNormalMaxHp")],
    ["targetHpPlusCon", localize("temporaryHpCapTargetHpPlusCon")]
  ].map(([id, label]) =>
    `<option value="${foundry.utils.escapeHTML(id)}" ${id === current ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`
  ).join("");
}

function temporaryHpCompatibilityOptionsHtml(selected) {
  const current = normalizeTemporaryHpCompatibilityMode(selected);
  return [
    ["stacksWithAll", localize("temporaryHpCompatStacksWithAll")],
    ["noNative", localize("temporaryHpCompatNoNative")],
    ["noNas", localize("temporaryHpCompatNoNas")],
    ["noAny", localize("temporaryHpCompatNoAny")]
  ].map(([id, label]) =>
    `<option value="${foundry.utils.escapeHTML(id)}" ${id === current ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`
  ).join("");
}

function buffSaveHandlingOptionsHtml(selected) {
  const current = normalizeBuffSaveHandlingMode(selected);
  return [
    ["ignore", localize("buffSaveHandlingIgnore")],
    ["failed", localize("buffSaveHandlingFailed")],
    ["successful", localize("buffSaveHandlingSuccessful")]
  ].map(([id, label]) =>
    `<option value="${foundry.utils.escapeHTML(id)}" ${id === current ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`
  ).join("");
}

function buffSaveAlliesBypassOptionsHtml(selected) {
  const current = normalizeBuffSaveAlliesBypassMode(selected);
  return [
    ["setting", localize("buffSaveAlliesSetting")],
    ["enabled", localizeSystem("PF1.Enabled")],
    ["disabled", localizeSystem("PF1.Disabled")]
  ].map(([id, label]) =>
    `<option value="${foundry.utils.escapeHTML(id)}" ${id === current ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`
  ).join("");
}

function normalizeLifestealTemporaryHpDuration(raw = {}) {
  const duration = raw && typeof raw === "object" ? raw : {};
  const timePeriods = globalThis.CONFIG?.PF1?.timePeriods ?? {};
  const fallbackUnits = timePeriods.hour ? "hour" : Object.keys(timePeriods)[0] ?? "hour";
  const units = String(duration.units ?? fallbackUnits);
  return {
    enabled: duration.enabled === true || duration.value != null || duration.units != null,
    value: String(duration.value ?? "1"),
    units: timePeriods[units] ? units : fallbackUnits
  };
}

function lifestealTemporaryHpDurationPayload(duration = {}) {
  const normalized = normalizeLifestealTemporaryHpDuration(duration);
  if (!normalized.enabled) return null;
  return {
    enabled: true,
    value: normalized.value,
    units: normalized.units
  };
}

function localizeMaybe(value) {
  const text = String(value ?? "");
  return game.i18n.has(text) ? game.i18n.localize(text) : text;
}

function timePeriodOptionsHtml(selected) {
  const timePeriods = globalThis.CONFIG?.PF1?.timePeriods ?? {};
  const entries = Object.entries(timePeriods).length
    ? Object.entries(timePeriods)
    : [
        ["round", game.i18n.localize("PF1.TimePeriods.round.Label")],
        ["minute", game.i18n.localize("PF1.TimePeriods.minute.Label")],
        ["hour", game.i18n.localize("PF1.TimePeriods.hour.Label")],
        ["day", game.i18n.localize("PF1.TimePeriods.day.Label")]
      ];
  return entries.map(([id, rawLabel]) => {
    const label = typeof rawLabel === "object"
      ? localizeMaybe(rawLabel.label ?? rawLabel.Label ?? rawLabel.name ?? rawLabel.Name ?? id)
      : localizeMaybe(rawLabel);
    return `<option value="${foundry.utils.escapeHTML(id)}" ${id === selected ? "selected" : ""}>${foundry.utils.escapeHTML(label)}</option>`;
  }).join("");
}

function excludeNasChangeFromParentForm(event) {
  event?.stopPropagation?.();
}

function scheduleNasScrollRestoreRetry(sheet) {
  queueMicrotask(() => {
    if (!sheet || typeof sheet._restoreScrollPositions !== "function") return;
    const raw = sheet.element;
    const jq = raw?.jquery ? raw : typeof jQuery === "function" ? jQuery(raw?.[0] ?? raw) : null;
    if (!jq?.find) return;
    try {
      sheet._restoreScrollPositions(jq);
    } catch (_e) {
      return;
    }
  });
}

function syncReactiveSectionCollapsedChrome(section, expanded) {
  const body = section?.querySelector?.("[data-nas-reactive-body]");
  const header = section?.querySelector?.(".nas-reactive-section-header");
  if (body) body.style.display = expanded ? "" : "none";
  if (!header) return;
  if (expanded) {
    header.style.borderBottom = "";
  } else {
    header.style.borderBottom = "none";
  }
}

function findDetailsTab(root) {
  return root?.querySelector?.('.tab.details[data-group="primary"]') ?? null;
}

function findAdvancedHeaderInTab(tab) {
  if (!tab) return null;
  const advancedLabel = game.i18n.localize("PF1.Advanced").trim().toLowerCase();
  return (
    [...tab.querySelectorAll("h3.form-header")].find(
      (el) => (el.textContent ?? "").trim().toLowerCase() === advancedLabel
    ) ?? null
  );
}

function insertOnHitAtDetailsTabBottom(detailsTab, section) {
  const onStruck = detailsTab.querySelector(".nas-onstruck-effects");
  if (onStruck) {
    detailsTab.insertBefore(section, onStruck);
    return;
  }
  const advanced = findAdvancedHeaderInTab(detailsTab);
  if (advanced) {
    detailsTab.insertBefore(section, advanced);
    return;
  }
  detailsTab.appendChild(section);
}

function findLastActionTabSiblingInSection(fromHeader) {
  let n = fromHeader.nextElementSibling;
  let last = null;
  while (n) {
    if (n.matches?.("h3.form-header")) break;
    if (n.matches?.(".form-group, .form-groups") || n.classList?.contains?.("damage")) {
      last = n;
    }
    n = n.nextElementSibling;
  }
  return last;
}

function findActionTabDamageHealingFormHeader(hostTab) {
  const set = new Set();
  for (const key of ["PF1.DamageHealing", "PF1.DmgHealing", "PF1.DmgAndHealing", "PF1.ActionDamage", "PF1.Damage"]) {
    try {
      const t = game.i18n.localize(key)?.trim?.();
      if (t) set.add(t.toLowerCase());
    } catch {
    }
  }
  for (const h3 of hostTab.querySelectorAll("h3.form-header")) {
    const text = (h3.textContent ?? "").trim().toLowerCase();
    if (set.size && set.has(text)) return h3;
  }
  for (const h3 of hostTab.querySelectorAll("h3.form-header")) {
    const text = (h3.textContent ?? "").trim().toLowerCase();
    if (text.includes("damage") && (text.includes("heal") || text.includes("healing"))) return h3;
  }
  return null;
}

function insertOnHitInActionTab(hostTab, section) {
  const powerAttackInput = hostTab.querySelector('input[name="powerAttack.multiplier"]');
  const powerAttackGroup = powerAttackInput?.closest(".form-group") ?? null;
  const powerAttackHeader = powerAttackGroup?.previousElementSibling ?? null;
  if (powerAttackHeader?.matches?.("h3.form-header")) {
    hostTab.insertBefore(section, powerAttackHeader);
    return;
  }

  const damageBlocks = [...hostTab.querySelectorAll(".damage[data-key]")];
  if (damageBlocks.length > 0) {
    const lastBlock = damageBlocks[damageBlocks.length - 1];
    hostTab.insertBefore(section, lastBlock.nextSibling);
    return;
  }

  const damageHealingHeader = findActionTabDamageHealingFormHeader(hostTab);
  if (damageHealingHeader) {
    const lastInSection = findLastActionTabSiblingInSection(damageHealingHeader);
    const anchor = lastInSection ?? damageHealingHeader;
    hostTab.insertBefore(section, anchor.nextSibling);
    return;
  }

  hostTab.appendChild(section);
}

function getDamageTypeOptions() {
  const out = [{ id: "untyped", label: localizeSystem("PF1.DamageTypes.untyped.Label") }];
  for (const [, value] of pf1?.registry?.damageTypes?.entries?.() ?? []) {
    const id = String(value?.id ?? "").trim();
    if (!id) continue;
    out.push({ id, label: value?.name ?? id });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function titleCaseOptionLabel(id, fallback) {
  const text = String(fallback ?? id ?? "").trim();
  if (!text) return "";
  return text.replace(/\p{L}[\p{L}'-]*/gu, (word) => word.charAt(0).toLocaleUpperCase() + word.slice(1));
}

function getAbsorptionWeaponTypeOptions() {
  return [
    { id: "", label: localizeSystem("PF1.Any") },
    { id: "natural", label: localizeSystem("PF1.WeaponGroup.natural") },
    { id: "simple", label: localizeSystem("PF1.Subtypes.Item.weapon.simple.Single") },
    { id: "martial", label: localizeSystem("PF1.Subtypes.Item.weapon.martial.Single") },
    { id: "exotic", label: localizeSystem("PF1.Subtypes.Item.weapon.exotic.Single") },
    { id: "light", label: localizeSystem("PF1.WeaponSubtypeLight") },
    { id: "one-handed", label: localizeSystem("PF1.WeaponSubtypeOneHanded") },
    { id: "two-handed", label: localizeSystem("PF1.WeaponSubtypeTwoHanded") },
    { id: "ranged", label: localizeSystem("PF1.WeaponSubtypeRanged") },
    { id: "thrown", label: localizeSystem("PF1.WeaponGroup.thrown") }
  ];
}

async function getBuffOptions() {
  if (Array.isArray(BUFF_OPTIONS_CACHE)) return BUFF_OPTIONS_CACHE;
  const selected = game.settings.get(MODULE.ID, "customBuffCompendia") || [];
  const includeWorld = selected.includes("__world__");
  const compendia = selected.filter((packId) => packId !== "__world__");
  const out = [];

  for (const packId of compendia) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    let index = [];
    try {
      index = await pack.getIndex();
    } catch (_err) {
      index = [];
    }
    const entries = index.filter((entry) => entry.type === "buff");
    for (const entry of entries) {
      out.push({
        id: `Compendium.${pack.collection}.${entry._id}`,
        label: entry.name
      });
    }
  }

  if (includeWorld) {
    for (const item of game.items ?? []) {
      if (item.type !== "buff") continue;
      out.push({ id: item.uuid, label: item.name });
    }
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  BUFF_OPTIONS_CACHE = out;
  return out;
}

function getConditionOptions() {
  const out = [];
  for (const condition of pf1?.registry?.conditions ?? []) {
    const id = String(condition?._id ?? "").trim();
    if (!id) continue;
    out.push({ id, label: condition?.name ?? id });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

const ROW_ACTIONS = new Set(["applySelf", "removeSelf", "applyTarget", "removeTarget"]);

function normalizeRowAction(action) {
  const a = String(action ?? "");
  if (ROW_ACTIONS.has(a)) return a;
  if (a === "remove") return "removeSelf";
  return "applySelf";
}

function normalizeReactiveRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      id: String(row?.id ?? createNasId()),
      action: normalizeRowAction(row?.action),
      selectedIds: Array.isArray(row?.selectedIds) ? row.selectedIds.map((id) => String(id ?? "").trim()).filter(Boolean) : []
    }))
    .filter((row) => row.selectedIds.length > 0);
}

function persistReactiveRows(rows) {
  return normalizeReactiveRows(rows ?? []).map((r) => ({
    id: r.id,
    action: r.action,
    selectedIds: [...r.selectedIds]
  }));
}

function buffEffectToRowAction(effectType) {
  const t = String(effectType ?? "");
  if (t === "removeBuffAttacker") return "removeSelf";
  if (t === "applyBuffTarget") return "applyTarget";
  if (t === "removeBuffTarget") return "removeTarget";
  return "applySelf";
}

function conditionEffectToRowAction(effectType) {
  const t = String(effectType ?? "");
  if (t === "removeConditionAttacker") return "removeSelf";
  if (t === "applyConditionTarget") return "applyTarget";
  if (t === "removeConditionTarget") return "removeTarget";
  return "applySelf";
}

function buffRowsFromPersistedOrEffects(raw, effects) {
  if (raw != null && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "buffRows")) {
    return normalizeReactiveRows(raw.buffRows);
  }
  return effects
    .filter((effect) =>
      ["applyBuffAttacker", "removeBuffAttacker", "applyBuffTarget", "removeBuffTarget"].includes(String(effect?.type ?? "")) &&
      String(effect?.buffUuid ?? "")
    )
    .map((effect) => ({
      id: createNasId(),
      action: buffEffectToRowAction(effect?.type),
      selectedIds: [String(effect?.buffUuid ?? "")]
    }));
}

function conditionRowsFromPersistedOrEffects(raw, effects) {
  if (raw != null && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "conditionRows")) {
    return normalizeReactiveRows(raw.conditionRows);
  }
  return effects
    .filter((effect) =>
      ["applyConditionAttacker", "removeConditionAttacker", "applyConditionTarget", "removeConditionTarget"].includes(
        String(effect?.type ?? "")
      ) && String(effect?.conditionId ?? "")
    )
    .map((effect) => ({
      id: createNasId(),
      action: conditionEffectToRowAction(effect?.type),
      selectedIds: [String(effect?.conditionId ?? "")]
    }));
}

function attachReactiveRowEditor(section, item, state, rowKey, optionList, pickerTitle, onChange, reactiveContext = "onHit") {
  const list = section.querySelector(`[data-nas-list="${rowKey}"]`);
  const addBtn = section.querySelector(`[data-nas-add="${rowKey}"]`);
  if (!list || !addBtn) return;
  state[rowKey] = normalizeReactiveRows(state[rowKey]);
  const isOnStruck = reactiveContext === "onStruck";
  const optApplySelf = isOnStruck ? localize("actionOnStruckApplySelf") : localize("actionApplySelf");
  const optRemoveSelf = isOnStruck ? localize("actionOnStruckRemoveSelf") : localize("actionRemoveSelf");
  const optApplyAttacker = isOnStruck ? localize("actionOnStruckApplyAttacker") : localize("actionApplyTarget");
  const optRemoveAttacker = isOnStruck ? localize("actionOnStruckRemoveAttacker") : localize("actionRemoveTarget");

  const openTraitPicker = (row) => {
    if (!pf1?.applications?.ActorTraitSelector) {
      ui.notifications?.warn?.("PF1 trait selector is not available.");
      return;
    }
    const { choices, indexToId } = buildReactiveOptionChoices(optionList);
    const title = typeof pickerTitle === "string" ? pickerTitle : localize(String(pickerTitle ?? rowKey));
    new ReactiveOptionSelector({
      document: item,
      title,
      subject: `nasReactive-${rowKey}-${row.id}`,
      rowId: row.id,
      choices,
      indexToId,
      initialSelectedIds: [...row.selectedIds],
      hasCustom: false,
      onCommit: (selectedIds) => {
        row.selectedIds = selectedIds;
        render();
        onChange();
      },
    }).render(true);
  };

  const render = () => {
    list.innerHTML = "";
    for (const row of state[rowKey]) {
      const rowEl = document.createElement("div");
      rowEl.classList.add("nas-reactive-row");
      rowEl.dataset.rowId = row.id;
      rowEl.innerHTML = `
        <div class="nas-rx-fieldrow form-fields" style="display:flex;align-items:center;gap:6px;width:100%;margin:0;">
          <ul class="traits-list tag-list" data-role="tags" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-role="edit" class="nas-reactive-trait-edit" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
          <select data-role="action" style="flex:1 1 200px;min-width:min(100%,200px);max-width:280px;">
            <option value="applySelf">${optApplySelf}</option>
            <option value="removeSelf">${optRemoveSelf}</option>
            <option value="applyTarget">${optApplyAttacker}</option>
            <option value="removeTarget">${optRemoveAttacker}</option>
          </select>
          <a class="delete-row" data-role="remove" title="${localize("removeRow")}" style="flex:0 0 18px;text-align:center;"><i class="fas fa-trash"></i></a>
        </div>
      `;
      list.appendChild(rowEl);

      const tags = rowEl.querySelector('[data-role="tags"]');
      const editBtn = rowEl.querySelector('[data-role="edit"]');
      const actionSelect = rowEl.querySelector('[data-role="action"]');
      const removeBtn = rowEl.querySelector('[data-role="remove"]');

      const renderTags = () => {
        if (!row.selectedIds.length) {
          tags.innerHTML = `<li class="tag placeholder" inert>${game.i18n.localize("NAS.common.placeholders.noneSelected")}</li>`;
          return;
        }
        const labels = row.selectedIds
          .map((id) => optionList.find((option) => option.id === id)?.label ?? id)
          .sort((a, b) => a.localeCompare(b));
        tags.innerHTML = labels.map((label) => `<li class="tag">${foundry.utils.escapeHTML(label)}</li>`).join("");
      };

      editBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openTraitPicker(row);
      });
      actionSelect.value = row.action;
      actionSelect.addEventListener("change", (event) => {
        excludeNasChangeFromParentForm(event);
        row.action = normalizeRowAction(actionSelect.value);
        onChange();
      });
      removeBtn.addEventListener("click", () => {
        state[rowKey] = state[rowKey].filter((entry) => entry.id !== row.id);
        render();
        onChange();
      });

      renderTags();
    }
  };

  addBtn.addEventListener("click", () => {
    state[rowKey].push({
      id: createNasId(),
      action: "applySelf",
      selectedIds: []
    });
    render();
    onChange();
  });

  render();
}

function normalizeDamageTypeIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return ["untyped"];
  const out = ids.map((id) => String(id ?? "").trim()).filter(Boolean);
  return out.length ? [...new Set(out)] : ["untyped"];
}

function normalizeOnStruckSourceKind(value) {
  const kind = String(value ?? "anyMelee");
  if (["any", "anyMelee", "meleeWeapon", "meleeNoReach", "reachMelee", "naturalAttack", "unarmedStrike", "spell"].includes(kind)) return kind;
  if (kind === "naturalWeapon") return "naturalAttack";
  if (kind === "nonWeapon") return "spell";
  return "anyMelee";
}

function normalizeOnStruckCreatureKind(value) {
  const kind = String(value ?? "any");
  return ["any", "living", "undead", "construct", "nonliving"].includes(kind) ? kind : "any";
}

function normalizeOnStruckSave(raw = {}) {
  const type = String(raw?.type ?? raw?.saveType ?? "").toLowerCase();
  const normalizeOutcome = (value) => {
    const effectKind = String(value?.effectKind ?? "");
    return {
      effectKind: ["applyBuff", "applyCondition"].includes(effectKind) ? effectKind : "none",
      buffUuid: String(value?.buffUuid ?? ""),
      conditionId: String(value?.conditionId ?? "")
    };
  };
  return {
    enabled: raw?.enabled === true && ["fort", "ref", "will"].includes(type),
    type: ["fort", "ref", "will"].includes(type) ? type : "ref",
    dcFormula: String(raw?.dcFormula ?? raw?.dc ?? ""),
    skipDialog: raw?.skipDialog === true,
    onSuccess: ["none", "half", "negates"].includes(String(raw?.onSuccess ?? "")) ? String(raw.onSuccess) : "negates",
    effects: {
      success: normalizeOutcome(raw?.effects?.success ?? raw?.successEffect),
      failure: normalizeOutcome(raw?.effects?.failure ?? raw?.failureEffect)
    }
  };
}

function normalizeOnStruckDamageRule(raw = {}, fallback = {}) {
  const damageTypeIds = normalizeDamageTypeIds(
    Array.isArray(raw?.damageTypeIds) && raw.damageTypeIds.length
      ? raw.damageTypeIds
      : Array.isArray(raw?.damageTypes) && raw.damageTypes.length
        ? raw.damageTypes
        : Array.isArray(fallback?.damageTypeIds) && fallback.damageTypeIds.length
          ? fallback.damageTypeIds
          : ["fire"]
  );
  return {
    id: String(raw?.id ?? createNasId()),
    enabled: true,
    mode: String(raw?.mode ?? fallback?.mode ?? "formula") === "percentOfFinalDamage" ? "percentOfFinalDamage" : "formula",
    value: Number(raw?.value ?? fallback?.value) || 0,
    formula: String(raw?.formula ?? fallback?.formula ?? "1d6"),
    damageTypeIds,
    sourceKind: normalizeOnStruckSourceKind(raw?.sourceKind ?? fallback?.sourceKind),
    onlyIfDamaged: raw?.onlyIfDamaged === true,
    attackerCreatureKind: normalizeOnStruckCreatureKind(raw?.attackerCreatureKind),
    save: normalizeOnStruckSave(raw?.save),
    spendPool: raw?.spendPool === true,
    message: raw?.message !== false
  };
}

function newOnStruckDamageRule(fallback = {}) {
  return normalizeOnStruckDamageRule({
    mode: fallback.mode ?? "formula",
    value: fallback.value ?? 0,
    formula: fallback.formula ?? "1d6",
    damageTypeIds: fallback.damageTypeIds ?? ["fire"],
    sourceKind: fallback.sourceKind ?? "meleeNoReach",
    attackerCreatureKind: "any",
    save: {
      enabled: false,
      type: "ref",
      dcFormula: "",
      skipDialog: false,
      onSuccess: "negates",
      effects: {
        success: { effectKind: "none", buffUuid: "", conditionId: "" },
        failure: { effectKind: "none", buffUuid: "", conditionId: "" }
      }
    },
    spendPool: false,
    message: fallback.message !== false
  });
}

function normalizeOnStruckPool(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    totalFormula: String(raw?.totalFormula ?? ""),
    remaining: Number.isFinite(Number(raw?.remaining)) ? Math.max(0, Math.floor(Number(raw.remaining))) : null,
    capacity: Number.isFinite(Number(raw?.capacity)) ? Math.max(0, Math.floor(Number(raw.capacity))) : null,
    dischargeAtZero: raw?.dischargeAtZero === true,
    showBadge: raw?.showBadge === true
  };
}

function attachDamageTypeMultiField(section, item, state, onChange) {
  const tags = section.querySelector("[data-nas-damage-type-tags]");
  const editBtn = section.querySelector("[data-nas-damage-type-edit]");
  if (!tags || !editBtn) return;

  state.damageTypeIds = normalizeDamageTypeIds(state.damageTypeIds);
  const dtSubject = section.classList.contains("nas-onhit-effects")
    ? "nasReactive-damageTypes-onhit"
    : "nasReactive-damageTypes-onstruck";

  const renderTags = () => {
    const opts = getDamageTypeOptions();
    const labels = state.damageTypeIds
      .map((id) => opts.find((o) => o.id === id)?.label ?? id)
      .sort((a, b) => a.localeCompare(b));
    tags.innerHTML =
      labels.length > 0
        ? labels.map((label) => `<li class="tag">${foundry.utils.escapeHTML(label)}</li>`).join("")
        : `<li class="tag placeholder" inert>${game.i18n.localize("NAS.common.placeholders.noneSelected")}</li>`;
  };

  const openPicker = () => {
    if (!pf1?.applications?.ActorTraitSelector) {
      ui.notifications?.warn?.("PF1 trait selector is not available.");
      return;
    }
    const optionList = getDamageTypeOptions();
    const { choices, indexToId } = buildReactiveOptionChoices(optionList);
    new ReactiveOptionSelector({
      document: item,
      title: game.i18n.localize("NAS.common.labels.damageTypes"),
      subject: dtSubject,
      rowId: "damageTypes",
      choices,
      indexToId,
      initialSelectedIds: [...state.damageTypeIds],
      hasCustom: false,
      onCommit: (selectedIds) => {
        state.damageTypeIds = normalizeDamageTypeIds(selectedIds);
        renderTags();
        onChange();
      },
    }).render(true);
  };

  editBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPicker();
  });
  renderTags();
}

function primaryDamageHealFromEffects(effects) {
  return effects.find((effect) => ["healAttacker", "damageAttacker", "grantTemporaryHp"].includes(String(effect?.type ?? "")));
}

function inferOnHitFunction(raw, effects) {
  const explicit = String(raw?.onHitFunction ?? "").trim();
  if (explicit === "vampiricTouch") return "grantTemporaryHp";
  if (["lifesteal", "grantTemporaryHp", "none"].includes(explicit)) return explicit;
  const preset = String(raw?.preset ?? "");
  if (preset === "lifesteal") return "lifesteal";
  if (preset === "vampiricTouch") return "grantTemporaryHp";
  const primary = primaryDamageHealFromEffects(effects);
  if (primary?.type === "grantTemporaryHp") {
    return "grantTemporaryHp";
  }
  if (primary?.type === "healAttacker" && String(primary?.mode ?? "") === "percentOfFinalDamage") return "lifesteal";
  return "none";
}

function inferOnStruckFunction(raw, effects) {
  const explicit = String(raw?.onStruckFunction ?? "").trim();
  if (explicit === "none" || explicit === "damageAttacker" || explicit === "healAttacker" || explicit === "damageAbsorption") {
    return explicit;
  }
  const primary = primaryDamageHealFromEffects(effects);
  const preset = String(raw?.preset ?? "");
  if (preset === "none" && !primary) return "none";
  if ((preset === "custom" || preset === "") && !primary) return "none";
  if (preset === "fireShield" || preset === "thorns") return "damageAttacker";
  if (primary) return primary.type === "healAttacker" ? "healAttacker" : "damageAttacker";
  return "none";
}

function getReactiveFlags(item) {
  const raw = deepClone(item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY] ?? {});
  raw.onHit ??= {};
  raw.onHitByAction ??= {};
  raw[ON_HIT_ACTION_SHEET_KEY] ??= {};
  raw[BUFF_SAVE_ACTION_SHEET_KEY] ??= {};
  raw.onStruck ??= {};
  raw.absorption ??= {};
  raw.grantedDefenses ??= {};
  raw.temporaryHp ??= {};
  return raw;
}

function hasPersistedReactiveConfig(raw) {
  return Boolean(raw && typeof raw === "object" && Object.keys(raw).length > 0);
}

function resolveReactivePostMessageFromRaw(raw, effects, primary) {
  if (raw != null && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "message") && typeof raw.message === "boolean") {
    return raw.message;
  }
  const list = Array.isArray(effects) ? effects : [];
  const withBool = list.find((e) => typeof e?.message === "boolean");
  if (typeof withBool?.message === "boolean") {
    return withBool.message;
  }
  return primary?.message !== false;
}

function normalizeOnHitConfig(raw = {}) {
  const effects = Array.isArray(raw?.effects) ? raw.effects : [];
  const primary = primaryDamageHealFromEffects(effects) ?? {};
  const message = resolveReactivePostMessageFromRaw(raw, effects, primary);
  const onHitFunction = inferOnHitFunction(raw, effects);
  const buffRows = buffRowsFromPersistedOrEffects(raw, effects);
  const conditionRows = conditionRowsFromPersistedOrEffects(raw, effects);
  const damageTypeIds = normalizeDamageTypeIds(
    Array.isArray(raw?.damageTypeIds) && raw.damageTypeIds.length
      ? raw.damageTypeIds
      : Array.isArray(primary?.damageTypes) && primary.damageTypes.length
        ? primary.damageTypes
        : primary?.damageType
          ? [String(primary.damageType)]
          : ["untyped"]
  );
  const normalized = {
    enabled: raw?.enabled === true,
    onHitFunction,
    mode: String(primary?.mode ?? "formula"),
    value: Number.isFinite(Number(primary?.value)) ? Number(primary.value) : 0,
    formula: String(primary?.formula ?? ""),
    lifestealTemporaryHp: primary?.asTemporaryHp === true,
    lifestealTemporaryHpDuration: normalizeLifestealTemporaryHpDuration(primary?.temporaryHpDuration ?? raw?.temporaryHpDuration),
    lifestealTemporaryHpStackingMode: normalizeTemporaryHpStackingMode(primary?.temporaryHpStackingMode ?? raw?.temporaryHpStackingMode),
    lifestealTemporaryHpCompatibilityMode: normalizeTemporaryHpCompatibilityMode(primary?.temporaryHpCompatibilityMode ?? raw?.temporaryHpCompatibilityMode),
    temporaryHpCapMode: normalizeTemporaryHpCapMode(primary?.temporaryHpCapMode ?? raw?.temporaryHpCapMode),
    damageTypeIds,
    buffRows,
    conditionRows,
    message
  };
  return normalized;
}

function normalizeOnStruckConfig(raw = {}) {
  const effects = Array.isArray(raw?.effects) ? raw.effects : [];
  const primary = primaryDamageHealFromEffects(effects) ?? {};
  const message = resolveReactivePostMessageFromRaw(raw, effects, primary);
  const onStruckFunction = inferOnStruckFunction(raw, effects);
  const buffRows = buffRowsFromPersistedOrEffects(raw, effects);
  const conditionRows = conditionRowsFromPersistedOrEffects(raw, effects);
  const damageTypeIds = normalizeDamageTypeIds(
    Array.isArray(raw?.damageTypeIds) && raw.damageTypeIds.length
      ? raw.damageTypeIds
      : Array.isArray(primary?.damageTypes) && primary.damageTypes.length
        ? primary.damageTypes
        : primary?.damageType
          ? [String(primary.damageType)]
          : ["fire"]
  );
  const legacyRuleFallback = {
    mode: String(primary?.mode ?? "formula"),
    value: Number.isFinite(Number(primary?.value)) ? Number(primary.value) : 0,
    formula: String(primary?.formula ?? "1d6"),
    damageTypeIds,
    message
  };
  const damageRules = Array.isArray(raw?.rules) && raw.rules.length
    ? raw.rules.map((rule) => normalizeOnStruckDamageRule(rule, legacyRuleFallback))
    : primary?.type === "damageAttacker"
      ? [newOnStruckDamageRule(legacyRuleFallback)]
      : [newOnStruckDamageRule(legacyRuleFallback)];
  return {
    enabled: raw?.enabled === true,
    onStruckFunction,
    mode: String(primary?.mode ?? "formula"),
    value: Number.isFinite(Number(primary?.value)) ? Number(primary.value) : 0,
    formula: String(primary?.formula ?? "1d6"),
    damageTypeIds,
    damageRules,
    pool: normalizeOnStruckPool(raw?.pool ?? raw?.onStruckPool),
    buffRows,
    conditionRows,
    message,
    meleeOnly: raw?.filters?.meleeOnly !== false,
    excludeReach: raw?.filters?.excludeReach !== false
  };
}

function normalizeAbsorptionConfig(raw = {}) {
  const preset = normalizeAbsorptionPresetId(raw?.preset);
  const defaults = absorptionPresetDefaults(preset, raw);
  const energyType = normalizeAbsorptionPresetEnergyType(preset, raw?.energyType ?? defaults.energyType);
  const totalFormula = String(raw?.totalFormula ?? defaults.totalFormula);
  const perAttackFormula = String(raw?.perAttackFormula ?? defaults.perAttackFormula);
  const fallbackRules = absorptionPresetRules(preset, perAttackFormula, { energyType });
  const rules = preset === "custom" && Array.isArray(raw?.rules) && raw.rules.length ? raw.rules : fallbackRules;
  const normalizeRuleIds = (value) => Array.isArray(value)
    ? value.map((id) => String(id ?? "").trim()).filter(Boolean)
    : String(value ?? "").split(/[,;\s]+/).map((id) => id.trim()).filter(Boolean);
  return {
    enabled: raw?.enabled === true,
    preset,
    energyType,
    totalFormula,
    perAttackFormula,
    lethalMode: String(raw?.lethalMode ?? "convertToNonlethal"),
    nonlethalMode: String(raw?.nonlethalMode ?? "dr"),
    rules: rules.map((rule) => {
      const rawAction = String(rule?.action ?? "reduce");
      const normalizedAction = preset === "custom" && rawAction === "convertToNonlethal" ? "convertToDamage" : rawAction;
      const action = ["", "reduce", "convertToDamage"].includes(normalizedAction) ? normalizedAction : "reduce";
      const defenseKind = action === "reduce" && String(rule?.defenseKind ?? "") === "er" ? "er" : action === "reduce" ? "dr" : "";
      const convertToDamageType = action === "convertToDamage" ? String(rule?.convertToDamageType || "nonlethal") : "";
      return {
        damageKind: String(rule?.damageKind ?? "any"),
        sourceKind: String(rule?.sourceKind ?? "anyAttack"),
        damageTypeIds: normalizeRuleIds(rule?.damageTypeIds),
        includeUntyped: rule?.includeUntyped === true,
        weaponType: String(rule?.weaponType ?? ""),
        action,
        convertToDamageType,
        amountFormula: preset === "custom" ? perAttackFormula : String(rule?.amountFormula ?? perAttackFormula),
        defenseKind,
        reductionBypassTypes: action === "reduce" ? normalizeRuleIds(rule?.reductionBypassTypes) : [],
        spendPool: rule?.spendPool === true,
        requiresNoOtherDr: rule?.requiresNoOtherDr === true
      };
    }),
    dischargeAtZero: raw?.dischargeAtZero !== false,
    showBadge: raw?.showBadge !== false,
    showHpBar: raw?.showHpBar === true,
    message: raw?.message !== false,
    remaining: Number.isFinite(Number(raw?.remaining)) ? Math.max(0, Math.floor(Number(raw.remaining))) : null,
    capacity: Number.isFinite(Number(raw?.capacity)) ? Math.max(0, Math.floor(Number(raw.capacity))) : null
  };
}

function applyAbsorptionPresetDefaults(absorption, preset) {
  absorption.preset = normalizeAbsorptionPresetId(preset ?? absorption?.preset);
  const defaults = absorptionPresetDefaults(absorption.preset, absorption);
  absorption.energyType = normalizeAbsorptionPresetEnergyType(absorption.preset, absorption.energyType ?? defaults.energyType);
  if (absorption.preset !== "custom") {
    absorption.totalFormula = defaults.totalFormula;
    absorption.perAttackFormula = defaults.perAttackFormula;
  }
  absorption.rules = normalizeAbsorptionConfig(absorption).rules;
  return absorption;
}

function syncAbsorptionRulesFromFields(absorption) {
  absorption.preset = normalizeAbsorptionPresetId(absorption.preset);
  absorption.energyType = normalizeAbsorptionPresetEnergyType(absorption.preset, absorption.energyType);
  if (absorption.preset !== "custom") {
    absorption.rules = normalizeAbsorptionConfig({
      preset: absorption.preset,
      energyType: absorption.energyType,
      totalFormula: absorption.totalFormula,
      perAttackFormula: absorption.perAttackFormula
    }).rules;
  } else {
    for (const rule of absorption.rules ?? []) {
      rule.amountFormula = absorption.perAttackFormula;
    }
  }
  return absorption;
}

function newCustomAbsorptionRule() {
  return {
    damageKind: "any",
    sourceKind: "anyAttack",
    damageTypeIds: [],
    includeUntyped: false,
    weaponType: "",
    action: "",
    convertToDamageType: "",
    defenseKind: "",
    reductionBypassTypes: [],
    spendPool: false
  };
}

function absorptionUsesDischargeTotal(absorption) {
  return absorption?.preset !== "custom" || (absorption?.rules ?? []).some((rule) => rule?.spendPool === true);
}

function renderRuleTags(tags, optionList, selectedIds) {
  if (!tags) return;
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  if (!ids.length) {
    tags.innerHTML = `<li class="tag placeholder" inert>${game.i18n.localize("NAS.common.placeholders.noneSelected")}</li>`;
    return;
  }
  tags.innerHTML = ids
    .map((id) => optionList.find((option) => option.id === id)?.label ?? id)
    .sort((a, b) => a.localeCompare(b))
    .map((label) => `<li class="tag">${foundry.utils.escapeHTML(label)}</li>`)
    .join("");
}

function openAbsorptionRulePicker({ item, title, subject, rowId, optionList, selectedIds, onCommit }) {
  if (!pf1?.applications?.ActorTraitSelector) {
    ui.notifications?.warn?.("PF1 trait selector is not available.");
    return;
  }
  const { choices, indexToId } = buildReactiveOptionChoices(optionList);
  new ReactiveOptionSelector({
    document: item,
    title,
    subject,
    rowId,
    choices,
    indexToId,
    initialSelectedIds: [...selectedIds],
    hasCustom: false,
    onCommit
  }).render(true);
}

function getRuleDefenseOptions(rule) {
  if (rule.defenseKind === "er") return getDamageTypeOptions().filter((option) => option.id !== "untyped");
  return getGrantedDefenseOptions("dr");
}

function renderAbsorptionRuleEditor(section, item, state, onChange) {
  const host = section.querySelector("[data-nas-absorption-rules]");
  if (!host) return;
  if (!Array.isArray(state.absorption.rules) || !state.absorption.rules.length) {
    state.absorption.rules = [newCustomAbsorptionRule()];
  }
  host.innerHTML = state.absorption.rules.map((rule, index) => `
    <div class="nas-absorption-rule" data-nas-absorption-rule="${index}" style="margin:0 0 4px;">
      <div class="form-group">
        <label>${localize("absorptionRuleDamageKind")}</label>
        <div class="form-fields">
          <select data-rule-key="damageKind">
            <option value="any">${localizeSystem("PF1.Any")}</option>
            <option value="lethal">${localize("absorptionRuleLethal")}</option>
            <option value="nonlethal">${localize("absorptionRuleNonlethal")}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${localize("absorptionRuleIncomingDamageTypes")}</label>
        <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
          <ul class="traits-list tag-list" data-rule-tags="damageTypeIds" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-rule-picker="damageTypeIds" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
        </div>
      </div>
      <div class="form-group">
        <label>${localizeSystem("PF1.Source")}</label>
        <div class="form-fields">
          <select data-rule-key="sourceKind">
            <option value="anyAttack">${localize("absorptionSourceAny")}</option>
            <option value="weapon">${localizeSystem("TYPES.Item.weapon")}</option>
            <option value="rangedWeapon">${localizeSystem("PF1.RangedWeapon")}</option>
            <option value="meleeWeapon">${localizeSystem("PF1.MeleeWeapon")}</option>
            <option value="naturalWeapon">${localize("absorptionSourceNatural")}</option>
            <option value="nonWeapon">${localize("absorptionSourceNonWeapon")}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${localizeSystem("PF1.WeaponType")}</label>
        <div class="form-fields">
          <select data-rule-key="weaponType">
            ${getAbsorptionWeaponTypeOptions().map((option) => `<option value="${foundry.utils.escapeHTML(option.id)}">${foundry.utils.escapeHTML(option.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${localizeSystem("PF1.Action")}</label>
        <div class="form-fields">
          <select data-rule-key="action">
            <option value="">${game.i18n.localize("NAS.common.labels.none")}</option>
            <option value="reduce">${localize("absorptionActionReduce")}</option>
            <option value="convertToDamage">${localize("absorptionActionConvertDamage")}</option>
          </select>
        </div>
      </div>
      <div class="form-group" data-rule-row="convertTo">
        <label>${localize("absorptionRuleConvertTo")}</label>
        <div class="form-fields">
          <select data-rule-key="convertToDamageType">
            ${getDamageTypeOptions().map((option) => `<option value="${foundry.utils.escapeHTML(option.id)}">${foundry.utils.escapeHTML(option.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group" data-rule-row="defense">
        <label>${localize("absorptionRuleDefense")}</label>
        <div class="form-fields">
          <select data-rule-key="defenseKind">
            <option value="dr">${localizeSystem("PF1.DamRed")}</option>
            <option value="er">${localize("grantedDefenseER")}</option>
          </select>
        </div>
      </div>
      <div class="form-group" data-rule-row="drBypass">
        <label>${localize("absorptionRuleDrBypass")}</label>
        <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
          <ul class="traits-list tag-list" data-rule-tags="reductionBypassTypes" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-rule-picker="reductionBypassTypes" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
        </div>
      </div>
      <div class="form-group" data-rule-row="erType">
        <label>${localize("absorptionRuleErType")}</label>
        <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
          <ul class="traits-list tag-list" data-rule-tags="reductionBypassTypes" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-rule-picker="reductionBypassTypes" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
        </div>
      </div>
      <div class="form-group stacked">
        <label class="checkbox" title="${localize("absorptionRuleSpendPoolHint")}">
          <input type="checkbox" data-rule-key="spendPool" ${rule.spendPool ? "checked" : ""}>
          ${localize("absorptionRuleSpendPool")}
        </label>
      </div>
      <div class="form-group">
        <label></label>
        <div class="form-fields" style="justify-content:flex-end;">
          <a data-nas-remove-absorption-rule="${index}"><i class="fas fa-trash"></i> ${localize("removeRow")}</a>
        </div>
      </div>
    </div>
  `).join("");

  for (const [index, rule] of state.absorption.rules.entries()) {
    const row = host.querySelector(`[data-nas-absorption-rule="${index}"]`);
    if (!row) continue;
    row.querySelector('[data-rule-key="damageKind"]').value = rule.damageKind ?? "any";
    row.querySelector('[data-rule-key="sourceKind"]').value = rule.sourceKind ?? "anyAttack";
    row.querySelector('[data-rule-key="weaponType"]').value = rule.weaponType ?? "";
    const action = rule.action === "convertToNonlethal" ? "convertToDamage" : rule.action ?? "reduce";
    row.querySelector('[data-rule-key="action"]').value = action;
    row.querySelector('[data-rule-key="defenseKind"]').value = rule.defenseKind === "er" ? "er" : "dr";
    row.querySelector('[data-rule-key="convertToDamageType"]').value = rule.convertToDamageType || "nonlethal";
    renderRuleTags(row.querySelector('[data-rule-tags="damageTypeIds"]'), getDamageTypeOptions(), rule.damageTypeIds);
    row.querySelectorAll('[data-rule-tags="reductionBypassTypes"]').forEach((target) => {
      renderRuleTags(target, getRuleDefenseOptions(rule), rule.reductionBypassTypes);
    });
    row.querySelector('[data-rule-row="convertTo"]').style.display = action === "convertToDamage" ? "" : "none";
    row.querySelector('[data-rule-row="defense"]').style.display = action === "reduce" ? "" : "none";
    row.querySelector('[data-rule-row="drBypass"]').style.display = action === "reduce" && (rule.defenseKind ?? "dr") !== "er" ? "" : "none";
    row.querySelector('[data-rule-row="erType"]').style.display = action === "reduce" && rule.defenseKind === "er" ? "" : "none";
  }

  host.querySelectorAll("[data-rule-key]").forEach((control) => {
    control.addEventListener("change", (event) => {
      excludeNasChangeFromParentForm(event);
      const row = control.closest("[data-nas-absorption-rule]");
      const index = Number(row?.dataset?.nasAbsorptionRule);
      const rule = state.absorption.rules[index];
      if (!rule) return;
      const key = control.dataset.ruleKey;
      if (key === "includeUntyped" || key === "spendPool") rule[key] = control.checked === true;
      else {
        rule[key] = String(control.value ?? "");
        if (key === "action" && rule[key] === "convertToDamage" && !rule.convertToDamageType) rule.convertToDamageType = "nonlethal";
        if (key === "action" && !rule[key]) {
          rule.defenseKind = "";
          rule.convertToDamageType = "";
          rule.reductionBypassTypes = [];
          rule.spendPool = false;
        }
        if (key === "action" && rule[key] && rule.spendPool !== true) rule.spendPool = true;
        if (key === "action" && rule[key] === "reduce" && !rule.defenseKind) rule.defenseKind = "dr";
        if (key === "defenseKind") rule.reductionBypassTypes = rule[key] ? [] : [];
      }
      onChange();
      renderAbsorptionRuleEditor(section, item, state, onChange);
    });
  });

  host.querySelectorAll("[data-rule-picker]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = control.closest("[data-nas-absorption-rule]");
      const index = Number(row?.dataset?.nasAbsorptionRule);
      const rule = state.absorption.rules[index];
      if (!rule) return;
      const key = control.dataset.rulePicker;
      const optionList = key === "damageTypeIds" ? getDamageTypeOptions() : getRuleDefenseOptions(rule);
      const title = key === "damageTypeIds"
        ? localize("absorptionRuleIncomingDamageTypes")
        : localize(rule.defenseKind === "er" ? "absorptionRuleErType" : "absorptionRuleDrBypass");
      openAbsorptionRulePicker({
        item,
        title,
        subject: `nasAbsorptionRule-${key}-${index}`,
        rowId: `absorption-rule-${key}-${index}`,
        optionList,
        selectedIds: rule[key] ?? [],
        onCommit: (selectedIds) => {
          rule[key] = selectedIds;
          onChange();
          renderAbsorptionRuleEditor(section, item, state, onChange);
        }
      });
    });
  });

  host.querySelectorAll("[data-save-outcome-picker]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = control.closest("[data-nas-onstruck-rule]");
      const index = Number(row?.dataset?.nasOnstruckRule);
      const rule = state.damageRules[index];
      if (!rule) return;
      rule.save = normalizeOnStruckSave(rule.save);
      const [outcome, type] = String(control.dataset.saveOutcomePicker ?? "").split("-");
      const outcomeConfig = rule.save.effects?.[outcome];
      if (!outcomeConfig) return;
      const optionList = type === "buff" ? buffOptions : conditionOptions;
      openAbsorptionRulePicker({
        item,
        title: type === "buff" ? localize("buffsHeader") : localize("conditionsHeader"),
        subject: `nasOnStruckSave-${outcome}-${type}-${index}`,
        rowId: `onstruck-save-${outcome}-${type}-${index}`,
        optionList,
        selectedIds: type === "buff"
          ? (outcomeConfig.buffUuid ? [outcomeConfig.buffUuid] : [])
          : (outcomeConfig.conditionId ? [outcomeConfig.conditionId] : []),
        onCommit: (selectedIds) => {
          const selected = String(selectedIds?.[0] ?? "");
          if (type === "buff") outcomeConfig.buffUuid = selected;
          else outcomeConfig.conditionId = selected;
          onChange();
          renderOnStruckDamageRuleEditor(section, item, state, onChange, buffOptions, conditionOptions);
        }
      });
    });
  });

  host.querySelectorAll("[data-nas-remove-absorption-rule]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(control.dataset.nasRemoveAbsorptionRule);
      state.absorption.rules.splice(index, 1);
      if (!state.absorption.rules.length) state.absorption.rules.push(newCustomAbsorptionRule());
      onChange();
      renderAbsorptionRuleEditor(section, item, state, onChange);
    });
  });
}

function renderOnStruckDamageRuleEditor(section, item, state, onChange, buffOptions = [], conditionOptions = []) {
  const host = section.querySelector("[data-nas-onstruck-rules]");
  if (!host) return;
  if (!Array.isArray(state.damageRules) || !state.damageRules.length) {
    state.damageRules = [newOnStruckDamageRule(state)];
  }
  const sourceOptions = [
    { id: "any", label: localize("onStruckSourceAny") },
    { id: "anyMelee", label: localize("onStruckSourceAnyMelee") },
    { id: "meleeNoReach", label: localize("onStruckSourceMeleeNoReach") },
    { id: "reachMelee", label: localize("onStruckSourceReachMelee") },
    { id: "meleeWeapon", label: localizeSystem("PF1.MeleeWeapon") },
    { id: "naturalAttack", label: localizeSystem("PF1.Subtypes.Item.attack.natural.Single") },
    { id: "unarmedStrike", label: localize("onStruckSourceUnarmed") },
    { id: "spell", label: localizeSystem("TYPES.Item.spell") }
  ];
  const creatureOptions = [
    { id: "any", label: localize("onStruckCreatureAny") },
    { id: "living", label: localize("onStruckCreatureLiving") },
    { id: "undead", label: localizeSystem("PF1.CreatureTypes.undead") },
    { id: "construct", label: localizeSystem("PF1.CreatureTypes.construct") },
    { id: "nonliving", label: localize("onStruckCreatureNonliving") }
  ];
  host.innerHTML = state.damageRules.map((rule, index) => `
    <div class="nas-onstruck-rule" data-nas-onstruck-rule="${index}" style="margin:0 0 6px;">
      <div class="form-group">
        <label>${localize("mode")}</label>
        <div class="form-fields">
          <select data-rule-key="mode">
            <option value="formula">${game.i18n.localize("NAS.common.labels.formula")}</option>
            <option value="percentOfFinalDamage">${localize("modePercentFinal")}</option>
          </select>
        </div>
      </div>
      <div class="form-group" data-rule-row="value">
        <label>${localizeSystem("PF1.Value")}</label>
        <div class="form-fields"><input type="number" step="1" data-rule-key="value" value="${Number(rule.value) || 0}"></div>
      </div>
      <div class="form-group" data-rule-row="formula">
        <label>${game.i18n.localize("NAS.common.labels.formula")}</label>
        <div class="form-fields"><input class="formula roll" type="text" data-rule-key="formula" value="${foundry.utils.escapeHTML(rule.formula ?? "")}" placeholder="${localize("formulaPlaceholder")}"></div>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("NAS.common.labels.damageTypes")}</label>
        <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
          <ul class="traits-list tag-list" data-rule-tags="damageTypeIds" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-rule-picker="damageTypeIds" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
        </div>
      </div>
      <div class="form-group">
        <label>${localizeSystem("PF1.Source")}</label>
        <div class="form-fields">
          <select data-rule-key="sourceKind">
            ${sourceOptions.map((option) => `<option value="${option.id}">${foundry.utils.escapeHTML(option.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${localize("onStruckRuleCreature")}</label>
        <div class="form-fields">
          <select data-rule-key="attackerCreatureKind">
            ${creatureOptions.map((option) => `<option value="${option.id}">${foundry.utils.escapeHTML(option.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group stacked">
        <label class="checkbox">
          <input type="checkbox" data-rule-key="onlyIfDamaged" ${rule.onlyIfDamaged ? "checked" : ""}>
          ${localize("onStruckOnlyIfDamaged")}
        </label>
      </div>
      <div class="form-group stacked">
        <label class="checkbox">
          <input type="checkbox" data-rule-key="saveEnabled" ${rule.save?.enabled ? "checked" : ""}>
          ${localizeSystem("PF1.SavingThrow")}
        </label>
      </div>
      <div data-rule-row="save">
        <div class="form-group">
          <label>${localize("onStruckSaveType")}</label>
          <div class="form-fields">
            <select data-rule-key="saveType">
              <option value="fort">${game.i18n.localize("PF1.SavingThrowFort")}</option>
              <option value="ref">${game.i18n.localize("PF1.SavingThrowRef")}</option>
              <option value="will">${game.i18n.localize("PF1.SavingThrowWill")}</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>${localize("onStruckSaveDc")}</label>
          <div class="form-fields"><input class="formula roll" type="text" data-rule-key="saveDcFormula" value="${foundry.utils.escapeHTML(rule.save?.dcFormula ?? "")}" placeholder="10 + @cl"></div>
        </div>
        <div class="form-group">
          <label>${localize("onStruckSaveSuccess")}</label>
          <div class="form-fields">
            <select data-rule-key="saveOnSuccess">
              <option value="negates">${localize("onStruckSaveNegates")}</option>
              <option value="half">${localize("onStruckSaveHalf")}</option>
              <option value="none">${localize("onStruckSaveNoDamageChange")}</option>
            </select>
          </div>
        </div>
        <h4 class="form-header" style="margin-top:6px;">${localize("onStruckSaveSideEffects")}</h4>
        ${["success", "failure"].map((outcome) => `
          <div class="form-group" data-rule-row="save-${outcome}-effect">
            <label>${localize(outcome === "success" ? "onStruckSaveSuccessEffect" : "onStruckSaveFailureEffect")}</label>
            <div class="form-fields">
              <select data-rule-key="save${outcome === "success" ? "Success" : "Failure"}EffectKind">
                <option value="none">${game.i18n.localize("NAS.common.labels.none")}</option>
                <option value="applyCondition">${localize("onStruckSaveApplyCondition")}</option>
                <option value="applyBuff">${localize("onStruckSaveApplyBuff")}</option>
              </select>
            </div>
          </div>
          <div class="form-group" data-rule-row="save-${outcome}-condition">
            <label>${localize("conditionToToggle")}</label>
            <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
              <ul class="traits-list tag-list" data-save-outcome-tags="${outcome}-condition" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
              <a data-save-outcome-picker="${outcome}-condition" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
            </div>
          </div>
          <div class="form-group" data-rule-row="save-${outcome}-buff">
            <label>${localize("buffToToggle")}</label>
            <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
              <ul class="traits-list tag-list" data-save-outcome-tags="${outcome}-buff" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
              <a data-save-outcome-picker="${outcome}-buff" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
            </div>
          </div>
        `).join("")}
        <div class="form-group stacked">
          <label class="checkbox">
            <input type="checkbox" data-rule-key="saveSkipDialog" ${rule.save?.skipDialog ? "checked" : ""}>
            ${localize("onStruckSaveSkipDialog")}
          </label>
        </div>
      </div>
      <div class="form-group stacked">
        <label class="checkbox">
          <input type="checkbox" data-rule-key="spendPool" ${rule.spendPool ? "checked" : ""}>
          ${localize("onStruckSpendPool")}
        </label>
      </div>
      <div data-rule-row="pool">
        <div class="form-group">
          <label title="${localize("onStruckPoolTotalHint")}">${localize("onStruckPoolTotal")}</label>
          <div class="form-fields">
            <input class="formula roll" type="text" data-rule-key="poolTotalFormula" value="${foundry.utils.escapeHTML(state.pool?.totalFormula ?? "")}" placeholder="min(50, 5 * @cl)" title="${localize("onStruckPoolTotalHint")}">
          </div>
        </div>
        <div class="form-group stacked">
          <label class="checkbox">
            <input type="checkbox" data-rule-key="poolDischargeAtZero" ${state.pool?.dischargeAtZero === true ? "checked" : ""}>
            ${localize("onStruckPoolDischargeAtZero")}
          </label>
          <label class="checkbox">
            <input type="checkbox" data-rule-key="poolShowBadge" ${state.pool?.showBadge === true ? "checked" : ""}>
            ${localize("onStruckPoolShowBadge")}
          </label>
        </div>
      </div>
      <div class="form-group">
        <label></label>
        <div class="form-fields" style="justify-content:flex-end;">
          <a data-nas-remove-onstruck-rule="${index}"><i class="fas fa-trash"></i> ${localize("removeRow")}</a>
        </div>
      </div>
    </div>
  `).join("");

  for (const [index, rule] of state.damageRules.entries()) {
    const row = host.querySelector(`[data-nas-onstruck-rule="${index}"]`);
    if (!row) continue;
    row.querySelector('[data-rule-key="mode"]').value = rule.mode ?? "formula";
    row.querySelector('[data-rule-key="sourceKind"]').value = normalizeOnStruckSourceKind(rule.sourceKind);
    row.querySelector('[data-rule-key="attackerCreatureKind"]').value = normalizeOnStruckCreatureKind(rule.attackerCreatureKind);
    row.querySelector('[data-rule-key="saveType"]').value = normalizeOnStruckSave(rule.save).type;
    row.querySelector('[data-rule-key="saveOnSuccess"]').value = normalizeOnStruckSave(rule.save).onSuccess;
    const save = normalizeOnStruckSave(rule.save);
    row.querySelector('[data-rule-key="saveSuccessEffectKind"]').value = save.effects.success.effectKind;
    row.querySelector('[data-rule-key="saveFailureEffectKind"]').value = save.effects.failure.effectKind;
    renderRuleTags(row.querySelector('[data-rule-tags="damageTypeIds"]'), getDamageTypeOptions(), normalizeDamageTypeIds(rule.damageTypeIds));
    renderRuleTags(row.querySelector('[data-save-outcome-tags="success-condition"]'), conditionOptions, save.effects.success.conditionId ? [save.effects.success.conditionId] : []);
    renderRuleTags(row.querySelector('[data-save-outcome-tags="failure-condition"]'), conditionOptions, save.effects.failure.conditionId ? [save.effects.failure.conditionId] : []);
    renderRuleTags(row.querySelector('[data-save-outcome-tags="success-buff"]'), buffOptions, save.effects.success.buffUuid ? [save.effects.success.buffUuid] : []);
    renderRuleTags(row.querySelector('[data-save-outcome-tags="failure-buff"]'), buffOptions, save.effects.failure.buffUuid ? [save.effects.failure.buffUuid] : []);
    row.querySelector('[data-rule-row="formula"]').style.display = rule.mode === "formula" ? "" : "none";
    row.querySelector('[data-rule-row="value"]').style.display = rule.mode === "percentOfFinalDamage" ? "" : "none";
    row.querySelector('[data-rule-row="save"]').style.display = rule.save?.enabled ? "" : "none";
    row.querySelector('[data-rule-row="save-success-condition"]').style.display = rule.save?.enabled && save.effects.success.effectKind === "applyCondition" ? "" : "none";
    row.querySelector('[data-rule-row="save-failure-condition"]').style.display = rule.save?.enabled && save.effects.failure.effectKind === "applyCondition" ? "" : "none";
    row.querySelector('[data-rule-row="save-success-buff"]').style.display = rule.save?.enabled && save.effects.success.effectKind === "applyBuff" ? "" : "none";
    row.querySelector('[data-rule-row="save-failure-buff"]').style.display = rule.save?.enabled && save.effects.failure.effectKind === "applyBuff" ? "" : "none";
    row.querySelector('[data-rule-row="pool"]').style.display = rule.spendPool ? "" : "none";
  }

  host.querySelectorAll("[data-rule-key]").forEach((control) => {
    control.addEventListener("change", (event) => {
      excludeNasChangeFromParentForm(event);
      const row = control.closest("[data-nas-onstruck-rule]");
      const index = Number(row?.dataset?.nasOnstruckRule);
      const rule = state.damageRules[index];
      if (!rule) return;
      const key = control.dataset.ruleKey;
      if (["onlyIfDamaged", "spendPool"].includes(key)) rule[key] = control.checked === true;
      else if (key === "mode") rule.mode = control.value === "percentOfFinalDamage" ? "percentOfFinalDamage" : "formula";
      else if (key === "value") rule.value = Number(control.value) || 0;
      else if (key === "formula") rule.formula = String(control.value ?? "");
      else if (key === "sourceKind") rule.sourceKind = normalizeOnStruckSourceKind(control.value);
      else if (key === "attackerCreatureKind") rule.attackerCreatureKind = normalizeOnStruckCreatureKind(control.value);
      else {
        rule.save = normalizeOnStruckSave(rule.save);
        if (key === "saveEnabled") rule.save.enabled = control.checked === true;
        if (key === "saveType") rule.save.type = String(control.value ?? "ref");
        if (key === "saveDcFormula") rule.save.dcFormula = String(control.value ?? "");
        if (key === "saveOnSuccess") rule.save.onSuccess = ["none", "half"].includes(String(control.value ?? "")) ? String(control.value) : "negates";
        if (key === "saveSkipDialog") rule.save.skipDialog = control.checked === true;
        if (key === "saveSuccessEffectKind") rule.save.effects.success.effectKind = ["applyBuff", "applyCondition"].includes(String(control.value)) ? String(control.value) : "none";
        if (key === "saveFailureEffectKind") rule.save.effects.failure.effectKind = ["applyBuff", "applyCondition"].includes(String(control.value)) ? String(control.value) : "none";
        if (key === "poolTotalFormula") state.pool.totalFormula = String(control.value ?? "");
        if (key === "poolDischargeAtZero") state.pool.dischargeAtZero = control.checked === true;
        if (key === "poolShowBadge") state.pool.showBadge = control.checked === true;
      }
      onChange();
      renderOnStruckDamageRuleEditor(section, item, state, onChange, buffOptions, conditionOptions);
    });
  });

  host.querySelectorAll("[data-rule-picker]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = control.closest("[data-nas-onstruck-rule]");
      const index = Number(row?.dataset?.nasOnstruckRule);
      const rule = state.damageRules[index];
      if (!rule) return;
      openAbsorptionRulePicker({
        item,
        title: game.i18n.localize("NAS.common.labels.damageTypes"),
        subject: `nasOnStruckRule-damageTypes-${index}`,
        rowId: `onstruck-rule-damageTypes-${index}`,
        optionList: getDamageTypeOptions(),
        selectedIds: normalizeDamageTypeIds(rule.damageTypeIds),
        onCommit: (selectedIds) => {
          rule.damageTypeIds = normalizeDamageTypeIds(selectedIds);
          onChange();
          renderOnStruckDamageRuleEditor(section, item, state, onChange, buffOptions, conditionOptions);
        }
      });
    });
  });

  host.querySelectorAll("[data-save-outcome-picker]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = control.closest("[data-nas-onstruck-rule]");
      const index = Number(row?.dataset?.nasOnstruckRule);
      const rule = state.damageRules[index];
      const [outcome, type] = String(control.dataset.saveOutcomePicker ?? "").split("-");
      if (!rule) return;
      rule.save = normalizeOnStruckSave(rule.save);
      const outcomeConfig = rule.save.effects?.[outcome];
      if (!outcomeConfig) return;
      const optionList = type === "buff" ? buffOptions : conditionOptions;
      openAbsorptionRulePicker({
        item,
        title: type === "buff" ? localize("buffsHeader") : localize("conditionsHeader"),
        subject: `nasOnStruckSave-${outcome}-${type}-${index}`,
        rowId: `onstruck-save-${outcome}-${type}-${index}`,
        optionList,
        selectedIds: type === "buff"
          ? (outcomeConfig.buffUuid ? [outcomeConfig.buffUuid] : [])
          : (outcomeConfig.conditionId ? [outcomeConfig.conditionId] : []),
        onCommit: (selectedIds) => {
          const selected = String(selectedIds?.[0] ?? "");
          if (type === "buff") outcomeConfig.buffUuid = selected;
          else outcomeConfig.conditionId = selected;
          onChange();
          renderOnStruckDamageRuleEditor(section, item, state, onChange, buffOptions, conditionOptions);
        }
      });
    });
  });

  host.querySelectorAll("[data-nas-remove-onstruck-rule]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(control.dataset.nasRemoveOnstruckRule);
      state.damageRules.splice(index, 1);
      if (!state.damageRules.length) state.damageRules.push(newOnStruckDamageRule(state));
      onChange();
      renderOnStruckDamageRuleEditor(section, item, state, onChange, buffOptions, conditionOptions);
    });
  });
}

function mapBuffRowToEffectType(action, context = "onHit") {
  const a = normalizeRowAction(action);
  if (context === "onStruck") {
    if (a === "removeSelf") return "removeBuffTarget";
    if (a === "applyTarget") return "applyBuffAttacker";
    if (a === "removeTarget") return "removeBuffAttacker";
    return "applyBuffTarget";
  }
  if (a === "removeSelf") return "removeBuffAttacker";
  if (a === "applyTarget") return "applyBuffTarget";
  if (a === "removeTarget") return "removeBuffTarget";
  return "applyBuffAttacker";
}

function mapConditionRowToEffectType(action, context = "onHit") {
  const a = normalizeRowAction(action);
  if (context === "onStruck") {
    if (a === "removeSelf") return "removeConditionTarget";
    if (a === "applyTarget") return "applyConditionAttacker";
    if (a === "removeTarget") return "removeConditionAttacker";
    return "applyConditionTarget";
  }
  if (a === "removeSelf") return "removeConditionAttacker";
  if (a === "applyTarget") return "applyConditionTarget";
  if (a === "removeTarget") return "removeConditionTarget";
  return "applyConditionAttacker";
}

function toOnHitPayload(state) {
  const sectionMessage = state?.message !== false;
  if (!state?.enabled) {
    return {
      enabled: false,
      onHitFunction: "none",
      message: sectionMessage,
      effects: [],
      buffRows: [],
      conditionRows: []
    };
  }
  const effects = [];
  if (state.onHitFunction === "lifesteal") {
    const dt = normalizeDamageTypeIds(state.damageTypeIds);
    const temporaryHpDuration = state.lifestealTemporaryHp === true
      ? lifestealTemporaryHpDurationPayload(state.lifestealTemporaryHpDuration)
      : null;
    effects.push({
      type: "healAttacker",
      mode: String(state.mode ?? "percentOfFinalDamage"),
      value: Number(state.value) || 0,
      formula: String(state.formula ?? ""),
      damageTypes: dt,
      damageType: dt[0] ?? "untyped",
      asTemporaryHp: state.lifestealTemporaryHp === true,
      temporaryHpDuration,
      temporaryHpStackingMode: normalizeTemporaryHpStackingMode(state.lifestealTemporaryHpStackingMode),
      temporaryHpCompatibilityMode: normalizeTemporaryHpCompatibilityMode(state.lifestealTemporaryHpCompatibilityMode),
      message: state.message !== false
    });
  }
  if (state.onHitFunction === "grantTemporaryHp") {
    const temporaryHpDuration = lifestealTemporaryHpDurationPayload(state.lifestealTemporaryHpDuration);
    effects.push({
      type: "grantTemporaryHp",
      mode: String(state.mode ?? "formula"),
      value: Number(state.value) || 0,
      formula: String(state.formula ?? ""),
      temporaryHpDuration,
      temporaryHpStackingMode: normalizeTemporaryHpStackingMode(state.lifestealTemporaryHpStackingMode),
      temporaryHpCompatibilityMode: normalizeTemporaryHpCompatibilityMode(state.lifestealTemporaryHpCompatibilityMode),
      temporaryHpCapMode: normalizeTemporaryHpCapMode(state.temporaryHpCapMode),
      message: state.message !== false
    });
  }
  for (const row of state.buffRows ?? []) {
    const effectType = mapBuffRowToEffectType(row?.action);
    for (const buffUuid of row?.selectedIds ?? []) {
      const uuid = String(buffUuid ?? "").trim();
      if (!uuid) continue;
      effects.push({ type: effectType, buffUuid: uuid, message: state.message !== false });
    }
  }
  for (const row of state.conditionRows ?? []) {
    const effectType = mapConditionRowToEffectType(row?.action);
    for (const conditionId of row?.selectedIds ?? []) {
      const id = String(conditionId ?? "").trim();
      if (!id) continue;
      effects.push({ type: effectType, conditionId: id, message: state.message !== false });
    }
  }
  const payload = {
    enabled: true,
    onHitFunction: String(state.onHitFunction ?? "none"),
    message: sectionMessage,
    effects,
    buffRows: persistReactiveRows(state.buffRows),
    conditionRows: persistReactiveRows(state.conditionRows)
  };
  return payload;
}

function toOnStruckPayload(state) {
  const sectionMessage = state?.message !== false;
  if (!state?.enabled) {
    return {
      enabled: false,
      onStruckFunction: "none",
      message: sectionMessage,
      effects: [],
      rules: Array.isArray(state?.damageRules) ? state.damageRules.map((rule) => normalizeOnStruckDamageRule(rule)) : [],
      pool: normalizeOnStruckPool(state?.pool),
      buffRows: [],
      conditionRows: [],
      filters: {
        meleeOnly: state?.meleeOnly !== false,
        excludeReach: state?.excludeReach !== false
      }
    };
  }
  const effects = [];
  if (state.onStruckFunction === "healAttacker") {
    const dt = normalizeDamageTypeIds(state.damageTypeIds);
    effects.push({
      type: String(state.onStruckFunction),
      mode: String(state.mode ?? "formula"),
      value: Number(state.value) || 0,
      formula: String(state.formula ?? ""),
      damageTypes: dt,
      damageType: dt[0] ?? "fire",
      message: state.message !== false
    });
  }
  for (const row of state.buffRows ?? []) {
    const effectType = mapBuffRowToEffectType(row?.action, "onStruck");
    for (const buffUuid of row?.selectedIds ?? []) {
      const uuid = String(buffUuid ?? "").trim();
      if (!uuid) continue;
      effects.push({ type: effectType, buffUuid: uuid, message: state.message !== false });
    }
  }
  for (const row of state.conditionRows ?? []) {
    const effectType = mapConditionRowToEffectType(row?.action, "onStruck");
    for (const conditionId of row?.selectedIds ?? []) {
      const id = String(conditionId ?? "").trim();
      if (!id) continue;
      effects.push({ type: effectType, conditionId: id, message: state.message !== false });
    }
  }
  return {
    enabled: true,
    onStruckFunction: String(state.onStruckFunction ?? "none"),
    message: sectionMessage,
    filters: {
      meleeOnly: state?.meleeOnly !== false,
      excludeReach: state?.excludeReach !== false
    },
    rules: state.onStruckFunction === "damageAttacker"
      ? (Array.isArray(state.damageRules) ? state.damageRules : []).map((rule) => {
        const normalized = normalizeOnStruckDamageRule(rule);
        return {
          id: normalized.id,
          enabled: true,
          mode: normalized.mode,
          value: normalized.value,
          formula: normalized.formula,
          damageTypeIds: normalizeDamageTypeIds(normalized.damageTypeIds),
          damageTypes: normalizeDamageTypeIds(normalized.damageTypeIds),
          damageType: normalizeDamageTypeIds(normalized.damageTypeIds)[0] ?? "fire",
          sourceKind: normalized.sourceKind,
          onlyIfDamaged: normalized.onlyIfDamaged,
          attackerCreatureKind: normalized.attackerCreatureKind,
          save: normalizeOnStruckSave(normalized.save),
          spendPool: normalized.spendPool,
          message: normalized.message
        };
      })
      : [],
    pool: normalizeOnStruckPool(state.pool),
    effects,
    buffRows: persistReactiveRows(state.buffRows),
    conditionRows: persistReactiveRows(state.conditionRows)
  };
}

function toAbsorptionPayload(state) {
  const preset = normalizeAbsorptionPresetId(state?.preset);
  return {
    enabled: state?.enabled === true,
    preset,
    energyType: normalizeAbsorptionPresetEnergyType(preset, state?.energyType),
    totalFormula: String(state?.totalFormula ?? "min(50, 5 * @cl)"),
    perAttackFormula: String(state?.perAttackFormula ?? "5"),
    lethalMode: String(state?.lethalMode ?? "convertToNonlethal"),
    nonlethalMode: String(state?.nonlethalMode ?? "dr"),
    rules: Array.isArray(state?.rules) ? state.rules.map((rule) => {
      const rawAction = String(rule?.action ?? "reduce");
      const action = rawAction === "convertToNonlethal" ? "convertToDamage" : rawAction;
      const normalizedAction = ["", "reduce", "convertToDamage"].includes(action) ? action : "reduce";
      const defenseKind = normalizedAction === "reduce" && String(rule?.defenseKind ?? "") === "er" ? "er" : normalizedAction === "reduce" ? "dr" : "";
      return {
        damageKind: String(rule?.damageKind ?? "any"),
        sourceKind: String(rule?.sourceKind ?? "anyAttack"),
        damageTypeIds: Array.isArray(rule?.damageTypeIds) ? [...rule.damageTypeIds] : [],
        includeUntyped: rule?.includeUntyped === true,
        weaponType: String(rule?.weaponType ?? ""),
        action: normalizedAction,
        convertToDamageType: normalizedAction === "convertToDamage" ? String(rule?.convertToDamageType || "nonlethal") : "",
        amountFormula: normalizeAbsorptionPresetId(state?.preset) === "custom"
          ? String(state?.perAttackFormula ?? "5")
          : String(rule?.amountFormula ?? state?.perAttackFormula ?? "5"),
        defenseKind,
        reductionBypassTypes: normalizedAction === "reduce" && Array.isArray(rule?.reductionBypassTypes) ? [...rule.reductionBypassTypes] : [],
        spendPool: rule?.spendPool === true,
        requiresNoOtherDr: rule?.requiresNoOtherDr === true
      };
    }) : [],
    dischargeAtZero: state?.dischargeAtZero !== false,
    showBadge: absorptionUsesDischargeTotal(state) && state?.showBadge !== false,
    showHpBar: state?.showHpBar === true,
    message: state?.message !== false,
    remaining: Number.isFinite(Number(state?.remaining)) ? Math.max(0, Math.floor(Number(state.remaining))) : null,
    capacity: Number.isFinite(Number(state?.capacity)) ? Math.max(0, Math.floor(Number(state.capacity))) : null
  };
}

function normalizeTemporaryHpConfig(raw = {}, item = null) {
  const max = Number.isFinite(Number(raw?.max ?? raw?.amount ?? raw?.value))
    ? Math.max(0, Math.floor(Number(raw.max ?? raw.amount ?? raw.value)))
    : 0;
  const remaining = Number.isFinite(Number(raw?.remaining))
    ? Math.max(0, Math.floor(Number(raw.remaining)))
    : null;
  const capacity = Number.isFinite(Number(raw?.capacity))
    ? Math.max(0, Math.floor(Number(raw.capacity)))
    : null;
  return {
    enabled: raw?.enabled === true,
    max,
    remaining,
    capacity,
    label: String(raw?.label ?? item?.name ?? ""),
    duration: raw?.duration && typeof raw.duration === "object" ? deepClone(raw.duration) : null,
    sourceItemUuid: String(raw?.sourceItemUuid ?? ""),
    sourceBuffUuid: String(raw?.sourceBuffUuid ?? ""),
    stackingMode: normalizeTemporaryHpStackingMode(raw?.stackingMode),
    compatibilityMode: normalizeTemporaryHpCompatibilityMode(raw?.compatibilityMode),
    createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : null,
    showBadge: raw?.showBadge !== false
  };
}

function toGrantedDefensesPayload(state) {
  const normalized = normalizeGrantedDefenses(state);
  return {
    enabled: normalized.enabled,
    dr: normalized.dr,
    eres: normalized.eres,
    di: normalized.di,
    ci: normalized.ci,
    dv: normalized.dv
  };
}

function toTemporaryHpPayload(state) {
  const normalized = normalizeTemporaryHpConfig(state);
  return {
    enabled: normalized.enabled,
    max: normalized.max,
    remaining: Number.isFinite(Number(normalized.remaining)) ? normalized.remaining : normalized.max,
    capacity: Number.isFinite(Number(normalized.capacity)) ? normalized.capacity : normalized.max,
    label: normalized.label,
    duration: normalized.duration,
    sourceItemUuid: normalized.sourceItemUuid,
    sourceBuffUuid: normalized.sourceBuffUuid,
    stackingMode: normalized.stackingMode,
    compatibilityMode: normalized.compatibilityMode,
    createdAt: Number.isFinite(Number(normalized.createdAt)) ? normalized.createdAt : Date.now(),
    showBadge: normalized.showBadge
  };
}

function scheduleFlagSave(item, key, updater) {
  if (!item) return;
  const timeoutKey = `${item.uuid}:${key}`;
  const old = SAVE_TIMEOUTS.get(timeoutKey);
  if (old) clearTimeout(old);
  const nextTimer = setTimeout(async () => {
    SAVE_TIMEOUTS.delete(timeoutKey);
    const current = getReactiveFlags(item);
    const next = updater(current);
    await item.update({ [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}`]: next }, { render: false });
  }, 300);
  SAVE_TIMEOUTS.set(timeoutKey, nextTimer);
}

function applyOnHitFunctionDefaults(state) {
  if (!state) return;
  state.enabled = true;
  if (state.onHitFunction === "lifesteal") {
    state.mode = "percentOfFinalDamage";
    state.value = 50;
    state.formula = "";
    state.lifestealTemporaryHp = state.lifestealTemporaryHp === true;
    state.temporaryHpCapMode = normalizeTemporaryHpCapMode(state.temporaryHpCapMode);
  } else if (state.onHitFunction === "grantTemporaryHp") {
    state.mode = "formula";
    state.value = 100;
    state.formula = state.formula || "1d6";
    state.lifestealTemporaryHp = true;
    state.temporaryHpCapMode = normalizeTemporaryHpCapMode(state.temporaryHpCapMode);
  } else {
    return;
  }
  state.damageTypeIds = normalizeDamageTypeIds(state.damageTypeIds?.length ? state.damageTypeIds : ["untyped"]);
  state.lifestealTemporaryHpDuration = normalizeLifestealTemporaryHpDuration(state.lifestealTemporaryHpDuration);
  state.lifestealTemporaryHpStackingMode = normalizeTemporaryHpStackingMode(state.lifestealTemporaryHpStackingMode);
  state.lifestealTemporaryHpCompatibilityMode = normalizeTemporaryHpCompatibilityMode(state.lifestealTemporaryHpCompatibilityMode);
  state.message = true;
}

function actionHasSaveControls(action, hostTab) {
  if (action?.hasSave === true) return true;
  const type = String(action?.save?.type ?? action?.saveType ?? "").trim().toLowerCase();
  if (["fort", "ref", "will", "fortitude", "reflex"].includes(type)) return true;
  return Boolean(hostTab?.querySelector?.('select[name*="save"], input[name*="save"], [data-dtype][name*="save"]'));
}

function findActionSaveAnchor(hostTab) {
  const candidates = [...hostTab.querySelectorAll(".form-group")].filter((group) => {
    const text = (group.textContent ?? "").trim().toLowerCase();
    return Boolean(
      group.querySelector('select[name*="save"], input[name*="save"], [data-dtype][name*="save"]')
      || text.includes("saving throw")
      || /\bsave\b/.test(text)
    );
  });
  return candidates.length ? candidates[candidates.length - 1] : null;
}

async function renderBuffSaveGateSection(sheet, root) {
  if (!isItemActionSheetContext(sheet)) return;
  const hostTab = root.querySelector('.tab.action[data-group="primary"]');
  if (!hostTab) return;
  const item = sheet?.item;
  const action = sheet?.action ?? itemActionsArray(item)[0] ?? null;
  if (!item || !action || !actionHasSaveControls(action, hostTab)) {
    hostTab.querySelector(".nas-buff-save-gate")?.remove();
    return;
  }
  if (hostTab.querySelector(".nas-buff-save-gate")) return;

  const flags = getReactiveFlags(item);
  const appKey = `buff-save:${action.id}`;
  const state = normalizeBuffSaveOverrideConfig(
    ReactiveUiState.get(sheet.appId, appKey) ?? flags[BUFF_SAVE_ACTION_SHEET_KEY]?.[action.id]
  );
  ReactiveUiState.set(sheet.appId, appKey, state);
  
  const section = document.createElement("div");
  section.classList.add("nas-buff-save-gate");
  section.innerHTML = `
    <h3 class="form-header">${foundry.utils.escapeHTML(localize("buffSaveGateHeader"))}</h3>
    <div class="form-group">
      <label>${foundry.utils.escapeHTML(localize("buffSaveOverride"))}</label>
      <input type="checkbox" data-nas-key="override" ${state.override ? "checked" : ""}>
    </div>
    <div class="form-group" data-nas-row="mode">
      <label>${foundry.utils.escapeHTML(localize("buffSaveHandling"))}</label>
      <select data-nas-key="mode">${buffSaveHandlingOptionsHtml(state.mode)}</select>
    </div>
    <div class="form-group" data-nas-row="alliesBypass">
      <label>${foundry.utils.escapeHTML(localize("buffSaveAlliesBypass"))}</label>
      <select data-nas-key="alliesBypass">${buffSaveAlliesBypassOptionsHtml(state.alliesBypass)}</select>
    </div>
  `;

  const updateRows = () => {
    for (const row of section.querySelectorAll("[data-nas-row]")) {
      row.style.display = state.override ? "" : "none";
    }
  };
  const persist = () => {
    ReactiveUiState.set(sheet.appId, appKey, state);
        scheduleFlagSave(item, appKey, (flags) => {
      flags[BUFF_SAVE_ACTION_SHEET_KEY] ??= {};
      flags[BUFF_SAVE_ACTION_SHEET_KEY][action.id] = toBuffSaveOverridePayload(state);
            return flags;
    });
  };
  section.addEventListener("change", (event) => {
    excludeNasChangeFromParentForm(event);
    const key = event.target?.dataset?.nasKey;
    if (!key) return;
    if (key === "override") state.override = event.target.checked === true;
    else if (key === "mode") state.mode = normalizeBuffSaveHandlingMode(event.target.value);
    else if (key === "alliesBypass") state.alliesBypass = normalizeBuffSaveAlliesBypassMode(event.target.value);
    updateRows();
    persist();
  });
  updateRows();

  const anchor = findActionSaveAnchor(hostTab);
  if (anchor) {
    hostTab.insertBefore(section, anchor.nextSibling);
  } else {
    const onHit = hostTab.querySelector(".nas-onhit-effects");
    if (onHit) hostTab.insertBefore(section, onHit);
    else hostTab.appendChild(section);
  }
}

async function renderOnHitSection(sheet, root) {
  const useActionSheetOverride = isItemActionSheetContext(sheet);
  const hostTab = useActionSheetOverride
    ? root.querySelector('.tab.action[data-group="primary"]')
    : findDetailsTab(root);
  const item = sheet?.item;
  if (!hostTab) return;
  const action = sheet?.action ?? itemActionsArray(item)[0] ?? null;
  const actionIsHealing = useActionSheetOverride ? isHealingAction(action) : itemHasHealingAction(item);
  const actionHasDamageOrHealing = action?.hasDamage || action?.hasHealing || action?.isHealing;
  const actionTabHasDamageOrHealing = Boolean(hostTab.querySelector(".damage[data-key]") || findActionTabDamageHealingFormHeader(hostTab));
  const itemLevelHasDamageOrHealing = itemHasDamageOrHealing(item);
  const shouldShowOnHit = useActionSheetOverride ? (actionHasDamageOrHealing || actionTabHasDamageOrHealing) : itemLevelHasDamageOrHealing;
  if (!shouldShowOnHit) {
    hostTab.querySelector(".nas-onhit-effects")?.remove();
    return;
  }
  const hadNas = !!hostTab.querySelector(".nas-onhit-effects");
  if (hadNas) return;
  if (!item || (useActionSheetOverride && !action)) return;
  const appKey = useActionSheetOverride ? "onhit-override" : "onhit";
  const fromState = ReactiveUiState.get(sheet.appId, appKey);
  const flags = getReactiveFlags(item);
  const rawOnHit = useActionSheetOverride
    ? flags[ON_HIT_ACTION_SHEET_KEY]?.[action.id]
    : hasPersistedReactiveConfig(flags.onHit)
      ? flags.onHit
      : flags.onHitByAction?.[action?.id];
  const fromFlag = normalizeOnHitConfig(rawOnHit ?? {});
  const state = deepClone(fromState ?? fromFlag);
  state.buffRows = normalizeReactiveRows(state.buffRows);
  state.conditionRows = normalizeReactiveRows(state.conditionRows);
  if (String(state.onHitFunction) === "vampiricTouch") state.onHitFunction = "grantTemporaryHp";
  if (!["none", "lifesteal", "grantTemporaryHp"].includes(String(state.onHitFunction))) {
    state.onHitFunction = fromFlag.onHitFunction;
  }
  state.damageTypeIds = normalizeDamageTypeIds(
    Array.isArray(state.damageTypeIds) ? state.damageTypeIds : fromFlag.damageTypeIds
  );
  state.lifestealTemporaryHpDuration = normalizeLifestealTemporaryHpDuration(state.lifestealTemporaryHpDuration);
  state.lifestealTemporaryHpStackingMode = normalizeTemporaryHpStackingMode(state.lifestealTemporaryHpStackingMode);
  state.lifestealTemporaryHpCompatibilityMode = normalizeTemporaryHpCompatibilityMode(state.lifestealTemporaryHpCompatibilityMode);
  state.temporaryHpCapMode = normalizeTemporaryHpCapMode(state.temporaryHpCapMode);
  state.mode = normalizeOnHitModeForAction(state.mode, { healing: actionIsHealing });
  ReactiveUiState.set(sheet.appId, appKey, state);

  const section = document.createElement("div");
  section.classList.add("nas-onhit-effects");
  const onHitHeaderLabel = localize(useActionSheetOverride ? "onHitHeaderOverride" : "onHitHeader");
  section.innerHTML = `
    <h3 class="form-header nas-reactive-section-header" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
      <span>${onHitHeaderLabel}</span>
      <label class="checkbox" style="margin:0;font-weight:normal;font-size:var(--font-size-14,0.875rem);" title="${localize("enabled")}">
        <input type="checkbox" data-nas-key="enabled" ${state.enabled ? "checked" : ""}>
      </label>
    </h3>
    <div data-nas-reactive-body>
    <div class="form-group nas-rx-function-row">
      <label class="nas-rx-function-label">${game.i18n.localize("NAS.reactive.labels.onHit")}</label>
      <div class="form-fields nas-rx-function-fields">
        <span class="nas-rx-arrow" aria-hidden="true">→</span>
        <select data-nas-key="onHitFunction">
          <option value="none">${game.i18n.localize("NAS.common.labels.none")}</option>
          <option value="lifesteal">${localize("presetLifesteal")}</option>
          <option value="grantTemporaryHp">${localize("presetGrantTemporaryHp")}</option>
        </select>
      </div>
    </div>
    <div class="form-group" data-nas-row="mode">
      <label>${localize("mode")}</label>
      <div class="form-fields">
        <select data-nas-key="mode">
          ${onHitModeOptionsHtml(state.mode, { healing: actionIsHealing })}
        </select>
      </div>
    </div>
    <div class="form-group" data-nas-row="value">
      <label>${localizeSystem("PF1.Value")}</label>
      <div class="form-fields">
        <input type="number" step="1" data-nas-key="value" value="${Number(state.value) || 0}">
      </div>
    </div>
    <div class="form-group" data-nas-row="formula">
      <label>${game.i18n.localize("NAS.common.labels.formula")}</label>
      <div class="form-fields">
        <input class="formula roll" type="text" data-nas-key="formula" value="${state.formula ?? ""}" placeholder="${localize("formulaPlaceholder")}">
      </div>
    </div>
    <div class="form-group" data-nas-row="damageTypes">
      <label>${game.i18n.localize("NAS.common.labels.damageTypes")}</label>
      <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
        <ul class="traits-list tag-list" data-nas-damage-type-tags style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
        <a data-nas-damage-type-edit class="nas-reactive-trait-edit" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
      </div>
    </div>
    <div class="form-group stacked" data-nas-row="lifestealTemporaryHp">
      <label class="checkbox">
        <input type="checkbox" data-nas-key="lifestealTemporaryHp" ${state.lifestealTemporaryHp ? "checked" : ""}>
        ${localize("lifestealTemporaryHp")}
      </label>
    </div>
    <div class="form-group" data-nas-row="lifestealTemporaryHpStacking">
      <label>${localize("temporaryHpStacking")}</label>
      <div class="form-fields">
        <select data-nas-key="lifestealTemporaryHpStackingMode">
          ${temporaryHpStackingOptionsHtml(state.lifestealTemporaryHpStackingMode)}
        </select>
      </div>
    </div>
    <div class="form-group" data-nas-row="lifestealTemporaryHpCompatibility">
      <label>${localize("temporaryHpCompatibility")}</label>
      <div class="form-fields">
        <select data-nas-key="lifestealTemporaryHpCompatibilityMode">
          ${temporaryHpCompatibilityOptionsHtml(state.lifestealTemporaryHpCompatibilityMode)}
        </select>
      </div>
    </div>
    <div class="form-group" data-nas-row="temporaryHpCap">
      <label>${localize("temporaryHpCap")}</label>
      <div class="form-fields">
        <select data-nas-key="temporaryHpCapMode">
          ${temporaryHpCapOptionsHtml(state.temporaryHpCapMode)}
        </select>
      </div>
    </div>
    <div class="form-group stacked" data-nas-row="lifestealTemporaryHpDurationEnabled">
      <label class="checkbox">
        <input type="checkbox" data-nas-key="lifestealTemporaryHpDurationEnabled" ${state.lifestealTemporaryHpDuration?.enabled ? "checked" : ""}>
        ${localize("lifestealTemporaryHpDuration")}
      </label>
    </div>
    <div class="form-group input-select duration" data-nas-row="lifestealTemporaryHpDuration">
      <label>${game.i18n.localize("PF1.Duration")}</label>
      <div class="form-fields">
        <input class="formula roll" type="text" data-nas-key="lifestealTemporaryHpDurationValue" value="${foundry.utils.escapeHTML(state.lifestealTemporaryHpDuration?.value ?? "1")}" placeholder="${game.i18n.localize("PF1.Formula")}">
        <select data-nas-key="lifestealTemporaryHpDurationUnits">
          ${timePeriodOptionsHtml(state.lifestealTemporaryHpDuration?.units ?? "hour")}
        </select>
      </div>
    </div>
    <h4 class="form-header">${localize("additionalEffectsHeader")}</h4>
    <div class="nas-reactive-subheader" style="display:inline-flex;align-items:center;gap:8px;margin:4px 0 2px;flex-wrap:wrap;">
      <span style="font-weight:600;">${localize("buffsHeader")}</span>
      <a data-nas-add="buffRows" title="${localize("addRow")}" style="line-height:1;"><i class="fas fa-plus"></i></a>
    </div>
    <div data-nas-list="buffRows" style="margin:0 0 6px;"></div>
    <div class="nas-reactive-subheader" style="display:inline-flex;align-items:center;gap:8px;margin:2px 0 2px;flex-wrap:wrap;">
      <span style="font-weight:600;">${localize("conditionsHeader")}</span>
      <a data-nas-add="conditionRows" title="${localize("addRow")}" style="line-height:1;"><i class="fas fa-plus"></i></a>
    </div>
    <div data-nas-list="conditionRows" style="margin:0 0 6px;"></div>
    <div class="form-group stacked">
      <label class="checkbox">
        <input type="checkbox" data-nas-key="message" ${state.message ? "checked" : ""}>
        ${localize("postMessage")}
      </label>
    </div>
    </div>
  `;

  if (useActionSheetOverride) {
    insertOnHitInActionTab(hostTab, section);
  } else {
    insertOnHitAtDetailsTabBottom(hostTab, section);
  }

  const buffOptions = await getBuffOptions();
  const conditionOptions = getConditionOptions();
  const onHitFunctionSelect = section.querySelector('select[data-nas-key="onHitFunction"]');
  const modeSelect = section.querySelector('select[data-nas-key="mode"]');

  onHitFunctionSelect.value = String(state.onHitFunction ?? "none");
  modeSelect.value = normalizeOnHitModeForAction(state.mode, { healing: actionIsHealing });

  const updateRows = () => {
    syncReactiveSectionCollapsedChrome(section, state.enabled);

    const mode = state.mode;
    const fn = state.onHitFunction;
    const showPrimary = state.enabled && ["lifesteal", "grantTemporaryHp"].includes(fn);
    const grantsTemporaryHp = fn === "grantTemporaryHp" || (fn === "lifesteal" && state.lifestealTemporaryHp === true);
    const showValue = showPrimary && (mode === "percentOfFinalDamage" || mode === "percentOfExcessHealing");
    const showFormula = showPrimary && mode === "formula";
    const showDamageTypes = false;
    const showTemporaryHpToggle = showPrimary && fn === "lifesteal";
    const showTemporaryHpDuration = showPrimary && grantsTemporaryHp;
    const showTemporaryHpDurationFields = showTemporaryHpDuration && state.lifestealTemporaryHpDuration?.enabled === true;
    section.querySelector('[data-nas-row="value"]').style.display = showValue ? "" : "none";
    section.querySelector('[data-nas-row="formula"]').style.display = showFormula ? "" : "none";
    section.querySelector('[data-nas-row="damageTypes"]').style.display = showDamageTypes ? "" : "none";
    section.querySelector('[data-nas-row="lifestealTemporaryHp"]').style.display = showTemporaryHpToggle ? "" : "none";
    section.querySelector('[data-nas-row="lifestealTemporaryHpStacking"]').style.display = showTemporaryHpDuration ? "" : "none";
    section.querySelector('[data-nas-row="lifestealTemporaryHpCompatibility"]').style.display = showTemporaryHpDuration ? "" : "none";
    section.querySelector('[data-nas-row="temporaryHpCap"]').style.display = showTemporaryHpDuration ? "" : "none";
    section.querySelector('[data-nas-row="lifestealTemporaryHpDurationEnabled"]').style.display = showTemporaryHpDuration ? "" : "none";
    section.querySelector('[data-nas-row="lifestealTemporaryHpDuration"]').style.display = showTemporaryHpDurationFields ? "" : "none";
    section.querySelector('[data-nas-row="mode"]').style.display = showPrimary ? "" : "none";
  };

  const writeState = () => {
    state.enabled = section.querySelector('input[data-nas-key="enabled"]')?.checked === true;
    state.onHitFunction = section.querySelector('select[data-nas-key="onHitFunction"]')?.value ?? "none";
    state.mode = normalizeOnHitModeForAction(
      section.querySelector('select[data-nas-key="mode"]')?.value ?? "formula",
      { healing: actionIsHealing }
    );
    state.value = Number(section.querySelector('input[data-nas-key="value"]')?.value ?? 0) || 0;
    state.formula = String(section.querySelector('input[data-nas-key="formula"]')?.value ?? "");
    state.lifestealTemporaryHp = section.querySelector('input[data-nas-key="lifestealTemporaryHp"]')?.checked === true;
    state.lifestealTemporaryHpStackingMode = normalizeTemporaryHpStackingMode(
      section.querySelector('select[data-nas-key="lifestealTemporaryHpStackingMode"]')?.value
    );
    state.lifestealTemporaryHpCompatibilityMode = normalizeTemporaryHpCompatibilityMode(
      section.querySelector('select[data-nas-key="lifestealTemporaryHpCompatibilityMode"]')?.value
    );
    state.temporaryHpCapMode = normalizeTemporaryHpCapMode(
      section.querySelector('select[data-nas-key="temporaryHpCapMode"]')?.value
    );
    state.lifestealTemporaryHpDuration = normalizeLifestealTemporaryHpDuration({
      enabled: section.querySelector('input[data-nas-key="lifestealTemporaryHpDurationEnabled"]')?.checked === true,
      value: String(section.querySelector('input[data-nas-key="lifestealTemporaryHpDurationValue"]')?.value ?? "1"),
      units: section.querySelector('select[data-nas-key="lifestealTemporaryHpDurationUnits"]')?.value ?? "hour"
    });
    state.message = section.querySelector('input[data-nas-key="message"]')?.checked === true;
    ReactiveUiState.set(sheet.appId, appKey, state);
    updateRows();
    const saveDebounceKey = useActionSheetOverride ? `onhit-ov:${action.id}` : "onhit:item";
    scheduleFlagSave(item, saveDebounceKey, (flags) => {
      if (useActionSheetOverride) {
        flags[ON_HIT_ACTION_SHEET_KEY] ??= {};
        flags[ON_HIT_ACTION_SHEET_KEY][action.id] = toOnHitPayload(state);
      } else {
        flags.onHit = toOnHitPayload(state);
      }
      return flags;
    });
  };

  attachDamageTypeMultiField(section, item, state, writeState);

  for (const control of section.querySelectorAll("input, select")) {
    control.addEventListener("change", (event) => {
      excludeNasChangeFromParentForm(event);
      if (control.dataset.nasKey === "onHitFunction") {
        state.onHitFunction = section.querySelector('select[data-nas-key="onHitFunction"]')?.value ?? "none";
        applyOnHitFunctionDefaults(state);
        state.mode = normalizeOnHitModeForAction(state.mode, { healing: actionIsHealing });
        section.querySelector('input[data-nas-key="enabled"]').checked = state.enabled === true;
        section.querySelector('select[data-nas-key="mode"]').value = state.mode;
        section.querySelector('input[data-nas-key="value"]').value = String(state.value ?? 0);
        section.querySelector('input[data-nas-key="formula"]').value = String(state.formula ?? "");
        section.querySelector('input[data-nas-key="lifestealTemporaryHp"]').checked = state.lifestealTemporaryHp === true;
        section.querySelector('select[data-nas-key="lifestealTemporaryHpStackingMode"]').value = normalizeTemporaryHpStackingMode(state.lifestealTemporaryHpStackingMode);
        section.querySelector('select[data-nas-key="lifestealTemporaryHpCompatibilityMode"]').value = normalizeTemporaryHpCompatibilityMode(state.lifestealTemporaryHpCompatibilityMode);
        section.querySelector('select[data-nas-key="temporaryHpCapMode"]').value = normalizeTemporaryHpCapMode(state.temporaryHpCapMode);
        section.querySelector('input[data-nas-key="lifestealTemporaryHpDurationEnabled"]').checked = state.lifestealTemporaryHpDuration?.enabled === true;
        section.querySelector('input[data-nas-key="lifestealTemporaryHpDurationValue"]').value = String(state.lifestealTemporaryHpDuration?.value ?? "1");
        section.querySelector('select[data-nas-key="lifestealTemporaryHpDurationUnits"]').value = String(state.lifestealTemporaryHpDuration?.units ?? "hour");
        section.querySelector('input[data-nas-key="message"]').checked = state.message === true;
      }
      writeState();
    });
  }

  const persistRows = () => {
    ReactiveUiState.set(sheet.appId, appKey, state);
    const saveDebounceKey = useActionSheetOverride ? `onhit-ov:${action.id}` : "onhit:item";
    scheduleFlagSave(item, saveDebounceKey, (flags) => {
      if (useActionSheetOverride) {
        flags[ON_HIT_ACTION_SHEET_KEY] ??= {};
        flags[ON_HIT_ACTION_SHEET_KEY][action.id] = toOnHitPayload(state);
      } else {
        flags.onHit = toOnHitPayload(state);
      }
      return flags;
    });
  };
  attachReactiveRowEditor(section, item, state, "buffRows", buffOptions, localize("buffsHeader"), persistRows);
  attachReactiveRowEditor(section, item, state, "conditionRows", conditionOptions, localize("conditionsHeader"), persistRows);

  updateRows();
}

async function renderOnStruckSection(sheet, root) {
  const detailsTab = findDetailsTab(root);
  if (!detailsTab) return;
  const hadOnStruckNas = !!detailsTab.querySelector(".nas-onstruck-effects");
  const item = sheet?.item;
  if (!item || !["buff", "equipment"].includes(item.type)) return;
  if (hadOnStruckNas) return;

  const appKey = "onstruck";
  const fromState = ReactiveUiState.get(sheet.appId, appKey);
  const flags = getReactiveFlags(item);
  const rawOnStruck = flags.onStruck;
  const fromFlag = normalizeOnStruckConfig(rawOnStruck);
  const fromAbsorptionFlag = normalizeAbsorptionConfig(flags.absorption);
  const state = deepClone(fromState ?? fromFlag);
  state.absorption = normalizeAbsorptionConfig(state.absorption ?? fromAbsorptionFlag);
  state.buffRows = normalizeReactiveRows(state.buffRows);
  state.conditionRows = normalizeReactiveRows(state.conditionRows);
  state.damageRules = (Array.isArray(state.damageRules) && state.damageRules.length ? state.damageRules : fromFlag.damageRules)
    .map((rule) => normalizeOnStruckDamageRule(rule));
  if (!state.damageRules.length) state.damageRules = [newOnStruckDamageRule(fromFlag)];
  state.pool = normalizeOnStruckPool(state.pool ?? fromFlag.pool);
  if (fromAbsorptionFlag.enabled && String(state.onStruckFunction ?? "none") === "none" && item.type === "buff") {
    state.enabled = true;
    state.onStruckFunction = "damageAbsorption";
  }
  if (!["none", "damageAttacker", "healAttacker", "damageAbsorption"].includes(String(state.onStruckFunction))) {
    state.onStruckFunction = fromFlag.onStruckFunction;
  }
  state.damageTypeIds = normalizeDamageTypeIds(
    Array.isArray(state.damageTypeIds) ? state.damageTypeIds : fromFlag.damageTypeIds
  );
  ReactiveUiState.set(sheet.appId, appKey, state);

  const section = document.createElement("div");
  section.classList.add("nas-onstruck-effects");
  section.innerHTML = `
    <h3 class="form-header nas-reactive-section-header" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
      <span>${localize("onStruckHeader")}</span>
      <label class="checkbox" style="margin:0;font-weight:normal;font-size:var(--font-size-14,0.875rem);" title="${localize("enabled")}">
        <input type="checkbox" data-nas-key="enabled" ${state.enabled ? "checked" : ""}>
      </label>
    </h3>
    <div data-nas-reactive-body>
    <div class="form-group nas-rx-function-row">
      <label class="nas-rx-function-label">${game.i18n.localize("NAS.reactive.labels.onStruck")}</label>
      <div class="form-fields nas-rx-function-fields">
        <span class="nas-rx-arrow" aria-hidden="true">→</span>
        <select data-nas-key="onStruckFunction">
          <option value="none">${game.i18n.localize("NAS.common.labels.none")}</option>
          <option value="damageAttacker">${localize("effectDamageAttacker")}</option>
          <option value="healAttacker">${localize("effectHealAttacker")}</option>
          ${item.type === "buff" ? `<option value="damageAbsorption">${localize("effectDamageAbsorption")}</option>` : ""}
        </select>
      </div>
    </div>
    <div class="form-group" data-nas-row="mode">
      <label>${localize("mode")}</label>
      <div class="form-fields">
        <select data-nas-key="mode">
          <option value="percentOfFinalDamage">${localize("modePercentFinal")}</option>
          <option value="formula">${game.i18n.localize("NAS.common.labels.formula")}</option>
        </select>
      </div>
    </div>
    <div class="form-group" data-nas-row="value">
      <label>${localizeSystem("PF1.Value")}</label>
      <div class="form-fields">
        <input type="number" step="1" data-nas-key="value" value="${Number(state.value) || 0}">
      </div>
    </div>
    <div class="form-group" data-nas-row="formula">
      <label>${game.i18n.localize("NAS.common.labels.formula")}</label>
      <div class="form-fields">
        <input class="formula roll" type="text" data-nas-key="formula" value="${state.formula ?? ""}" placeholder="${localize("formulaPlaceholder")}">
      </div>
    </div>
    <div class="form-group" data-nas-row="damageTypes">
      <label>${game.i18n.localize("NAS.common.labels.damageTypes")}</label>
      <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
        <ul class="traits-list tag-list" data-nas-damage-type-tags style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
        <a data-nas-damage-type-edit class="nas-reactive-trait-edit" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
      </div>
    </div>
    <div data-nas-row="onStruckDamageRules" style="margin:0;">
      <div data-nas-onstruck-rules></div>
      <a data-nas-add-onstruck-rule><i class="fas fa-plus"></i> ${localize("addRow")}</a>
    </div>
    <div class="form-group" data-nas-row="absorptionPreset">
        <label>${localize("absorptionPreset")}</label>
        <div class="form-fields">
          <select data-nas-key="absorptionPreset">
            <option value="ablativeBarrier">${localize("absorptionPresetAblativeBarrier")}</option>
            <option value="protectionFromArrows">${localize("absorptionPresetProtectionFromArrows")}</option>
            <option value="protectionFromEnergy">${localize("absorptionPresetProtectionFromEnergy")}</option>
            <option value="draconicReservoir">${localize("absorptionPresetDraconicReservoir")}</option>
            <option value="stoneskin">${localize("absorptionPresetStoneskin")}</option>
            <option value="defendingBone">${localize("absorptionPresetDefendingBone")}</option>
            <option value="firewalkersMeditation">${localize("absorptionPresetFirewalkersMeditation")}</option>
            <option value="custom">${localizeSystem("PF1.Custom")}</option>
          </select>
        </div>
      </div>
    <div class="form-group" data-nas-row="absorptionEnergyType">
      <label>${localize("absorptionEnergyType")}</label>
      <div class="form-fields">
        <select data-nas-key="absorptionEnergyType"></select>
      </div>
    </div>
    <div class="form-group" data-nas-row="absorptionTotalFormula">
      <label title="${localize("absorptionTotalFormulaHint")}">${localize("absorptionTotalFormula")}</label>
      <div class="form-fields">
        <input class="formula roll" type="text" data-nas-key="absorptionTotalFormula" value="${foundry.utils.escapeHTML(state.absorption.totalFormula ?? "")}" placeholder="min(50, 5 * @cl)" title="${localize("absorptionTotalFormulaHint")}">
      </div>
    </div>
    <div class="form-group" data-nas-row="absorptionPerAttackFormula">
      <label title="${localize("absorptionPerAttackFormulaHint")}">${localize("absorptionPerAttackFormula")}</label>
      <div class="form-fields">
        <input class="formula roll" type="text" data-nas-key="absorptionPerAttackFormula" value="${foundry.utils.escapeHTML(state.absorption.perAttackFormula ?? "")}" placeholder="5" title="${localize("absorptionPerAttackFormulaHint")}">
      </div>
    </div>
    <div data-nas-row="absorptionCustomRules" style="margin:0;">
      <div data-nas-absorption-rules></div>
      <a data-nas-add-absorption-rule><i class="fas fa-plus"></i> ${localize("addRow")}</a>
    </div>
    <div class="form-group stacked" data-nas-row="absorptionOptions">
      <label class="checkbox" data-nas-option="absorptionDischargeAtZero">
        <input type="checkbox" data-nas-key="absorptionDischargeAtZero" ${state.absorption.dischargeAtZero !== false ? "checked" : ""}>
        ${localize("absorptionDischargeAtZero")}
      </label>
      <label class="checkbox" data-nas-option="absorptionShowBadge">
        <input type="checkbox" data-nas-key="absorptionShowBadge" ${state.absorption.showBadge !== false ? "checked" : ""}>
        ${localize("absorptionShowBadge")}
      </label>
      <label class="checkbox" data-nas-option="absorptionShowHpBar">
        <input type="checkbox" data-nas-key="absorptionShowHpBar" ${state.absorption.showHpBar === true ? "checked" : ""}>
        ${localize("absorptionShowHpBar")}
      </label>
    </div>
    <h4 class="form-header">${localize("additionalEffectsHeader")}</h4>
    <div class="nas-reactive-subheader" style="display:inline-flex;align-items:center;gap:8px;margin:4px 0 2px;flex-wrap:wrap;">
      <span style="font-weight:600;">${localize("buffsHeader")}</span>
      <a data-nas-add="buffRows" title="${localize("addRow")}" style="line-height:1;"><i class="fas fa-plus"></i></a>
    </div>
    <div data-nas-list="buffRows" style="margin:0 0 6px;"></div>
    <div class="nas-reactive-subheader" style="display:inline-flex;align-items:center;gap:8px;margin:2px 0 2px;flex-wrap:wrap;">
      <span style="font-weight:600;">${localize("conditionsHeader")}</span>
      <a data-nas-add="conditionRows" title="${localize("addRow")}" style="line-height:1;"><i class="fas fa-plus"></i></a>
    </div>
    <div data-nas-list="conditionRows" style="margin:0 0 6px;"></div>
    <div class="form-group stacked">
      <label class="checkbox">
        <input type="checkbox" data-nas-key="message" ${state.message ? "checked" : ""}>
        ${localize("postMessage")}
      </label>
    </div>
    </div>
  `;
  const advancedHeader = findAdvancedHeaderInTab(detailsTab);
  if (advancedHeader) {
    detailsTab.insertBefore(section, advancedHeader);
  } else {
    const firstAnchor = detailsTab.querySelector("h3.form-header, .form-group, hr");
    if (firstAnchor) detailsTab.insertBefore(section, firstAnchor);
    else detailsTab.appendChild(section);
  }

  const buffOptions = await getBuffOptions();
  const conditionOptions = getConditionOptions();
  const onStruckFunctionSelect = section.querySelector('select[data-nas-key="onStruckFunction"]');
  const modeSelect = section.querySelector('select[data-nas-key="mode"]');
  onStruckFunctionSelect.value = String(state.onStruckFunction ?? "none");
  modeSelect.value = String(state.mode ?? "formula");
  section.querySelector('select[data-nas-key="absorptionPreset"]').value = String(state.absorption.preset ?? "ablativeBarrier");

  const syncEnergyTypeSelect = () => {
    const select = section.querySelector('select[data-nas-key="absorptionEnergyType"]');
    if (!select) return;
    const allowed = getAbsorptionPresetEnergyOptions(state.absorption.preset);
    const labels = getDamageTypeOptions();
    select.innerHTML = allowed
      .map((id) => `<option value="${foundry.utils.escapeHTML(id)}">${foundry.utils.escapeHTML(titleCaseOptionLabel(id, labels.find((option) => option.id === id)?.label ?? id))}</option>`)
      .join("");
    state.absorption.energyType = normalizeAbsorptionPresetEnergyType(state.absorption.preset, state.absorption.energyType);
    select.value = state.absorption.energyType;
  };

  const updateRows = () => {
    syncReactiveSectionCollapsedChrome(section, state.enabled);

    const fn = state.onStruckFunction;
    const damageLike = fn === "healAttacker";
    const onStruckDamageLike = fn === "damageAttacker";
    const absorptionLike = fn === "damageAbsorption";
    const showValue = state.enabled && damageLike && state.mode === "percentOfFinalDamage";
    const showFormula = state.enabled && damageLike && state.mode === "formula";
    const showMode = state.enabled && damageLike;
    const showDamageTypes = false;
    section.querySelector('[data-nas-row="mode"]').style.display = showMode ? "" : "none";
    section.querySelector('[data-nas-row="value"]').style.display = showValue ? "" : "none";
    section.querySelector('[data-nas-row="formula"]').style.display = showFormula ? "" : "none";
    section.querySelector('[data-nas-row="damageTypes"]').style.display = showDamageTypes ? "" : "none";
    const onStruckRules = section.querySelector('[data-nas-row="onStruckDamageRules"]');
    if (onStruckRules) onStruckRules.style.display = state.enabled && onStruckDamageLike ? "" : "none";
    for (const row of section.querySelectorAll('[data-nas-row^="absorption"]')) {
      row.style.display = state.enabled && absorptionLike ? "" : "none";
    }
    const customRules = section.querySelector('[data-nas-row="absorptionCustomRules"]');
    if (customRules) customRules.style.display = state.enabled && absorptionLike && state.absorption.preset === "custom" ? "" : "none";
    const energyTypeRow = section.querySelector('[data-nas-row="absorptionEnergyType"]');
    if (energyTypeRow) energyTypeRow.style.display = state.enabled && absorptionLike && absorptionPresetUsesEnergyType(state.absorption.preset) ? "" : "none";
    const usesDischargeTotal = absorptionUsesDischargeTotal(state.absorption);
    const totalFormulaRow = section.querySelector('[data-nas-row="absorptionTotalFormula"]');
    if (totalFormulaRow) totalFormulaRow.style.display = state.enabled && absorptionLike && usesDischargeTotal ? "" : "none";
    const dischargeOption = section.querySelector('[data-nas-option="absorptionDischargeAtZero"]');
    if (dischargeOption) dischargeOption.style.display = state.enabled && absorptionLike && usesDischargeTotal ? "" : "none";
    const badgeOption = section.querySelector('[data-nas-option="absorptionShowBadge"]');
    if (badgeOption) badgeOption.style.display = state.enabled && absorptionLike && usesDischargeTotal ? "" : "none";
    const hpBarOption = section.querySelector('[data-nas-option="absorptionShowHpBar"]');
    if (hpBarOption) hpBarOption.style.display = state.enabled && absorptionLike && usesDischargeTotal ? "" : "none";
  };

  const saveOnStruckAndAbsorption = () => {
    scheduleFlagSave(item, "onstruck", (flags) => {
      const previousOnStruck = flags.onStruck ?? {};
      const previousPool = normalizeOnStruckPool(previousOnStruck.pool ?? previousOnStruck.onStruckPool);
      const nextOnStruck = toOnStruckPayload(state);
      const nextPool = normalizeOnStruckPool(nextOnStruck.pool);
      const resetOnStruckPool = nextPool.enabled && (
        previousOnStruck.enabled !== true
        || previousPool.enabled !== true
        || !Number.isFinite(Number(previousPool.remaining))
        || !Number.isFinite(Number(previousPool.capacity))
        || Number(previousPool.remaining) <= 0
        || previousPool.totalFormula !== nextPool.totalFormula
      );
      flags.onStruck = {
        ...nextOnStruck,
        pool: {
          ...nextPool,
          remaining: resetOnStruckPool ? null : previousPool.remaining,
          capacity: resetOnStruckPool ? null : previousPool.capacity
        }
      };
      const previous = normalizeAbsorptionConfig(flags.absorption);
      const nextAbsorption = toAbsorptionPayload({
        ...state.absorption,
        enabled: state.enabled === true && state.onStruckFunction === "damageAbsorption",
        message: state.message !== false
      });
      const resetRemaining = nextAbsorption.enabled && (
        previous.enabled !== true
        || !Number.isFinite(Number(previous.remaining))
        || !Number.isFinite(Number(previous.capacity))
        || Number(previous.remaining) <= 0
        || previous.preset !== nextAbsorption.preset
        || previous.energyType !== nextAbsorption.energyType
        || previous.totalFormula !== nextAbsorption.totalFormula
        || previous.perAttackFormula !== nextAbsorption.perAttackFormula
      );
      flags.absorption = {
        ...nextAbsorption,
        remaining: resetRemaining ? null : previous.remaining,
        capacity: resetRemaining ? null : previous.capacity
      };
      return flags;
    });
  };

  const writeState = () => {
    state.enabled = section.querySelector('input[data-nas-key="enabled"]')?.checked === true;
    state.onStruckFunction = section.querySelector('select[data-nas-key="onStruckFunction"]')?.value ?? "none";
    state.mode = section.querySelector('select[data-nas-key="mode"]')?.value ?? "formula";
    state.value = Number(section.querySelector('input[data-nas-key="value"]')?.value ?? 0) || 0;
    state.formula = String(section.querySelector('input[data-nas-key="formula"]')?.value ?? "");
    state.message = section.querySelector('input[data-nas-key="message"]')?.checked === true;
    state.pool = normalizeOnStruckPool({
      ...state.pool,
      enabled: (state.damageRules ?? []).some((rule) => rule?.spendPool === true),
      totalFormula: String(state.pool?.totalFormula ?? ""),
      dischargeAtZero: state.pool?.dischargeAtZero === true,
      showBadge: state.pool?.showBadge === true
    });
    if (state.pool.enabled && !state.pool.totalFormula.trim()) state.pool.totalFormula = "min(50, 5 * @cl)";
    state.absorption.preset = section.querySelector('select[data-nas-key="absorptionPreset"]')?.value ?? "ablativeBarrier";
    state.absorption.energyType = section.querySelector('select[data-nas-key="absorptionEnergyType"]')?.value ?? state.absorption.energyType ?? "fire";
    state.absorption.totalFormula = String(section.querySelector('input[data-nas-key="absorptionTotalFormula"]')?.value ?? "");
    state.absorption.perAttackFormula = String(section.querySelector('input[data-nas-key="absorptionPerAttackFormula"]')?.value ?? "");
    syncAbsorptionRulesFromFields(state.absorption);
    state.absorption.dischargeAtZero = section.querySelector('input[data-nas-key="absorptionDischargeAtZero"]')?.checked === true;
    state.absorption.showBadge = section.querySelector('input[data-nas-key="absorptionShowBadge"]')?.checked === true;
    state.absorption.showHpBar = section.querySelector('input[data-nas-key="absorptionShowHpBar"]')?.checked === true;
    state.absorption.message = state.message !== false;
    ReactiveUiState.set(sheet.appId, appKey, state);
    updateRows();
    saveOnStruckAndAbsorption();
  };

  attachDamageTypeMultiField(section, item, state, writeState);

  for (const control of section.querySelectorAll("input, select")) {
    control.addEventListener("change", (event) => {
      excludeNasChangeFromParentForm(event);
      if (control.dataset.nasKey === "onStruckFunction") {
        state.onStruckFunction = section.querySelector('select[data-nas-key="onStruckFunction"]')?.value ?? "none";
        section.querySelector('input[data-nas-key="enabled"]').checked = state.enabled === true;
        section.querySelector('select[data-nas-key="mode"]').value = state.mode;
        section.querySelector('input[data-nas-key="value"]').value = String(state.value ?? 0);
        section.querySelector('input[data-nas-key="formula"]').value = String(state.formula ?? "");
        section.querySelector('input[data-nas-key="message"]').checked = state.message === true;
        section.querySelector('input[data-nas-key="absorptionTotalFormula"]').value = String(state.absorption.totalFormula ?? "");
        section.querySelector('input[data-nas-key="absorptionPerAttackFormula"]').value = String(state.absorption.perAttackFormula ?? "");
        section.querySelector('select[data-nas-key="absorptionPreset"]').value = String(state.absorption.preset ?? "ablativeBarrier");
        syncEnergyTypeSelect();
        section.querySelector('input[data-nas-key="absorptionDischargeAtZero"]').checked = state.absorption.dischargeAtZero !== false;
        section.querySelector('input[data-nas-key="absorptionShowBadge"]').checked = state.absorption.showBadge !== false;
        section.querySelector('input[data-nas-key="absorptionShowHpBar"]').checked = state.absorption.showHpBar === true;
      } else if (control.dataset.nasKey === "absorptionPreset") {
        applyAbsorptionPresetDefaults(state.absorption, control.value);
        syncEnergyTypeSelect();
        section.querySelector('input[data-nas-key="absorptionTotalFormula"]').value = String(state.absorption.totalFormula ?? "");
        section.querySelector('input[data-nas-key="absorptionPerAttackFormula"]').value = String(state.absorption.perAttackFormula ?? "");
        renderAbsorptionRuleEditor(section, item, state, writeState);
      } else if (control.dataset.nasKey === "absorptionEnergyType") {
        state.absorption.energyType = normalizeAbsorptionPresetEnergyType(state.absorption.preset, control.value);
        syncAbsorptionRulesFromFields(state.absorption);
        renderAbsorptionRuleEditor(section, item, state, writeState);
      }
      writeState();
    });
  }

  const persistRows = () => {
    ReactiveUiState.set(sheet.appId, appKey, state);
    saveOnStruckAndAbsorption();
  };
  attachReactiveRowEditor(section, item, state, "buffRows", buffOptions, localize("buffsHeader"), persistRows, "onStruck");
  attachReactiveRowEditor(section, item, state, "conditionRows", conditionOptions, localize("conditionsHeader"), persistRows, "onStruck");
  section.querySelector("[data-nas-add-onstruck-rule]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.damageRules.push(newOnStruckDamageRule(state));
    writeState();
    renderOnStruckDamageRuleEditor(section, item, state, writeState, buffOptions, conditionOptions);
  });
  section.querySelector("[data-nas-add-absorption-rule]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.absorption.preset = "custom";
    section.querySelector('select[data-nas-key="absorptionPreset"]').value = "custom";
    state.absorption.rules.push(newCustomAbsorptionRule());
    writeState();
    renderAbsorptionRuleEditor(section, item, state, writeState);
  });

  renderOnStruckDamageRuleEditor(section, item, state, writeState, buffOptions, conditionOptions);
  renderAbsorptionRuleEditor(section, item, state, writeState);
  syncEnergyTypeSelect();
  updateRows();
}

async function renderAbsorptionSection(sheet, root) {
  const detailsTab = findDetailsTab(root);
  if (!detailsTab) return;
  const hadAbsorption = !!detailsTab.querySelector(".nas-absorption-effects");
  const item = sheet?.item;
  if (!item || item.type !== "buff") return;
  if (hadAbsorption) return;

  const appKey = "absorption";
  const fromState = ReactiveUiState.get(sheet.appId, appKey);
  const fromFlag = normalizeAbsorptionConfig(getReactiveFlags(item).absorption);
  const state = deepClone(fromState ?? fromFlag);
  ReactiveUiState.set(sheet.appId, appKey, state);

  const section = document.createElement("div");
  section.classList.add("nas-absorption-effects");
  section.innerHTML = `
    <h3 class="form-header nas-reactive-section-header" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
      <span>${localize("absorptionHeader")}</span>
      <label class="checkbox" style="margin:0;font-weight:normal;font-size:var(--font-size-14,0.875rem);" title="${localize("enabled")}">
        <input type="checkbox" data-nas-key="enabled" ${state.enabled ? "checked" : ""}>
      </label>
    </h3>
    <div data-nas-reactive-body>
      <div class="form-group">
        <label title="${localize("absorptionTotalFormulaHint")}">${localize("absorptionTotalFormula")}</label>
        <div class="form-fields">
          <input class="formula roll" type="text" data-nas-key="totalFormula" value="${foundry.utils.escapeHTML(state.totalFormula ?? "")}" placeholder="min(50, 5 * @cl)" title="${localize("absorptionTotalFormulaHint")}">
        </div>
      </div>
      <div class="form-group">
        <label title="${localize("absorptionPerAttackFormulaHint")}">${localize("absorptionPerAttackFormula")}</label>
        <div class="form-fields">
          <input class="formula roll" type="text" data-nas-key="perAttackFormula" value="${foundry.utils.escapeHTML(state.perAttackFormula ?? "")}" placeholder="5" title="${localize("absorptionPerAttackFormulaHint")}">
        </div>
      </div>
      <div class="form-group">
        <label>${localize("absorptionLethalMode")}</label>
        <div class="form-fields">
          <select data-nas-key="lethalMode">
            <option value="convertToNonlethal">${localize("absorptionLethalConvert")}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${localize("absorptionNonlethalMode")}</label>
        <div class="form-fields">
          <select data-nas-key="nonlethalMode">
            <option value="dr">${localize("absorptionNonlethalDr")}</option>
          </select>
        </div>
      </div>
      <div class="form-group stacked">
        <label class="checkbox">
          <input type="checkbox" data-nas-key="dischargeAtZero" ${state.dischargeAtZero !== false ? "checked" : ""}>
          ${localize("absorptionDischargeAtZero")}
        </label>
        <label class="checkbox">
          <input type="checkbox" data-nas-key="showBadge" ${state.showBadge !== false ? "checked" : ""}>
          ${localize("absorptionShowBadge")}
        </label>
        <label class="checkbox">
          <input type="checkbox" data-nas-key="showHpBar" ${state.showHpBar === true ? "checked" : ""}>
          ${localize("absorptionShowHpBar")}
        </label>
      </div>
    </div>
  `;

  const advancedHeader = findAdvancedHeaderInTab(detailsTab);
  if (advancedHeader) {
    detailsTab.insertBefore(section, advancedHeader);
  } else {
    detailsTab.appendChild(section);
  }

  section.querySelector('select[data-nas-key="lethalMode"]').value = String(state.lethalMode ?? "convertToNonlethal");
  section.querySelector('select[data-nas-key="nonlethalMode"]').value = String(state.nonlethalMode ?? "dr");

  const updateRows = () => {
    syncReactiveSectionCollapsedChrome(section, state.enabled);
  };

  const writeState = () => {
    state.enabled = section.querySelector('input[data-nas-key="enabled"]')?.checked === true;
    state.totalFormula = String(section.querySelector('input[data-nas-key="totalFormula"]')?.value ?? "");
    state.perAttackFormula = String(section.querySelector('input[data-nas-key="perAttackFormula"]')?.value ?? "");
    state.lethalMode = section.querySelector('select[data-nas-key="lethalMode"]')?.value ?? "convertToNonlethal";
    state.nonlethalMode = section.querySelector('select[data-nas-key="nonlethalMode"]')?.value ?? "dr";
    syncAbsorptionRulesFromFields(state);
    state.dischargeAtZero = section.querySelector('input[data-nas-key="dischargeAtZero"]')?.checked === true;
    state.showBadge = section.querySelector('input[data-nas-key="showBadge"]')?.checked === true;
    state.showHpBar = section.querySelector('input[data-nas-key="showHpBar"]')?.checked === true;
    ReactiveUiState.set(sheet.appId, appKey, state);
    updateRows();
    scheduleFlagSave(item, "absorption", (flags) => {
      const previous = normalizeAbsorptionConfig(flags.absorption);
      flags.absorption = {
        ...toAbsorptionPayload(state),
        remaining: previous.remaining,
        capacity: previous.capacity
      };
      return flags;
    });
  };

  for (const control of section.querySelectorAll("input, select")) {
    control.addEventListener("change", (event) => {
      excludeNasChangeFromParentForm(event);
      writeState();
    });
  }

  updateRows();
}

function attachGrantedDefenseMultiField(section, item, state, key, onChange) {
  const tags = section.querySelector(`[data-nas-defense-tags="${key}"]`);
  const editBtn = section.querySelector(`[data-nas-defense-edit="${key}"]`);
  if (!tags || !editBtn) return;

  state[key] = Array.isArray(state[key]) ? state[key] : [];
  const renderTags = () => {
    const options = getGrantedDefenseOptions(key);
    const labels = state[key]
      .map((id) => options.find((option) => option.id === id)?.label ?? id)
      .sort((a, b) => a.localeCompare(b));
    tags.innerHTML = labels.length
      ? labels.map((label) => `<li class="tag">${foundry.utils.escapeHTML(label)}</li>`).join("")
      : `<li class="tag placeholder" inert>${game.i18n.localize("NAS.common.placeholders.noneSelected")}</li>`;
  };

  const openPicker = () => {
    if (!pf1?.applications?.ActorTraitSelector) {
      ui.notifications?.warn?.("PF1 trait selector is not available.");
      return;
    }
    const { choices, indexToId } = buildReactiveOptionChoices(getGrantedDefenseOptions(key));
    new ReactiveOptionSelector({
      document: item,
      title: localize(`grantedDefense${key.toUpperCase()}`),
      subject: `nasGrantedDefense-${key}`,
      rowId: `grantedDefense-${key}`,
      choices,
      indexToId,
      initialSelectedIds: [...state[key]],
      hasCustom: false,
      onCommit: (selectedIds) => {
        state[key] = selectedIds;
        renderTags();
        onChange();
      }
    }).render(true);
  };

  editBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPicker();
  });
  renderTags();
}

function resistanceSummaryLabels(key, resistance) {
  const options = getGrantedDefenseOptions(key);
  const out = [];
  for (const entry of resistance?.value ?? []) {
    const types = Array.isArray(entry?.types) && entry.types.length
      ? entry.types.map((id) => options.find((option) => option.id === id)?.label ?? id).join(entry.operator === false ? " and " : " or ")
      : "-";
    out.push(`${Number(entry?.amount) || 0}/${types}`);
  }
  const custom = String(resistance?.custom ?? "").trim();
  if (custom) out.push(custom);
  return out;
}

function resistanceEntrySummaryLabel(key, entry) {
  return resistanceSummaryLabels(key, { value: [entry], custom: "" })[0] ?? "";
}

function getResistanceSelectorOptions(key, attribute) {
  const dr = key === "dr";
  return {
    name: attribute,
    title: dr ? localizeSystem("PF1.DamRed") : localize("grantedDefenseER"),
    fields: [
      "PF1.Application.DamageResistanceSelector.DamageAmount",
      dr ? "PF1.Application.DamageResistanceSelector.Bypassed" : "PF1.Application.DamageResistanceSelector.Resisted",
      "PF1.Application.DamageResistanceSelector.CombinationType",
      dr ? "PF1.Application.DamageResistanceSelector.Bypassed" : "PF1.Application.DamageResistanceSelector.Resisted"
    ].map((label) => game.i18n.localize(label)).join(";"),
    dtypes: "Number;String;Boolean;String",
    width: dr ? 575 : 450,
    isDR: dr,
    options: dr ? "dr" : "eres"
  };
}

function getOpenResistanceSelectorApp(item, attribute) {
  return Object.values(item?.apps ?? {}).find(
    (app) => app?.constructor?.name === "DamageResistanceSelector" && app?.options?.name === attribute
  );
}

function attachResistanceSelectorCloseHandler(app, item, state, key, attribute, renderTags, onChange) {
  if (!app || app._nasGrantedDefenseCloseHook) return;
  app._nasGrantedDefenseCloseHook = true;
  if (typeof app._getUpdateData === "function") {
    const originalGetUpdateData = app._getUpdateData.bind(app);
    app._getUpdateData = (...args) => {
      const updateData = originalGetUpdateData(...args);
      app._nasGrantedDefenseLastValue = {
        value: updateData?.[`${attribute}.value`] ?? state[key]?.value ?? [],
        custom: updateData?.[`${attribute}.custom`] ?? state[key]?.custom ?? ""
      };
      return updateData;
    };
  }
  const originalClose = app.close.bind(app);
  app.close = async (...args) => {
    const result = await originalClose(...args);
    const next = normalizeGrantedDefenses({ [key]: app._nasGrantedDefenseLastValue ?? getReactiveFlags(item).grantedDefenses?.[key] });
    state[key] = next[key];
    renderTags();
    onChange({ preserveResistanceState: true });
    return result;
  };
}

function attachGrantedDefenseResistanceField(section, item, state, key, onChange) {
  const tags = section.querySelector(`[data-nas-defense-tags="${key}"]`);
  const editBtn = section.querySelector(`[data-nas-defense-edit="${key}"]`);
  if (!tags || !editBtn) return;

  state[key] = normalizeGrantedDefenses({ [key]: state[key] })[key];

  const renderTags = () => {
    const entries = Array.isArray(state[key]?.value) ? state[key].value : [];
    const custom = String(state[key]?.custom ?? "").trim();
    tags.innerHTML = "";
    if (!entries.length && !custom) {
      tags.innerHTML = `<li class="tag placeholder" inert>${game.i18n.localize("NAS.common.placeholders.noneSelected")}</li>`;
      return;
    }
    for (const [index, entry] of entries.entries()) {
      const li = document.createElement("li");
      li.classList.add("tag");
      li.style.cssText = "display:inline-flex;align-items:center;gap:3px;";
      const entryLabel = resistanceEntrySummaryLabel(key, entry);
      li.innerHTML = `
        <span>${foundry.utils.escapeHTML(entryLabel)}</span>
        <input type="checkbox" data-nas-defense-stack-index="${index}" ${entry.stackable === true ? "checked" : ""}
          title="${localize("grantedDefenseStackable")}" aria-label="${foundry.utils.escapeHTML(`${entryLabel}: ${localize("grantedDefenseStackable")}`)}"
          style="width:12px !important;height:12px;margin:0;flex:0 0 12px;">
      `;
      tags.appendChild(li);
      li.querySelector("input")?.addEventListener("change", (event) => {
        excludeNasChangeFromParentForm(event);
        state[key].value[index].stackable = event.currentTarget.checked === true;
        onChange();
      });
    }
    if (custom) {
      const li = document.createElement("li");
      li.classList.add("tag");
      li.textContent = custom;
      tags.appendChild(li);
    }
  };

  const openPicker = async () => {
    const Selector = pf1?.applications?.DamageResistanceSelector;
    const bridge = item?.actor?.sheet?._onResistanceSelector;
    const attribute = `flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.grantedDefenses.${key}`;
    const resistance = normalizeGrantedDefenses({ [key]: foundry.utils.getProperty(item, attribute) ?? state[key] })[key];
    if (!Array.isArray(resistance?.value)) {
      resistance.value = [];
    }
    await item.update({ [attribute]: resistance }, { render: false });
    state[key] = resistance;

    const options = getResistanceSelectorOptions(key, attribute);
    if (!Selector) {
      if (typeof bridge === "function") {
        bridge.call(
          { actor: item },
          {
            preventDefault() {},
            currentTarget: {
              dataset: {
                for: options.name,
                fields: options.fields,
                dtypes: options.dtypes,
                options: options.options
              },
              innerText: options.title
            }
          }
        );
        attachResistanceSelectorCloseHandler(getOpenResistanceSelectorApp(item, attribute), item, state, key, attribute, renderTags, onChange);
        return;
      }
      ui.notifications?.warn?.("PF1 damage resistance selector is not available.");
      return;
    }
    const app = new Selector({
      document: item,
      ...options
    });
    attachResistanceSelectorCloseHandler(app, item, state, key, attribute, renderTags, onChange);
    app.render(true);
  };

  editBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openPicker();
  });
  renderTags();
}

function makeGrantedDefenseWriteState(section, item, state, sheetAppId) {
  return ({ preserveResistanceState = false } = {}) => {
    state.enabled = section.querySelector('input[data-nas-key="enabled"]')?.checked === true;
    ReactiveUiState.set(sheetAppId, "grantedDefenses", state);
    syncReactiveSectionCollapsedChrome(section, state.enabled);
    scheduleFlagSave(item, "grantedDefenses", (flags) => {
      const previous = normalizeGrantedDefenses(flags.grantedDefenses);
      flags.grantedDefenses = {
        ...toGrantedDefensesPayload(state),
        ...(preserveResistanceState ? { dr: previous.dr, eres: previous.eres } : {})
      };
      return flags;
    });
  };
}

async function renderGrantedDefensesSection(sheet, root) {
  const detailsTab = findDetailsTab(root);
  if (!detailsTab) return;
  const item = sheet?.item;
  if (!item || !["buff", "equipment"].includes(item.type)) return;
  if (detailsTab.querySelector(".nas-granted-defenses")) return;

  const appKey = "grantedDefenses";
  const fromFlag = normalizeGrantedDefenses(getReactiveFlags(item).grantedDefenses);
  const state = deepClone(fromFlag);
  ReactiveUiState.set(sheet.appId, appKey, state);

  const section = document.createElement("div");
  section.classList.add("nas-granted-defenses");
  section.innerHTML = `
    <h3 class="form-header nas-reactive-section-header" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
      <span>${localize("grantedDefensesHeader")}</span>
      <label class="checkbox" style="margin:0;font-weight:normal;font-size:var(--font-size-14,0.875rem);" title="${localize("enabled")}">
        <input type="checkbox" data-nas-key="enabled" ${state.enabled ? "checked" : ""}>
      </label>
    </h3>
    <div data-nas-reactive-body>
      <div class="form-group">
        <label>${localizeSystem("PF1.DamRed")}</label>
        <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
          <ul class="traits-list tag-list" data-nas-defense-tags="dr" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-nas-defense-edit="dr" class="nas-reactive-trait-edit" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
        </div>
      </div>
      <div class="form-group">
        <label>${localize("grantedDefenseER")}</label>
        <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
          <ul class="traits-list tag-list" data-nas-defense-tags="eres" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
          <a data-nas-defense-edit="eres" class="nas-reactive-trait-edit" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
        </div>
      </div>
      ${["di", "ci", "dv"].map((key) => `
        <div class="form-group">
          <label>${localize(`grantedDefense${key.toUpperCase()}`)}</label>
          <div class="form-fields nas-reactive-dt-row" style="display:flex;align-items:center;gap:6px;width:100%;">
            <ul class="traits-list tag-list" data-nas-defense-tags="${key}" style="flex:1;min-width:0;min-height:var(--form-field-height,26px);margin:0;"></ul>
            <a data-nas-defense-edit="${key}" class="nas-reactive-trait-edit" title="${localize("editSelection")}" style="flex:0 0 auto;opacity:0.9;"><i class="fa-solid fa-edit" inert></i></a>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  const absorption = detailsTab.querySelector(".nas-absorption-effects");
  const onStruck = detailsTab.querySelector(".nas-onstruck-effects");
  const advanced = findAdvancedHeaderInTab(detailsTab);
  const anchor = absorption ?? onStruck ?? advanced;
  if (anchor) detailsTab.insertBefore(section, anchor);
  else detailsTab.appendChild(section);

  const writeState = makeGrantedDefenseWriteState(section, item, state, sheet.appId);

  section.querySelector('input[data-nas-key="enabled"]')?.addEventListener("change", (event) => {
    excludeNasChangeFromParentForm(event);
    writeState();
  });
  attachGrantedDefenseResistanceField(section, item, state, "dr", writeState);
  attachGrantedDefenseResistanceField(section, item, state, "eres", writeState);
  for (const key of ["di", "ci", "dv"]) attachGrantedDefenseMultiField(section, item, state, key, writeState);
  syncReactiveSectionCollapsedChrome(section, state.enabled);
}

async function renderTemporaryHpSection(sheet, root) {
  const detailsTab = findDetailsTab(root);
  if (!detailsTab) return;
  const item = sheet?.item;
  if (!item || !["buff", "equipment"].includes(item.type)) return;
  if (detailsTab.querySelector(".nas-temporary-hp")) return;

  const appKey = "temporaryHp";
  const fromState = ReactiveUiState.get(sheet.appId, appKey);
  const fromFlag = normalizeTemporaryHpConfig(getReactiveFlags(item).temporaryHp, item);
  const state = deepClone(fromState ?? fromFlag);
  state.stackingMode = normalizeTemporaryHpStackingMode(state.stackingMode);
  state.compatibilityMode = normalizeTemporaryHpCompatibilityMode(state.compatibilityMode);
  ReactiveUiState.set(sheet.appId, appKey, state);

  const section = document.createElement("div");
  section.classList.add("nas-temporary-hp");
  section.innerHTML = `
    <h3 class="form-header nas-reactive-section-header" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
      <span>${localize("temporaryHpHeader")}</span>
      <label class="checkbox" style="margin:0;font-weight:normal;font-size:var(--font-size-14,0.875rem);" title="${localize("enabled")}">
        <input type="checkbox" data-nas-key="enabled" ${state.enabled ? "checked" : ""}>
      </label>
    </h3>
    <div data-nas-reactive-body>
      <div class="form-group">
        <label>${localize("temporaryHpAmount")}</label>
        <div class="form-fields">
          <input type="number" min="0" step="1" data-nas-key="max" value="${Number(state.max) || 0}">
        </div>
      </div>
      <div class="form-group">
        <label>${localize("temporaryHpStacking")}</label>
        <div class="form-fields">
          <select data-nas-key="stackingMode">
            ${temporaryHpStackingOptionsHtml(state.stackingMode)}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>${localize("temporaryHpCompatibility")}</label>
        <div class="form-fields">
          <select data-nas-key="compatibilityMode">
            ${temporaryHpCompatibilityOptionsHtml(state.compatibilityMode)}
          </select>
        </div>
      </div>
    </div>
  `;

  const grantedDefenses = detailsTab.querySelector(".nas-granted-defenses");
  const absorption = detailsTab.querySelector(".nas-absorption-effects");
  const onStruck = detailsTab.querySelector(".nas-onstruck-effects");
  const advanced = findAdvancedHeaderInTab(detailsTab);
  const anchor = grantedDefenses?.nextSibling ?? absorption ?? onStruck ?? advanced;
  if (anchor) detailsTab.insertBefore(section, anchor);
  else detailsTab.appendChild(section);

  const updateRows = () => {
    syncReactiveSectionCollapsedChrome(section, state.enabled);
  };

  const writeState = () => {
    state.enabled = section.querySelector('input[data-nas-key="enabled"]')?.checked === true;
    state.max = Math.max(0, Math.floor(Number(section.querySelector('input[data-nas-key="max"]')?.value) || 0));
    state.stackingMode = normalizeTemporaryHpStackingMode(section.querySelector('select[data-nas-key="stackingMode"]')?.value);
    state.compatibilityMode = normalizeTemporaryHpCompatibilityMode(section.querySelector('select[data-nas-key="compatibilityMode"]')?.value);
    state.label = item.name ?? "";
    state.showBadge = false;
    ReactiveUiState.set(sheet.appId, appKey, state);
    updateRows();
    scheduleFlagSave(item, "temporaryHp", (flags) => {
      const previous = normalizeTemporaryHpConfig(flags.temporaryHp, item);
      const next = toTemporaryHpPayload(state);
      const resetPool = next.enabled && (
        previous.enabled !== true
        || previous.max !== next.max
        || !Number.isFinite(Number(previous.remaining))
      );
      flags.temporaryHp = {
        ...next,
        remaining: resetPool ? next.max : Math.min(previous.remaining ?? next.max, next.max),
        capacity: resetPool ? next.max : next.max,
        createdAt: resetPool || !Number.isFinite(Number(previous.createdAt)) ? Date.now() : previous.createdAt,
        label: item.name ?? next.label,
        showBadge: false
      };
      return flags;
    });
  };

  for (const control of section.querySelectorAll("input, select")) {
    control.addEventListener("change", (event) => {
      excludeNasChangeFromParentForm(event);
      writeState();
    });
  }
  syncReactiveSectionCollapsedChrome(section, state.enabled);
}

function onRenderItemActionSheet(sheet, html) {
  const root = elementFromHtmlLike(sheet?.element) ?? elementFromHtmlLike(html);
  if (!root) return;
  void renderBuffSaveGateSection(sheet, root)
    .then(() => renderOnHitSection(sheet, root))
    .finally(() => scheduleNasScrollRestoreRetry(sheet));
}

function onRenderItemSheet(sheet, html) {
  const root = elementFromHtmlLike(sheet?.element) ?? elementFromHtmlLike(html);
  const item = sheet?.item;
  if (!root) return;
  void renderOnHitSection(sheet, root)
    .then(() => renderOnStruckSection(sheet, root))
    .then(() => renderGrantedDefensesSection(sheet, root))
    .then(() => renderTemporaryHpSection(sheet, root))
    .finally(() => scheduleNasScrollRestoreRetry(sheet));
}

export function registerReactiveItemSheet() {
  if (game?.ready) void getBuffOptions();
  else Hooks.once("ready", () => void getBuffOptions());
  Hooks.on("renderItemActionSheet", onRenderItemActionSheet);
  Hooks.on("renderItemSheetPF", onRenderItemSheet);
}
