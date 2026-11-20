export const METAMAGIC_DEFINITION = {
  key: "widenSpell",
  name: "Widen Spell",
  get prefix() { return globalThis.game?.i18n?.localize?.("NAS.metamagic.prefixes.widenSpell") ?? "Widened"; },
};

export function canApplyWidenSpell(context) {
  const area = context?.area?.areaString ?? context?.area;
  const template = context?.measureTemplate;
  const type = String(template?.type ?? "").toLowerCase();
  const size = String(template?.size ?? "").trim();
  if (typeof template?.size === "number" && !Number.isFinite(template.size)) return false;
  if (/^[+-]?(Infinity|NaN)$/i.test(size)) return false;
  if (typeof area !== "string" || !size || (Number.isFinite(Number(size)) && Number(size) <= 0)) return false;

  if (type === "ray") return /\bline\b/i.test(area);
  return ["circle", "cone"].includes(type) && /\b(burst|emanation|spread)\b/i.test(area);
}

export function applyWidenSpell(context, action = null) {
  if (context?.metamagic?.applied?.includes(METAMAGIC_DEFINITION.name)) return true;
  if (!canApplyWidenSpell(context)) return false;

  let size = `2 * (${context.measureTemplate.size})`;
  if (String(context.measureTemplate.type).toLowerCase() === "ray") {
    const range = context.range?.range ?? {};
    let maximum;
    try {
      maximum = globalThis.pf1?.utils?.calculateRangeFormula?.(
        range.value ?? "", range.units, action?.shared?.rollData ?? context.rollData ?? {}
      );
    } catch (_error) { return false; }
    if (!Number.isFinite(maximum) || maximum <= 0) return false;

    size = `min(${size}, ${maximum})`;
  }
  context.measureTemplateOverrides = { ...context.measureTemplateOverrides, size };
  context.metamagic ??= { applied: [], slotIncrease: 0 };
  context.metamagic.applied.push(METAMAGIC_DEFINITION.name);
  context.metamagic.slotIncrease = Number(context.metamagic.slotIncrease ?? 0) + 3;
  return true;
}

export function updateWidenSpellChatArea(actionUse, context) {
  const shared = actionUse.shared;
  const card = shared.templateData;
  const metadata = shared.chatData?.system?.item;
  const description = card?.identified === false ? metadata?.description : card?.description;
  if (!context.metamagic?.applied?.includes(METAMAGIC_DEFINITION.name) || !description) return;

  const placed = shared.template;
  const type = placed?.t ?? context.measureTemplate?.type;
  let distance = placed?.distance;
  let unit = placed?.parent?.grid?.units;
  if (!Number.isFinite(distance)) {
    const formula = context.measureTemplateOverrides?.size;
    if (!formula) return;
    const feet = pf1.dice.RollPF.safeRollSync(formula, shared.rollData).total;
    if (!Number.isFinite(feet)) return;
    [distance, unit] = pf1.utils.convertDistance(feet);
  }
  if (!(distance > 0)) return;
  unit ||= pf1.utils.convertDistance(0)[1];

  const root = document.createElement("div");
  root.innerHTML = description;
  const header = root.querySelector(".spell-description");
  if (!header) return;
  const areaLabel = game.i18n.localize("PF1.Area");
  let label = Array.from(header.querySelectorAll("strong")).find(el => el.textContent.trim() === areaLabel);
  if (!label) {
    label = document.createElement("strong");
    label.textContent = areaLabel;
    const row = document.createElement("p");
    row.append(label, document.createElement("br"));
    header.append(row);
  }

  const measurement = game.i18n.format("PF1.RangeFormat", { distance, units: unit });
  const area = context.area?.areaString ?? "";
  const fixedSize = /^\s*\d+(?:[.,]\d+)?[\s-]*(?:ft\.?|feet|foot|meters?|metres?|m)\b\.?[\s-]+(?=radius|burst|emanation|spread|cone|(?:long[\s-]+)?line)/i;
  const display = fixedSize.test(area)
    ? area.replace(fixedSize, () => measurement + " ")
    : game.i18n.format("NAS.metamagic.widenArea." + type, { measurement });
  while (label.nextSibling && label.nextSibling.nodeName !== "BR") label.nextSibling.remove();
  label.after(document.createTextNode("\u00a0" + display));
  if (card.identified === false) metadata.description = root.innerHTML;
  else card.description = root.innerHTML;
}
