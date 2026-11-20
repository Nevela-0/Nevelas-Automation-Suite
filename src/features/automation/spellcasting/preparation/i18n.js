export function localizePreparation(key, fallback = key) {
  const fullKey = `NAS.spellbookPreparation.${key}`;
  const value = game.i18n.localize(fullKey);
  return value && value !== fullKey ? value : fallback;
}

export function spellbookMessageKey(message) {
  let hash = 2166136261;
  for (let i = 0; i < message.length; i += 1) hash = Math.imul(hash ^ message.charCodeAt(i), 16777619);
  return `NAS.spellbookUI.m${(hash >>> 0).toString(16)}`;
}

export function spellbookText(message, values = {}) {
  const key = spellbookMessageKey(message);
  const translated = globalThis.game?.i18n?.localize?.(key);
  return (translated && translated !== key ? translated : message)
    .replace(/\{(\w+)\}/g, (match, name) => `${values[name] ?? match}`);
}
