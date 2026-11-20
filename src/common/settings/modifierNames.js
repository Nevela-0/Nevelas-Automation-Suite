import { MODULE } from "../module.js";

const DEFAULT_MODIFIER_NAMES = Object.freeze({
  lesser: "Lesser",
  minor: "Minor",
  improved: "Improved",
  greater: "Greater",
  major: "Major",
  supreme: "Supreme",
  mass: "Mass",
  communal: "Communal"
});

export function resolveModifierNames(values, i18n = globalThis.game?.i18n) {
  return Object.fromEntries(Object.entries(DEFAULT_MODIFIER_NAMES).map(([name, fallback]) => {
    const key = `NAS.forms.modifierNames.labels.${name}`;
    const saved = typeof values?.[name] === "string" ? values[name].trim() : "";

    if (saved && saved !== key) return [name, saved];
    const localized = i18n?.localize?.(key);
    const resolved = typeof localized === "string" ? localized.trim() : "";
    return [name, resolved && resolved !== key ? resolved : fallback];
  }));
}

export function getModifierNames() {
  return resolveModifierNames(game.settings.get(MODULE.ID, "modifierNames"));
}
