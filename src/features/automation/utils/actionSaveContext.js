import { MODULE } from "../../../common/module.js";

export const ACTION_SAVE_CONTEXT = "actionSaveContext";
const SAVE_TYPES = new Set(["fort", "ref", "will"]);

export function validSaveType(value) {
  return SAVE_TYPES.has(value) ? value : null;
}

export function numericSaveDc(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function saveRoll(message) {
  let roll = message?.rolls?.[0];
  if (typeof roll === "string") {
    try { roll = JSON.parse(roll); } catch { return null; }
  }
  return roll;
}

export function saveRollTotal(message) {
  return numericSaveDc(saveRoll(message)?.total);
}

export function saveRollDc(message, fallback = null) {
  return numericSaveDc(message?.system?.dc)
    ?? numericSaveDc(saveRoll(message)?.options?.dc)
    ?? numericSaveDc(fallback);
}

export function recordedTargetSaveDc(card, targetRef, type, total, fallback) {
  const messages = globalThis.game?.messages;
  const checks = messages?.contents ?? Array.from(messages?.values?.() ?? []);
  for (let i = checks.length - 1; i >= 0; i -= 1) {
    const check = checks[i];
    if (check?.system?.reference !== card?.uuid || check?.system?.subject?.save !== type) continue;
    const flags = check.flags?.[MODULE.ID];
    if (flags?.metamagic?.persistentSave && flags.saveResolutionComplete !== true) continue;
    const { scene, token } = check.speaker ?? {};
    if (!scene || !token) continue;
    if (targetRef?.tokenUuid ? targetRef.tokenUuid !== `Scene.${scene}.Token.${token}` : targetRef?.tokenId !== token) continue;
    if (saveRollTotal(check) !== total) continue;
    return saveRollDc(check, fallback);
  }

  if (numericSaveDc(targetRef?.saveResults?.[type]) === total) {
    return numericSaveDc(targetRef?.saveResults?.dc) ?? numericSaveDc(fallback);
  }
  return numericSaveDc(fallback);
}

function tokenUuid(target) {
  return typeof target === "string" ? target : target?.document?.uuid ?? target?.uuid;
}

export function attachActionSaveContext(actionUse) {
  const shared = actionUse?.shared;
  const chat = shared?.chatData;
  if (!chat) return;
  const action = actionUse.action ?? shared.action;
  const override = chat.flags?.[MODULE.ID]?.actionOverrides?.save;
  const type = validSaveType(override?.type ?? chat.system?.save?.type ?? shared.save?.type ?? shared.save ?? action?.save?.type);
  const dc = [override?.dc, chat.system?.save?.dc, shared.saveDC, shared.templateData?.save?.dc]
    .map(numericSaveDc).find(value => value != null);
  if (!type || dc == null) return;

  const targets = Array.from(shared.targets ?? []);
  const original = Array.isArray(chat.system?.targets) ? chat.system.targets : targets.map(tokenUuid);

  const saveTargets = original.map(tokenUuid).filter(Boolean);
  chat.flags ??= {};
  chat.flags[MODULE.ID] ??= {};
  chat.flags[MODULE.ID][ACTION_SAVE_CONTEXT] = { version: 2, type, dc, targets: [...new Set(saveTargets)] };
}

export function savedActionSaveTargets(message) {
  const context = message?.flags?.[MODULE.ID]?.[ACTION_SAVE_CONTEXT];
  if (context?.version === 2 && Array.isArray(context.targets)) return context.targets;

  const nativeTargets = message?.system?.targets;
  if (Array.isArray(nativeTargets) && nativeTargets.length) return nativeTargets;
  if (context?.version === 1 && Array.isArray(context.targets)) return context.targets;
  const legacyTargets = message?.flags?.[MODULE.ID]?.targets;
  return Array.isArray(legacyTargets) && legacyTargets.length ? legacyTargets : null;
}

export function actionCardSaveData(message, button) {
  const context = message?.flags?.[MODULE.ID]?.[ACTION_SAVE_CONTEXT];
  const type = validSaveType(button?.dataset?.save ?? button?.dataset?.type ?? message?.system?.save?.type ?? context?.type);
  const dc = [message?.system?.save?.dc, context?.dc, button?.dataset?.dc]
    .map(numericSaveDc).find(value => value != null);
  return type && dc != null ? { type, dc } : null;
}
