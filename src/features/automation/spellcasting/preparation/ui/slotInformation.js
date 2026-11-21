import { spellbookText as t } from "../i18n.js";
const quantity = value => Math.max(0, Math.trunc(Number(value) || 0));

function availabilityFor(fixture, spell) {
  if (!fixture.mode) return null;
  const level = fixture.levels?.find(entry => entry.level === (spell.preparedSlotLevel ?? spell.level));
  if (!level) return { unavailable: true, reason: "missingLevelData" };
  const special = spell.domain && (!spell.regularEligible || level.domainCap > 0);
  const availability = special ? level.domainAvailability : level.normalAvailability;
  if (availability) return availability;
  const cap = special ? level.domainCap : level.normalCap;
  if (cap === null || cap === undefined) return { unknown: true, reason: "unknownCapacity" };
  return Number(cap) > 0 ? { available: true } : { unavailable: true, reason: "zeroCapacity" };
}

export function getPrototypeSlotInformation(fixture, spell, { count = spell.prepared ?? 0, domainCopies } = {}) {
  const hybrid = fixture.mode === "hybrid";
  const preparedLevel = spell.preparedSlotLevel ?? spell.level;
  const originalLevel = spell.originalSpellLevel ?? spell.originalLevel ?? preparedLevel;
  const rawCost = Number(spell.slotCost ?? 1);
  const cost = Number.isFinite(rawCost) ? Math.max(0, rawCost) : 1;
  const copies = quantity(count);
  const units = hybrid ? t("preparation choices") : `${spell.domain ? t("domain ") : ""}${t("slots")}`;
  const used = copies * cost;
  const domainOnly = spell.domain && (!spell.regularEligible || domainCopies === copies);
  const usedUnits = hybrid ? (used === 1 ? t("preparation choice") : t("preparation choices"))
    : `${domainOnly ? t("domain ") : ""}${used === 1 ? t("slot") : t("slots")}`;
  const levelSummary = originalLevel !== preparedLevel ? t("Base {base} → Slot {slot}", {base: originalLevel, slot: preparedLevel}) : "";
  const costSummary = !spell.atWill && cost !== 1 ? t("{cost} {units} each", {cost, units: hybrid ? t("choices") : t("slots")}) : "";
  const school = `${spell.school ?? ""}`.replace(/^./u, first => first.toLocaleUpperCase());
  const summary = [school, spell.domain ? t("Domain") : "", spell.missing ? t("Original spell missing") : "",
    levelSummary, costSummary, !levelSummary ? spell.metamagic : ""].filter(Boolean).join(" · ");
  const levelLabel = `${spell.atWill ? t("Spell level") : hybrid ? t("Prepared level") : t("Prepared slot")} ${preparedLevel}`;
  const detail = [summary, t("{level}; original spell level {original}.", {level: levelLabel, original: originalLevel}),
    spell.atWill ? t("At will; does not use preparation capacity.")
      : spell.regularEligible && domainCopies > 0 && domainCopies < copies
        ? t("Domain slots: {domain}. Regular slots: {regular}.", {domain: domainCopies * cost, regular: (copies - domainCopies) * cost})
        : t("{copies} prepared {copyVerb} {used} {units}.", {copies, copyVerb: copies === 1 ? t("copy uses") : t("copies use"), used, units: usedUnits})].filter(Boolean).join(" ");
  const availability = !spell.missing && !spell.atWill ? availabilityFor(fixture, spell) : null;
  const unavailable = availability?.unavailable === true || availability?.state === "unavailable";
  const unknown = !unavailable && (availability?.unknown === true || availability?.state === "unknown");
  let warning = "", warningDetail = "";
  if (unavailable) {
    if (availability.reason === "lowAbilityScore") {
      warning = t("Casting ability too low");
      warningDetail = t("This spellbook's current casting ability does not allow preparation at level {level}.", {level: preparedLevel});
    } else {
      warning = spell.domain ? t("No domain capacity") : t("Level unavailable");
      warningDetail = availability.reason === "missingLevelData"
        ? t("This spellbook has no preparation data for level {level}.", {level: preparedLevel})
        : t("This spellbook has no level {level} {units} available for preparation.", {level: preparedLevel, units});
    }
    warningDetail += t(" Reduce or remove this preparation, or edit its metamagic to use an available level.");
  } else if (unknown) {
    warning = hybrid ? t("Preparation limit unknown") : t("Slot limit unknown");
    warningDetail = t("The maximum level {level} {units} could not be determined. The counter shows ?; preparation remains editable.", {level: preparedLevel, units});
  }
  return { slotCost: cost, preparedLevelLabel: levelLabel, slotSummary: summary, slotDetail: detail,
    slotUnavailable: unavailable, slotWarning: warning, slotWarningDetail: warningDetail,
    slotWarningState: unavailable ? "unavailable" : unknown ? "unknown" : "" };
}

export function getPrototypeSlotCounterLabels(fixture) {
  return fixture.mode === "hybrid"
    ? { slotCounterLabel: t("Prepared choices"), domainCounterLabel: t("Domain choices") }
    : { slotCounterLabel: t("Slots"), domainCounterLabel: t("Domain slots") };
}
