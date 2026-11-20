export const SPELL_CONSUMABLE_SOURCE_FLAG = "sourceSpellUuid";

const CONSUMABLE_NAME_KEYS = {
  scroll: "PF1.CreateItemScrollOf",
  potion: "PF1.CreateItemPotionOf",
  wand: "PF1.CreateItemWandOf"
};

export function getConsumableSpellName(item) {
  const name = String(item?.name ?? "").trim();
  if (item?.type !== "consumable") return name;
  const subType = String(item.subType ?? item.system?.subType ?? "").toLowerCase();
  const key = CONSUMABLE_NAME_KEYS[subType];
  if (!key) return name;
  const template = String(game.i18n.localize(key));
  const parts = template.split("{name}");
  if (parts.length !== 2) return name;
  const [prefix, suffix] = parts;
  const lowerName = name.toLowerCase();
  if (!lowerName.startsWith(prefix.toLowerCase()) || !lowerName.endsWith(suffix.toLowerCase())) return name;
  return name.slice(prefix.length, name.length - suffix.length).trim();
}
