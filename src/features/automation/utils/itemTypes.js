const FEATURE_LIKE_ITEM_SUBTYPES = new Set(["feat", "classFeat", "trait", "racial", "misc"]);

function hasPositiveQuantity(item) {
  const raw = item?.system?.quantity;
  if (raw == null || raw === "") return true;
  const quantity = Number(raw);
  return Number.isFinite(quantity) && quantity > 0;
}

export function getPf1ItemSubType(item) {
  return String(item?.subType ?? item?.system?.subType ?? "").trim();
}

export function isNasFeatureLikeItem(item) {
  return item?.type === "feat" && FEATURE_LIKE_ITEM_SUBTYPES.has(getPf1ItemSubType(item));
}

export function isNasFeatureLikeItemActive(item) {
  return isNasFeatureLikeItem(item) && Boolean(item.actor) && item.system?.disabled !== true;
}

export function isNasImplantItem(item) {
  return item?.type === "implant";
}

export function isNasImplantItemActive(item) {
  return isNasImplantItem(item)
    && Boolean(item.actor)
    && item.system?.implanted === true
    && item.system?.disabled !== true
    && hasPositiveQuantity(item)
    && item.isBroken !== true;
}

export function isNasReactiveAutomationItem(item) {
  return Boolean(item && (
    item.type === "buff"
    || item.type === "equipment"
    || isNasFeatureLikeItem(item)
    || isNasImplantItem(item)
  ));
}
