import { MODULE } from "../../../../common/module.js";

export const SPELLBOOK_PREPARATION_MODES = Object.freeze({
  CLASSIC: "classic",
  VARIANTS_ONLY: "variantsOnly",
  FULL: "full"
});

export const SPELLBOOK_ANIMATION_MODES = Object.freeze({
  FULL: "full",
  REDUCED: "reduced",
  OFF: "off"
});

export const SPELLBOOK_PREPARATION_SETTING_KEYS = Object.freeze({
  MODE: "spellbookPreparationMode",
  ALLOW_EXTRA_CAST_TIME_METAMAGIC: "spellbookAllowExtraCastTimeMetamagic",
  REST_RESET: "spellbookRestReset",
  HIDE_SOURCE_SPELLS: "spellbookHideSourceSpells",
  AUTO_OPEN_AFTER_REST: "spellbookAutoOpenAfterRest",
  SHOW_ACTOR_SHEET_PREPARE_CONTROL: "spellbookShowActorSheetPrepareControl",
  SHOW_CAST_DIALOG_PREPARED_PREVIEW: "spellbookShowCastDialogPreparedPreview",
  ANIMATION_MODE: "spellbookAnimationMode"
});

function settingRegistered(key) {
  return globalThis.game?.settings?.settings?.has?.(`${MODULE.ID}.${key}`) === true;
}

function getSetting(key, fallback) {
  if (!settingRegistered(key)) return fallback;
  try {
    return game.settings.get(MODULE.ID, key);
  } catch (_error) {
    return fallback;
  }
}

function isMetamagicAutomationEnabled() {
  return getSetting("enableMetamagicAutomation", true) !== false;
}

export function getSpellbookPersonalSettingScope() {
  const generation = Number(globalThis.game?.release?.generation ?? 12);
  return generation >= 13 ? "user" : "client";
}

export function getSpellbookPreparationMode() {
  const mode = getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.MODE, SPELLBOOK_PREPARATION_MODES.FULL);
  return Object.values(SPELLBOOK_PREPARATION_MODES).includes(mode)
    ? mode
    : SPELLBOOK_PREPARATION_MODES.FULL;
}

export function isSpellbookPreparationFullModeEnabled() {
  return isMetamagicAutomationEnabled()
    && getSpellbookPreparationMode() === SPELLBOOK_PREPARATION_MODES.FULL;
}

export function isSpellbookPreparedVariantSupportEnabled() {
  return isMetamagicAutomationEnabled()
    && getSpellbookPreparationMode() !== SPELLBOOK_PREPARATION_MODES.CLASSIC;
}

export function isSpellbookRestResetEnabled() {
  return isSpellbookPreparationFullModeEnabled()
    && getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.REST_RESET, true) !== false;
}

export function shouldAutoOpenSpellbookPreparationAfterRest() {
  return isSpellbookPreparationFullModeEnabled()
    && getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.AUTO_OPEN_AFTER_REST, true) !== false;
}

export function shouldShowSpellbookPrepareControl() {
  return isSpellbookPreparationFullModeEnabled()
    && getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.SHOW_ACTOR_SHEET_PREPARE_CONTROL, true) !== false;
}

export function shouldHideSpellbookSourceSpells() {
  return isSpellbookPreparationFullModeEnabled()
    && getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.HIDE_SOURCE_SPELLS, true) !== false;
}

export function shouldShowPreparedVariantCastDialogPreview() {
  return isSpellbookPreparedVariantSupportEnabled()
    && getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.SHOW_CAST_DIALOG_PREPARED_PREVIEW, true) !== false;
}

export function shouldAllowExtraCastTimeMetamagicForPreparedVariants() {
  return getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.ALLOW_EXTRA_CAST_TIME_METAMAGIC, true) !== false;
}

export function getSpellbookAnimationMode() {
  const mode = getSetting(SPELLBOOK_PREPARATION_SETTING_KEYS.ANIMATION_MODE, SPELLBOOK_ANIMATION_MODES.FULL);
  return Object.values(SPELLBOOK_ANIMATION_MODES).includes(mode)
    ? mode
    : SPELLBOOK_ANIMATION_MODES.FULL;
}
