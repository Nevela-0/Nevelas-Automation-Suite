import { MODULE } from "../../../common/module.js";
import { getStoredBuffCasterLevel } from "../utils/spellLevels.js";
import { createNasId } from "../utils/nasIds.js";
import { chatMessageStyle } from "../../../common/foundryCompat.js";
import { toDamagePartModel } from "./instances.js";
import { applyReactiveDamageToActor, toggleReactiveBuff, toggleReactiveCondition } from "../../../integration/moduleSockets.js";
import { actorUsesWoundsVigor, isWvNoWoundsActor } from "../utils/woundsVigor.js";
import { getCreatureTypeState } from "../utils/creatureTypeUtils.js";
import { grantNasTemporaryHp } from "../buffs/temporaryHpPools.js";
import {
  canUserSeeTokenEffectBadge,
  refreshTokenEffectBadgesForActor,
  refreshTokenEffectBadgesForScene,
  registerTokenEffectBadgeProvider
} from "../utils/tokenEffectBadges.js";

const REACTIVE_FLAG_KEY = "itemReactiveEffects";
const ON_STRUCK_POOL_KEY = "onStruckPool";
const DEFAULT_TEMP_HP_BUFF_UUID = "Compendium.nevelas-automation-suite.Buffs.Item.ZlhaaFOfhZ3v2ct1";

function localize(path) {
  return game.i18n.localize(`NAS.reactive.${path}`);
}


function escHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function displayNameForOwnerItem(ownerItem, kind) {
  const raw = String(ownerItem?.name ?? "").trim();
  if (raw) return raw;
  return kind === "onHit"
    ? game.i18n.localize("NAS.reactive.chatSummary.onHitFallback")
    : game.i18n.localize("NAS.reactive.chatSummary.onStruckFallback");
}

function resolveConditionDisplayName(conditionId) {
  const id = String(conditionId ?? "").trim();
  if (!id) return game.i18n.localize("NAS.reactive.chatSummary.unknownCondition");
  for (const c of pf1?.registry?.conditions ?? []) {
    if (String(c?._id ?? "") === id) return String(c?.name ?? id);
  }
  return id;
}

function resolveBuffDisplayName(buffUuid) {
  const uuid = String(buffUuid ?? "").trim();
  if (!uuid) return game.i18n.localize("NAS.reactive.chatSummary.unknownBuff");
  try {
    if (typeof foundry.utils?.fromUuidSync === "function") {
      const doc = foundry.utils.fromUuidSync(uuid);
      if (doc?.name) return String(doc.name);
    }
  } catch (_err) {
    return game.i18n.localize("NAS.reactive.chatSummary.unknownBuff");
  }
  return game.i18n.localize("NAS.reactive.chatSummary.unknownBuff");
}

function actorChatName(actor) {
  return actor?.name ?? game.i18n.localize("NAS.common.labels.target");
}

function formatDamageTypeNames(typeIds) {
  const ids = Array.isArray(typeIds) ? typeIds.map((id) => String(id ?? "").trim()).filter(Boolean) : [];
  if (!ids.length) return game.i18n.localize("PF1.DamageTypes.untyped.Label");
  const labels = ids.map((raw) => {
    const id = raw || "untyped";
    if (id === "untyped") return game.i18n.localize("PF1.DamageTypes.untyped.Label");
    for (const [, value] of pf1?.registry?.damageTypes?.entries?.() ?? []) {
      if (String(value?.id ?? "") === id) return String(value?.name ?? id);
    }
    return id;
  });
  return [...new Set(labels)].join(", ");
}

function getReactiveFlags(item) {
  return foundry.utils.deepClone(item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY] ?? {});
}

function getActionIdFromOptions(options = {}) {
  return String(
    options?.action?.id
    ?? options?.actionId
    ?? options?.message?.system?.action?.id
    ?? ""
  ).trim();
}

function resolveActorFromSpeaker(speaker) {
  const actorId = speaker?.actor;
  if (actorId) {
    const actor = game.actors?.get?.(actorId);
    if (actor) return actor;
  }
  const tokenId = speaker?.token;
  if (tokenId) {
    const token = canvas?.tokens?.get?.(tokenId);
    const actor = token?.actor ?? null;
    if (actor) return actor;
  }
  return null;
}

function resolveActorFromNasReactiveAttackerUuid(options) {
  const uuid = options?._nasReactiveAttackerUuid;
  if (!uuid || typeof uuid !== "string") return null;
  try {
    if (typeof foundry.utils?.fromUuidSync === "function") {
      const doc = foundry.utils.fromUuidSync(uuid);
      if (doc && doc.documentName === "Actor") return doc;
    }
  } catch (_err) {
    return null;
  }
  return null;
}

export function resolveSourceActorFromOptions(options = {}) {
  const fromNasUuid = resolveActorFromNasReactiveAttackerUuid(options);
  if (fromNasUuid) return fromNasUuid;
  const direct =
    options?.action?.actor
    ?? options?.item?.actor
    ?? options?.message?.actor
    ?? null;
  if (direct) return direct;
  return resolveActorFromSpeaker(options?.message?.speaker);
}

function normalizeDamageTypes(effect = {}) {
  const fromArray = Array.isArray(effect?.damageTypes)
    ? effect.damageTypes.map((d) => String(d ?? "").trim()).filter(Boolean)
    : [];
  if (fromArray.length) return [...new Set(fromArray)];
  const one = String(effect?.damageType ?? "").trim();
  return one ? [one] : ["untyped"];
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

function normalizeEffect(effect = {}) {
  const damageTypes = normalizeDamageTypes(effect);
  const temporaryHpDuration = effect?.temporaryHpDuration && typeof effect.temporaryHpDuration === "object"
    ? foundry.utils.deepClone(effect.temporaryHpDuration)
    : null;
  return {
    type: String(effect?.type ?? ""),
    mode: String(effect?.mode ?? "formula"),
    value: Number(effect?.value) || 0,
    formula: String(effect?.formula ?? ""),
    damageType: String(effect?.damageType ?? damageTypes[0] ?? "untyped"),
    damageTypes,
    buffUuid: String(effect?.buffUuid ?? ""),
    conditionId: String(effect?.conditionId ?? ""),
    asTemporaryHp: effect?.asTemporaryHp === true,
    temporaryHpDuration,
    temporaryHpStackingMode: normalizeTemporaryHpStackingMode(effect?.temporaryHpStackingMode),
    temporaryHpCompatibilityMode: normalizeTemporaryHpCompatibilityMode(effect?.temporaryHpCompatibilityMode),
    temporaryHpCapMode: normalizeTemporaryHpCapMode(effect?.temporaryHpCapMode),
    message: effect?.message !== false
  };
}

function normalizeOnStruckSourceKind(value) {
  const kind = String(value ?? "anyMelee");
  if (["any", "anyMelee", "meleeWeapon", "meleeNoReach", "reachMelee", "naturalAttack", "unarmedStrike", "spell"].includes(kind)) return kind;
  if (kind === "naturalWeapon") return "naturalAttack";
  if (kind === "nonWeapon") return "spell";
  return "anyMelee";
}

function normalizeAttackerCreatureKind(value) {
  const kind = String(value ?? "any");
  return ["any", "living", "undead", "construct", "nonliving"].includes(kind) ? kind : "any";
}

function normalizeSaveConfig(raw = {}) {
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
    type: ["fort", "ref", "will"].includes(type) ? type : "",
    dcFormula: String(raw?.dcFormula ?? raw?.dc ?? ""),
    skipDialog: raw?.skipDialog === true,
    onSuccess: ["none", "negates", "half"].includes(String(raw?.onSuccess ?? "")) ? String(raw.onSuccess) : "negates",
    effects: {
      success: normalizeOutcome(raw?.effects?.success ?? raw?.successEffect),
      failure: normalizeOutcome(raw?.effects?.failure ?? raw?.failureEffect)
    }
  };
}

function normalizeOnStruckDamageRule(raw = {}, fallback = {}) {
  const damageTypes = normalizeDamageTypes({
    damageTypes: raw?.damageTypes ?? raw?.damageTypeIds ?? fallback.damageTypes,
    damageType: raw?.damageType ?? fallback.damageType
  });
  return {
    id: String(raw?.id ?? createNasId()),
    enabled: raw?.enabled !== false,
    mode: String(raw?.mode ?? fallback.mode ?? "formula") === "percentOfFinalDamage" ? "percentOfFinalDamage" : "formula",
    value: Number(raw?.value ?? fallback.value) || 0,
    formula: String(raw?.formula ?? fallback.formula ?? "1d6"),
    damageType: String(raw?.damageType ?? damageTypes[0] ?? "untyped"),
    damageTypes,
    sourceKind: normalizeOnStruckSourceKind(raw?.sourceKind ?? fallback.sourceKind),
    onlyIfDamaged: raw?.onlyIfDamaged === true,
    attackerCreatureKind: normalizeAttackerCreatureKind(raw?.attackerCreatureKind),
    save: normalizeSaveConfig(raw?.save),
    spendPool: raw?.spendPool === true,
    message: raw?.message !== false
  };
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

function summarizeOnStruckPool(raw) {
  const pool = normalizeOnStruckPool(raw?.pool ?? raw?.[ON_STRUCK_POOL_KEY] ?? {});
  const rules = Array.isArray(raw?.rules) ? raw.rules.map((rule) => normalizeOnStruckDamageRule(rule)) : [];
  return {
    enabled: raw?.enabled === true,
    pool,
    ruleCount: rules.length,
    spendPoolRuleCount: rules.filter((rule) => rule.spendPool === true).length
  };
}

function rulesFromLegacyEffects(effects = [], filters = {}) {
  return effects
    .filter((effect) => String(effect?.type ?? "") === "damageAttacker")
    .map((effect) => normalizeOnStruckDamageRule(effect, {
      sourceKind: filters?.meleeOnly === false ? "any" : filters?.excludeReach === false ? "anyMelee" : "meleeNoReach"
    }));
}

const TOGGLE_EFFECT_TYPES = new Set([
  "applyConditionAttacker",
  "removeConditionAttacker",
  "applyBuffAttacker",
  "removeBuffAttacker",
  "applyConditionTarget",
  "removeConditionTarget",
  "applyBuffTarget",
  "removeBuffTarget"
]);

function effectActsOnTarget(effect, context = {}) {
  const type = String(effect?.type ?? "");
  if (type.endsWith("Target")) return true;
  if (type === "grantTemporaryHp") {
    const mode = String(effect?.mode ?? "");
    if (mode === "percentOfExcessHealing") return true;
    if (mode === "formula" && context?.finalHealing > 0) return true;
  }
  return false;
}

function buildReactiveLineHtml({ effect, magnitude, affectedActor, triggerKind: _triggerKind }) {
  void _triggerKind;
  const actor = escHtml(actorChatName(affectedActor));
  const effectType = String(effect?.type ?? "");
  const isToggleEffect = TOGGLE_EFFECT_TYPES.has(effectType);

  if (isToggleEffect) {
    if (effectType.includes("Condition")) {
      const name = escHtml(resolveConditionDisplayName(effect.conditionId));
      if (effectType.startsWith("apply")) {
        return game.i18n.format("NAS.reactive.chatSummary.lineApplyCondition", { name, actor });
      }
      return game.i18n.format("NAS.reactive.chatSummary.lineRemoveCondition", { name, actor });
    }
    const name = escHtml(resolveBuffDisplayName(effect.buffUuid));
    if (effectType.startsWith("apply")) {
      return game.i18n.format("NAS.reactive.chatSummary.lineApplyBuff", { name, actor });
    }
    return game.i18n.format("NAS.reactive.chatSummary.lineRemoveBuff", { name, actor });
  }

  if (effectType === "healAttacker") {
    if (effect?.asTemporaryHp === true) {
      return game.i18n.format("NAS.reactive.chatSummary.lineTemporaryHp", { actor, amount: magnitude });
    }
    return game.i18n.format("NAS.reactive.chatSummary.lineHeal", { actor, amount: magnitude });
  }
  if (effectType === "grantTemporaryHp") {
    return game.i18n.format("NAS.reactive.chatSummary.lineTemporaryHp", { actor, amount: magnitude });
  }
  if (effectType === "damageAttacker") {
    const types = escHtml(formatDamageTypeNames(effect?.damageTypes));
    return game.i18n.format("NAS.reactive.chatSummary.lineDamage", { actor, amount: magnitude, types });
  }

  return null;
}

function postReactiveChatSummary({ ownerActor, otherActor, ownerItemPlain, triggerKind, finalDamage, lineHtmls }) {
  if (!lineHtmls.length) return;

  const titleKey =
    triggerKind === "onHit" ? "NAS.reactive.chatSummary.onHitTitle" : "NAS.reactive.chatSummary.onStruckTitle";
  const title = game.i18n.format(titleKey, { item: escHtml(ownerItemPlain) });
  const subtitleKey =
    triggerKind === "onHit"
      ? "NAS.reactive.chatSummary.subtitleOnHit"
      : "NAS.reactive.chatSummary.subtitleOnStruck";
  const subtitle = game.i18n.format(subtitleKey, {
    other: escHtml(actorChatName(otherActor)),
    finalDamage: String(Math.max(0, Number(finalDamage) || 0))
  });

  const innerLines = lineHtmls.map((html) => `<li>${html}</li>`).join("");
  const content = [
    `<div class="nas-reactive-chat-summary" data-nas-reactive-summary>`,
    `<div class="nas-reactive-chat-header"><strong>${title}</strong></div>`,
    `<div class="nas-reactive-chat-subtitle">${subtitle}</div>`,
    `<ul class="nas-reactive-chat-lines">`,
    innerLines,
    `</ul></div>`
  ].join("");

  const speakerData = ChatMessage.getSpeaker({ actor: ownerActor ?? null });
  ChatMessage.create({
    ...chatMessageStyle("OTHER"),
    user: game.user?.id,
    speaker: speakerData,
    content
  });
}

function buildOnHitFromRaw(raw) {
  if (!raw || raw.enabled !== true || !Array.isArray(raw.effects) || raw.effects.length === 0) {
    return null;
  }
  return {
    effects: raw.effects.map(normalizeEffect)
  };
}

function getOnHitConfig(sourceItem, actionId) {
  const flags = getReactiveFlags(sourceItem);
  const overrideRaw = flags?.onHitByActionOverride?.[actionId];
  const fromOverride = buildOnHitFromRaw(overrideRaw);
  if (fromOverride) return fromOverride;
  const baseRaw = flags?.onHitByAction?.[actionId] ?? null;
  const fromActionBase = buildOnHitFromRaw(baseRaw);
  if (fromActionBase) return fromActionBase;
  return buildOnHitFromRaw(flags?.onHit);
}

function isItemOnStruckActive(item) {
  if (!item) return false;
  if (item.type === "buff") return item.system?.active === true;
  if (item.type === "equipment") return item.system?.equipped === true;
  return false;
}

function getOnStruckConfigs(targetActor) {
  if (!targetActor?.items) return [];
  const out = [];
  for (const item of targetActor.items) {
    if (!["buff", "equipment"].includes(item?.type)) continue;
    if (!isItemOnStruckActive(item)) continue;
    const flags = getReactiveFlags(item);
    const raw = flags?.onStruck ?? null;
    if (!raw || raw.enabled !== true) continue;
    const effects = Array.isArray(raw.effects) ? raw.effects.map(normalizeEffect) : [];
    const rules = Array.isArray(raw.rules) && raw.rules.length
      ? raw.rules.map((rule) => normalizeOnStruckDamageRule(rule))
      : rulesFromLegacyEffects(effects, raw?.filters);
    if (!effects.length && !rules.length) continue;
    out.push({
      sourceItem: item,
      effects,
      rules,
      pool: normalizeOnStruckPool(raw?.pool ?? raw?.[ON_STRUCK_POOL_KEY] ?? {})
    });
  }
  return out;
}

function resolveActionType(options = {}) {
  return String(
    options?.action?.actionType
    ?? options?.message?.system?.action?.actionType
    ?? ""
  ).toLowerCase();
}

const _PF1_MELEE_LIKE = new Set(["mwak", "msak", "mcman"]);

function resolveRangeUnits(options = {}) {
  return String(
    options?.action?.range?.units ?? options?.message?.system?.action?.range?.units ?? ""
  ).toLowerCase();
}

function isMeleeContext(options = {}) {
  const type = resolveActionType(options);
  return _PF1_MELEE_LIKE.has(type);
}

function isReachContext(options = {}) {
  return resolveRangeUnits(options) === "reach";
}

function sourceItemFromOptions(options = {}) {
  const action = options?.action;
  return options?.item ?? action?.item ?? options?.message?.itemSource ?? null;
}

function isNaturalAttackContext(options = {}) {
  const item = sourceItemFromOptions(options);
  const action = options?.action;
  const candidates = [
    item?.subType,
    item?.system?.subType,
    item?.system?.weaponType,
    item?.system?.weaponSubtype,
    action?.weaponType,
    action?.weaponSubtype,
    action?.attackType
  ].map((value) => String(value ?? "").toLowerCase());
  return candidates.some((value) => value.includes("natural"));
}

function isUnarmedStrikeContext(options = {}) {
  const item = sourceItemFromOptions(options);
  const action = options?.action;
  const candidates = [
    item?.name,
    action?.name,
    item?.system?.weaponType,
    item?.system?.weaponSubtype,
    action?.weaponType,
    action?.weaponSubtype
  ].map((value) => String(value ?? "").toLowerCase());
  return candidates.some((value) => value.includes("unarmed"));
}

function isWeaponContext(options = {}) {
  const item = sourceItemFromOptions(options);
  const action = options?.action;
  const type = item?.type ?? action?.item?.type;
  const subType = item?.subType ?? item?.system?.subType ?? action?.item?.subType;
  return type === "weapon" || (type === "attack" && ["weapon", "natural"].includes(String(subType ?? "")));
}

function sourceMatchesOnStruckRule(rule, options = {}) {
  const kind = normalizeOnStruckSourceKind(rule?.sourceKind);
  const melee = isMeleeContext(options);
  const reach = isReachContext(options);
  const actionType = resolveActionType(options);
  if (kind === "any") return true;
  if (kind === "spell") return actionType === "msak" || actionType === "rsak" || sourceItemFromOptions(options)?.type === "spell";
  if (!melee) return false;
  if (kind === "anyMelee") return true;
  if (kind === "meleeNoReach") return !reach;
  if (kind === "reachMelee") return reach;
  if (kind === "naturalAttack") return isNaturalAttackContext(options);
  if (kind === "unarmedStrike") return isUnarmedStrikeContext(options);
  if (kind === "meleeWeapon") return isWeaponContext(options) && !isNaturalAttackContext(options) && !isUnarmedStrikeContext(options);
  return true;
}

function creatureMatchesOnStruckRule(rule, sourceActor) {
  const kind = normalizeAttackerCreatureKind(rule?.attackerCreatureKind);
  if (kind === "any") return true;
  const state = getCreatureTypeState(sourceActor);
  if (kind === "living") return state.isLiving;
  if (kind === "undead") return state.isUndead;
  if (kind === "construct") return state.isConstruct;
  if (kind === "nonliving") return state.isUndead || state.isConstruct;
  return true;
}

function buildRollData({ sourceActor, targetActor, finalDamage = 0, excessHealing = 0, finalHealing = 0 }) {
  const sourceRollData = sourceActor?.getRollData?.() ?? {};
  const targetRollData = targetActor?.getRollData?.() ?? {};
  return {
    ...targetRollData,
    ...sourceRollData,
    nas: {
      finalDamage: Number(finalDamage) || 0,
      excessHealing: Number(excessHealing) || 0,
      finalHealing: Number(finalHealing) || 0
    },
    attacker: sourceRollData,
    target: targetRollData
  };
}

async function evaluateMagnitude(effect, context) {
  const mode = String(effect?.mode ?? "formula");
  if (mode === "percentOfFinalDamage") {
    const pct = Number(effect?.value) || 0;
    const base = Math.max(0, Number(context?.finalDamage) || 0);
    const out = Math.floor((base * pct) / 100);
    return out;
  }
  if (mode === "percentOfExcessHealing") {
    const pct = Number(effect?.value) || 0;
    const base = Math.max(0, Number(context?.excessHealing) || 0);
    return Math.floor((base * pct) / 100);
  }
  if (mode === "formula") {
    const formula = String(effect?.formula ?? "").trim();
    if (!formula) return 0;
    try {
      const roll = await new Roll(formula, context.rollData).evaluate();
      return Math.max(0, Math.floor(Number(roll?.total) || 0));
    } catch (_err) {
      return 0;
    }
  }
  return 0;
}

function numericActorHpValue(actor) {
  const value = Number(actor?.system?.attributes?.hp?.value);
  return Number.isFinite(value) ? value : 0;
}

function numericActorHpMax(actor) {
  const value = Number(actor?.system?.attributes?.hp?.max);
  return Number.isFinite(value) ? value : 0;
}

function numericActorConstitution(actor) {
  const ability = actor?.system?.abilities?.con ?? {};
  for (const value of [ability.total, ability.value, ability.base]) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function resolveTemporaryHpPrivateCap(effect, metadata = {}) {
  const mode = normalizeTemporaryHpCapMode(effect?.temporaryHpCapMode);
  if (mode === "none") return null;
  if (mode === "sourceMaxHp" || mode === "sourceNormalMaxHp") {
    return Math.max(0, Math.floor(numericActorHpMax(metadata.sourceActor ?? metadata.affectedActor)));
  }
  if (mode === "targetHpPlusCon") {
    const target = metadata.targetActor;
    const preHp = Number.isFinite(Number(metadata.targetPreHp)) ? Number(metadata.targetPreHp) : numericActorHpValue(target);
    return Math.max(0, Math.floor(preHp + numericActorConstitution(target)));
  }
  return null;
}

async function evaluateNumberFormula(formula, context, fallback = 0) {
  const text = String(formula ?? "").trim();
  if (!text) return fallback;
  try {
    const roll = await new Roll(text, context.rollData).evaluate();
    return Math.max(0, Math.floor(Number(roll?.total) || 0));
  } catch (_err) {
    return fallback;
  }
}

function buildDamageInstances(amount, effect) {
  const typesRaw = normalizeDamageTypes(effect);
  const types = typesRaw.length ? typesRaw : ["untyped"];
  return [toDamagePartModel({ types, value: amount, formula: String(amount) })];
}

function extractRollTotal(rollResult) {
  if (!rollResult) return null;
  const direct = Number(rollResult.total);
  if (Number.isFinite(direct)) return direct;
  const first = Number(rollResult?.rolls?.[0]?.total);
  if (Number.isFinite(first)) return first;
  const nested = Number(rollResult?.roll?.total);
  if (Number.isFinite(nested)) return nested;
  return null;
}

async function resolveSavingThrowResult(rule, sourceActor, context, options = {}) {
  const save = normalizeSaveConfig(rule?.save);
  if (!save.enabled) return { multiplier: 1, outcome: "none" };
  if (!sourceActor?.isOwner) {
    ui.notifications?.warn?.(game.i18n.format("NAS.reactive.warnings.saveUnavailable", {
      actor: actorChatName(sourceActor)
    }));
    return { multiplier: 0, outcome: "skipped" };
  }
  const dc = await evaluateNumberFormula(save.dcFormula, context, 0);
  if (dc <= 0) return { multiplier: 1, outcome: "none" };
  let result = null;
  try {
    result = await sourceActor.rollSavingThrow(save.type, {
      dc,
      event: options?.event,
      reference: options?.reference ?? options?.message,
      skipDialog: save.skipDialog
    });
  } catch (_err) {
    ui.notifications?.warn?.(game.i18n.format("NAS.reactive.warnings.saveFailed", {
      actor: actorChatName(sourceActor)
    }));
    return { multiplier: 0, outcome: "skipped" };
  }
  const total = extractRollTotal(result);
  if (total == null || total < dc) return { multiplier: 1, outcome: "failure" };
  if (save.onSuccess === "half") return { multiplier: 0.5, outcome: "success" };
  if (save.onSuccess === "none") return { multiplier: 1, outcome: "success" };
  return { multiplier: 0, outcome: "success" };
}

function getHealthSnapshotForDelta(actor) {
  const a = actor?.system?.attributes;
  if (!a) return null;
  if (actorUsesWoundsVigor(actor)) {
    const noW = isWvNoWoundsActor(actor);
    const vigor = (Number(a.vigor?.value) || 0) + (Number(a.vigor?.temp) || 0);
    const wounds = noW || a.wounds?.value === undefined ? 0 : Number(a.wounds?.value) || 0;
    return { kind: "wv", vigor, wounds, noWounds: noW };
  }
  if (a.hp && a.hp.value !== undefined) {
    return { kind: "hp", hp: Number(a.hp.value) || 0 };
  }
  return null;
}

function hurtDeltaFromSnapshots(pre, post, isHeal) {
  if (!pre || !post) return null;
  if (pre.kind !== post.kind) return null;
  if (pre.kind === "hp" && post.kind === "hp") {
    if (isHeal) return Math.max(0, post.hp - pre.hp);
    return Math.max(0, pre.hp - post.hp);
  }
  if (pre.kind === "wv" && post.kind === "wv") {
    if (isHeal) {
      const hv = Math.max(0, post.vigor - pre.vigor);
      const hW = pre.noWounds ? 0 : Math.max(0, post.wounds - pre.wounds);
      return hv + hW;
    }
    const dV = Math.max(0, pre.vigor - post.vigor);
    const dW = pre.noWounds ? 0 : Math.max(0, pre.wounds - post.wounds);
    return dV + dW;
  }
  return null;
}

async function applyToActor(actor, effect, magnitude, metadata = {}) {
  if (!actor) return undefined;
  if (effect?.type === "applyConditionAttacker" || effect?.type === "applyConditionTarget") {
    if (!effect.conditionId) return;
    await toggleReactiveCondition(actor, effect.conditionId, true);
    return;
  }
  if (effect?.type === "removeConditionAttacker" || effect?.type === "removeConditionTarget") {
    if (!effect.conditionId) return;
    await toggleReactiveCondition(actor, effect.conditionId, false);
    return;
  }
  if (effect?.type === "applyBuffAttacker" || effect?.type === "applyBuffTarget") {
    if (!effect.buffUuid) return;
    await toggleReactiveBuff(actor, effect.buffUuid, true);
    return;
  }
  if (effect?.type === "removeBuffAttacker" || effect?.type === "removeBuffTarget") {
    if (!effect.buffUuid) return;
    await toggleReactiveBuff(actor, effect.buffUuid, false);
    return;
  }
  if (!Number.isFinite(magnitude) || magnitude <= 0) return undefined;
  const isHeal = effect.type === "healAttacker";
  const isTemporaryHpGrant = effect.type === "grantTemporaryHp" || (isHeal && effect?.asTemporaryHp === true);
  if (isTemporaryHpGrant) {
    const rawAmount = Math.max(0, Math.floor(Number(magnitude) || 0));
    const cap = resolveTemporaryHpPrivateCap(effect, { ...metadata, affectedActor: actor });
    const amount = cap == null ? rawAmount : Math.min(rawAmount, cap);
    if (amount <= 0) {
      return undefined;
    }
    const pool = await grantNasTemporaryHp(actor, {
      amount,
      sourceItemUuid: metadata.ownerItemUuid ?? "",
      sourceBuffUuid: DEFAULT_TEMP_HP_BUFF_UUID,
      sourceKey: metadata.ownerItemUuid ? `item:${metadata.ownerItemUuid}` : "",
      duration: effect.temporaryHpDuration ?? null,
      stackingMode: effect.temporaryHpStackingMode,
      compatibilityMode: effect.temporaryHpCompatibilityMode,
      label: metadata.ownerItemName ?? metadata.source ?? game.i18n.localize("PF1.TempHP"),
      showBadge: false,
      clearDuration: true
    });
    return pool ? Math.max(0, Math.floor(Number(pool.gainedAmount ?? amount) || 0)) : undefined;
  }
  const value = isHeal ? -Math.abs(magnitude) : Math.abs(magnitude);
  const options = {
    dialog: false,
    _nasReactiveEffect: true,
    _nasReactiveSource: metadata.source ?? "unknown"
  };
  if (metadata.attackerUuid) {
    options._nasReactiveAttackerUuid = metadata.attackerUuid;
  }
  if (!isHeal) {
    options.instances = buildDamageInstances(Math.abs(magnitude), effect);
  }
  const pre = getHealthSnapshotForDelta(actor);
  await applyReactiveDamageToActor(actor, value, options);
  const post = getHealthSnapshotForDelta(actor);
  const hurtDelta = hurtDeltaFromSnapshots(pre, post, isHeal);
  if (String(effect.type) === "healAttacker" || String(effect.type) === "damageAttacker") {
    if (hurtDelta != null) return hurtDelta;
  }
  return undefined;
}

async function applySaveOutcomeEffect(actor, outcomeEffect, metadata = {}) {
  const kind = String(outcomeEffect?.effectKind ?? "none");
  if (kind === "applyBuff") {
    const buffUuid = String(outcomeEffect?.buffUuid ?? "").trim();
    if (!buffUuid) return undefined;
    return applyToActor(actor, { type: "applyBuffAttacker", buffUuid, message: true }, 1, metadata);
  }
  if (kind === "applyCondition") {
    const conditionId = String(outcomeEffect?.conditionId ?? "").trim();
    if (!conditionId) return undefined;
    return applyToActor(actor, { type: "applyConditionAttacker", conditionId, message: true }, 1, metadata);
  }
  return undefined;
}

function buildSaveOutcomeEffectLine(outcomeEffect, actor) {
  const kind = String(outcomeEffect?.effectKind ?? "none");
  if (kind === "applyBuff") {
    return buildReactiveLineHtml({
      effect: { type: "applyBuffAttacker", buffUuid: outcomeEffect.buffUuid },
      magnitude: 1,
      affectedActor: actor,
      triggerKind: "onStruck"
    });
  }
  if (kind === "applyCondition") {
    return buildReactiveLineHtml({
      effect: { type: "applyConditionAttacker", conditionId: outcomeEffect.conditionId },
      magnitude: 1,
      affectedActor: actor,
      triggerKind: "onStruck"
    });
  }
  return null;
}

function onStruckPoolUsesTotal(config) {
  return config?.pool?.enabled === true || (config?.rules ?? []).some((rule) => rule?.spendPool === true);
}

function numericCandidate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function matchingSpellCasterLevel(actor, item) {
  const itemName = String(item?.name ?? "").trim().toLowerCase();
  const itemImg = String(item?.img ?? "");
  const matches = (actor?.items ?? []).filter((candidate) => {
    if (candidate?.type !== "spell") return false;
    const sameName = itemName && String(candidate.name ?? "").trim().toLowerCase() === itemName;
    const sameImg = itemImg && String(candidate.img ?? "") === itemImg;
    return sameName || sameImg;
  });

  const candidates = [];
  for (const spell of matches) {
    const spellRollData = spell.getRollData?.() ?? {};
    candidates.push(
      numericCandidate(spellRollData?.cl),
      numericCandidate(spell?.casterLevel),
      numericCandidate(spell?.system?.cl)
    );
    const bookId = spell?.system?.spellbook;
    if (bookId) {
      const book = actor?.system?.attributes?.spells?.spellbooks?.[bookId];
      candidates.push(numericCandidate(book?.cl?.total), numericCandidate(book?.cl?.autoSpellLevelTotal));
    }
  }

  return Math.max(0, ...candidates.filter((value) => value != null));
}

function strongestActorSpellbookCasterLevel(actor) {
  const candidates = [];
  for (const book of Object.values(actor?.system?.attributes?.spells?.spellbooks ?? {})) {
    if (book?.inUse === false) continue;
    candidates.push(numericCandidate(book?.cl?.total), numericCandidate(book?.cl?.autoSpellLevelTotal));
  }
  return Math.max(0, ...candidates.filter((value) => value != null));
}

function resolveOnStruckPoolCasterLevel(actor, item, actorData = {}) {
  const itemData = item?.getRollData?.() ?? {};
  const storedBuffCl = numericCandidate(getStoredBuffCasterLevel(item, actor));
  const matchingSpellCl = matchingSpellCasterLevel(actor, item);
  const actorSpellbookCl = strongestActorSpellbookCasterLevel(actor);
  const actorDataCl = numericCandidate(actorData?.cl);
  const itemRollDataCl = numericCandidate(itemData?.cl);
  const itemLevel = numericCandidate(item?.system?.level);
  return storedBuffCl || itemLevel || itemRollDataCl || matchingSpellCl || actorSpellbookCl || actorDataCl || 0;
}

function rollDataForOnStruckPool(ownerActor, ownerItem, context = {}) {
  const actorData = ownerActor?.getRollData?.() ?? {};
  const itemData = ownerItem?.getRollData?.() ?? {};
  const cl = resolveOnStruckPoolCasterLevel(ownerActor, ownerItem, actorData);
  return {
    ...actorData,
    cl,
    item: itemData,
    nas: {
      ...(actorData?.nas ?? {}),
      finalDamage: Math.max(0, Number(context.finalDamage) || 0)
    },
    target: actorData
  };
}

async function remainingForOnStruckPool(item, pool, context = {}) {
  if (!pool?.enabled) return null;
  if (Number.isFinite(Number(pool.remaining)) && Number.isFinite(Number(pool.capacity))) {
    if (pool.remaining > 0 || pool.dischargeAtZero !== true) return Math.max(0, Math.floor(Number(pool.remaining)));
  }
  const rollData = rollDataForOnStruckPool(item?.actor, item, context);
  const total = await evaluateNumberFormula(pool.totalFormula, { rollData }, 0);
  await item.update({
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.onStruck.pool.remaining`]: total,
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.onStruck.pool.capacity`]: total
  }, { render: false });
  return total;
}

async function updateOnStruckPool(item, remaining, pool) {
  const normalizedRemaining = Math.max(0, Math.floor(Number(remaining) || 0));
  const updates = {
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.onStruck.pool.remaining`]: normalizedRemaining
  };
  if (pool?.dischargeAtZero === true && normalizedRemaining <= 0) {
    if (item?.type === "buff") updates["system.active"] = false;
    if (item?.type === "equipment") updates["system.equipped"] = false;
  }
  await item.update(updates, { render: false });
  refreshTokenEffectBadgesForActor(item?.actor);
}

async function applyOnStruckDamageRules({ sourceActor, targetActor, entry, finalDamage, options, triggerMeta }) {
  const rules = entry?.rules ?? [];
  if (!rules.length) return [];
  const lineHtmls = [];
  const rollData = buildRollData({ sourceActor, targetActor, finalDamage });
  const pool = entry.pool ?? {};

  for (const rule of rules) {
    if (rule?.enabled === false) continue;
    if (rule.onlyIfDamaged && Math.max(0, Number(finalDamage) || 0) <= 0) continue;
    if (!sourceMatchesOnStruckRule(rule, options)) continue;
    if (!creatureMatchesOnStruckRule(rule, sourceActor)) continue;

    let magnitude = await evaluateMagnitude({ ...rule, type: "damageAttacker" }, { finalDamage, rollData });
    if (magnitude <= 0) continue;
    const saveResult = await resolveSavingThrowResult(rule, sourceActor, { rollData }, options);
    if (saveResult.outcome === "success" || saveResult.outcome === "failure") {
      const save = normalizeSaveConfig(rule.save);
      const outcomeEffect = save.effects?.[saveResult.outcome];
      await applySaveOutcomeEffect(sourceActor, outcomeEffect, {
        source: triggerMeta.sourceTag,
        attackerUuid: sourceActor?.uuid ?? null
      });
      if (rule.message !== false) {
        const outcomeLine = buildSaveOutcomeEffectLine(outcomeEffect, sourceActor);
        if (outcomeLine) lineHtmls.push(outcomeLine);
      }
    }
    if (saveResult.multiplier <= 0) continue;
    magnitude = Math.floor(magnitude * saveResult.multiplier);
    if (magnitude <= 0) continue;

    if (rule.spendPool && pool.enabled) {
      const remaining = await remainingForOnStruckPool(triggerMeta.ownerItem, pool, { finalDamage });
      if (remaining <= 0) continue;
      magnitude = Math.min(magnitude, remaining);
      if (magnitude <= 0) continue;
    }

    const actualApplied = await applyToActor(sourceActor, { ...rule, type: "damageAttacker" }, magnitude, {
      source: triggerMeta.sourceTag,
      attackerUuid: sourceActor?.uuid ?? null
    });
    const actualDamage = Number.isFinite(actualApplied) ? Math.max(0, Math.floor(actualApplied)) : magnitude;

    if (rule.spendPool && pool.enabled && actualDamage > 0) {
      const freshPool = normalizeOnStruckPool(triggerMeta.ownerItem?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.onStruck?.pool ?? pool);
      const remaining = await remainingForOnStruckPool(triggerMeta.ownerItem, freshPool, { finalDamage });
      await updateOnStruckPool(triggerMeta.ownerItem, remaining - actualDamage, freshPool);
    }

    if (rule.message !== true) continue;
    const line = buildReactiveLineHtml({
      effect: { ...rule, type: "damageAttacker" },
      magnitude: actualDamage,
      affectedActor: sourceActor,
      triggerKind: "onStruck"
    });
    if (line) lineHtmls.push(line);
  }

  return lineHtmls;
}

async function applyEffects({ sourceActor, targetActor, effects, finalDamage, finalHealing = 0, excessHealing = 0, options, triggerMeta }) {
  const { kind, ownerActor, otherActor, ownerItem, sourceTag } = triggerMeta;
  const ownerItemPlain = displayNameForOwnerItem(ownerItem, kind);
  const lineHtmls = [];
  const rollData = buildRollData({ sourceActor, targetActor, finalDamage, finalHealing, excessHealing });

  for (const effect of effects) {
    const isToggleEffect = TOGGLE_EFFECT_TYPES.has(effect?.type);
    const magnitude = isToggleEffect ? 1 : await evaluateMagnitude(effect, { finalDamage, finalHealing, excessHealing, rollData });
    if (!isToggleEffect && magnitude <= 0) continue;
    const affectedActor = effectActsOnTarget(effect, { finalHealing }) ? targetActor : sourceActor;
    const effType = String(effect.type ?? "");
    const actualApplied = await applyToActor(affectedActor, effect, magnitude, {
      source: sourceTag,
      attackerUuid: sourceActor?.uuid ?? null,
      ownerItemUuid: ownerItem?.uuid ?? "",
      ownerItemName: ownerItemPlain,
      sourceActor,
      targetActor,
      targetPreHp: triggerMeta?.targetPreHp
    });
    const lineMagnitude = (effType === "healAttacker" || effType === "damageAttacker" || effType === "grantTemporaryHp") && Number.isFinite(actualApplied) ? actualApplied : magnitude;

    if (effect.message !== true) continue;
    if (!isToggleEffect && magnitude <= 0) continue;
    if ((effType === "healAttacker" || effType === "damageAttacker" || effType === "grantTemporaryHp") && Number.isFinite(actualApplied) && actualApplied <= 0) continue;
    const line = buildReactiveLineHtml({
      effect,
      magnitude: lineMagnitude,
      affectedActor,
      triggerKind: kind
    });
    if (line) lineHtmls.push(line);
  }

  if (kind === "onStruck" && Array.isArray(triggerMeta?.damageRules) && triggerMeta.damageRules.length) {
    const ruleLines = await applyOnStruckDamageRules({
      sourceActor,
      targetActor,
      entry: { rules: triggerMeta.damageRules, pool: triggerMeta.pool },
      finalDamage,
      options,
      triggerMeta
    });
    lineHtmls.push(...ruleLines);
  }

  if (lineHtmls.length) {
    postReactiveChatSummary({
      ownerActor,
      otherActor,
      ownerItemPlain,
      triggerKind: kind,
      finalDamage,
      lineHtmls
    });
  }
}

export async function applyReactiveEffectsForHit({
  sourceActor,
  sourceItem,
  targetActor,
  options = {},
  finalDamage = 0,
  finalHealing = 0,
  excessHealing = 0,
  targetPreHp = null
} = {}) {
  if (!sourceActor || !targetActor) return;
  if (options?._nasReactiveEffect) return;

  const actionId = getActionIdFromOptions(options);
  const onHit = getOnHitConfig(sourceItem, actionId);
  if (onHit) {
    await applyEffects({
      sourceActor,
      targetActor,
      effects: onHit.effects,
      finalDamage,
      finalHealing,
      excessHealing,
      options,
      triggerMeta: {
        kind: "onHit",
        ownerActor: sourceActor,
        otherActor: targetActor,
        ownerItem: sourceItem,
        sourceTag: "onHit",
        targetPreHp
      }
    });
  }

  if (options?._nasReactiveHealing === true) return;

  const onStruckConfigs = getOnStruckConfigs(targetActor);
  for (const entry of onStruckConfigs) {
    await applyEffects({
      sourceActor,
      targetActor,
      effects: entry.effects.filter((effect) => String(effect?.type ?? "") !== "damageAttacker"),
      finalDamage,
      options,
      triggerMeta: {
        kind: "onStruck",
        ownerActor: targetActor,
        otherActor: sourceActor,
        ownerItem: entry.sourceItem,
        sourceTag: "onStruck",
        damageRules: entry.rules,
        pool: entry.pool
      }
    });
  }
}

export function hasOnStruckDischargeData(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.onStruck;
  return Boolean(raw?.pool?.enabled === true || raw?.[ON_STRUCK_POOL_KEY]?.enabled === true);
}

export function hasOnStruckReactiveData(item) {
  return Boolean(item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.onStruck);
}

export async function initializeOnStruckReactiveItem(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.onStruck;
  if (!raw?.enabled) return false;
  const rules = Array.isArray(raw.rules) ? raw.rules.map((rule) => normalizeOnStruckDamageRule(rule)) : [];
  const pool = normalizeOnStruckPool(raw.pool ?? raw[ON_STRUCK_POOL_KEY] ?? {});
  if (!pool.enabled || !rules.some((rule) => rule.spendPool === true)) {
    refreshTokenEffectBadgesForActor(item?.actor);
    return false;
  }
  if (Number.isFinite(Number(pool.remaining)) && Number(pool.remaining) > 0 && Number.isFinite(Number(pool.capacity))) {
    refreshTokenEffectBadgesForActor(item?.actor);
    return false;
  }
  await remainingForOnStruckPool(item, pool, { finalDamage: 0 });
  refreshTokenEffectBadgesForActor(item?.actor);
  return true;
}

export async function resetOnStruckReactiveItem(item) {
  const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.onStruck;
  if (!raw?.enabled) return false;
  const pool = normalizeOnStruckPool(raw.pool ?? raw[ON_STRUCK_POOL_KEY] ?? {});
  if (!pool.enabled) {
    refreshTokenEffectBadgesForActor(item?.actor);
    return false;
  }
  const rollData = rollDataForOnStruckPool(item?.actor, item, { finalDamage: 0 });
  const total = await evaluateNumberFormula(pool.totalFormula, { rollData }, 0);
  await item.update({
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.onStruck.pool.remaining`]: total,
    [`flags.${MODULE.ID}.${REACTIVE_FLAG_KEY}.onStruck.pool.capacity`]: total
  }, { render: false });
  refreshTokenEffectBadgesForActor(item?.actor);
  return true;
}

export function registerOnStruckTokenEffectBadgeProvider() {
  registerTokenEffectBadgeProvider({
    id: "onStruck",
    getBadgesForToken(token) {
      const badges = [];
      for (const item of token?.actor?.items ?? []) {
        const raw = item?.flags?.[MODULE.ID]?.[REACTIVE_FLAG_KEY]?.onStruck;
        if (!raw) continue;
        const active = isItemOnStruckActive(item);
        const pool = normalizeOnStruckPool(raw.pool ?? raw[ON_STRUCK_POOL_KEY] ?? {});
        if (!active) continue;
        if (!raw?.enabled) continue;
        if (!pool.enabled || !pool.showBadge || !Number.isFinite(Number(pool.remaining)) || pool.remaining <= 0) continue;
        badges.push({
          item,
          value: pool.remaining,
          visible: canUserSeeTokenEffectBadge(item),
          name: item.id
        });
      }
      return badges;
    }
  });
}

export function refreshOnStruckSceneTokenEffects() {
  refreshTokenEffectBadgesForScene((token) => (token?.actor?.items ?? []).some((item) => hasOnStruckReactiveData(item)));
}

export async function initializeOnStruckSceneItems() {
  const seen = new Set();
  for (const token of canvas?.tokens?.placeables ?? []) {
    const actor = token?.actor;
    if (!actor || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    for (const item of actor.items ?? []) {
      if (hasOnStruckReactiveData(item)) await initializeOnStruckReactiveItem(item);
    }
  }
}
