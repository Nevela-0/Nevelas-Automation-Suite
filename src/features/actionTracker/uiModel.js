export function canManage(combatant, user) {
  return !!user && (user.isGM || !!combatant.actor?.testUserPermission?.(user, "OWNER"));
}

export function canSeeCounters(combatant, user, visibility) {
  if (!combatant || combatant.visible === false || (!user?.isGM && combatant.hidden && !canManage(combatant, user))) return false;
  if (canManage(combatant, user)) return true;
  if (visibility === "all") return true;
  return visibility === "party" && !!combatant.actor?.hasPlayerOwner;
}

export function counterPools(economy, showFree) {
  const pools = economy === "unchained" ? ["action", "reaction", "aoo"] : ["standard", "move", "swift", "immediate", "aoo"];
  return showFree ? [...pools, "free", "nonaction"] : pools;
}

export function originLabel(use, t) {
  const labels = { manual: "Manual", pf1: "Automatic PF1", api: "API", movement: "Automatic movement" };
  return Object.hasOwn(labels, use.origin) ? t(`origin.${use.origin}`, labels[use.origin]) : t("origin.unspecified", "Unspecified");
}

export function createTrackerLocalizer(getGame) {
  return (key, fallback, values = {}) => {
    const path = `NAS.actionTracker.${key}`;
    const translated = getGame()?.i18n?.localize?.(path);
    const text = translated && translated !== path ? translated : fallback;
    return text.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
  };
}

const POOL_LABELS = { standard: "Standard", move: "Move", swift: "Swift", immediate: "Immediate", aoo: "AoO", action: "Acts", reaction: "Reaction", free: "Free", nonaction: "Nonaction" };
export const poolLabel = (pool, t) => Object.hasOwn(POOL_LABELS, pool) ? t(`pools.${pool}`, POOL_LABELS[pool]) : pool;
export function choiceLabel(choice, t) {
  if (choice === "full") return t("full", "Full-round / full attack");
  if (["act1", "act2", "act3"].includes(choice)) return t(choice, `${choice.at(-1)} act${choice === "act1" ? "" : "s"}`);
  return poolLabel(choice, t);
}
export function costsLabel(costs, t) {
  const entries = Object.entries(costs);
  return entries.length ? entries.map(([pool, amount]) => `${poolLabel(pool, t)} ${amount}`).join(", ") : t("noCosts", "No costs");
}

export function checkpointLabel(combat, checkpoint, user, t) {
  if (!checkpoint) return t("unknownTurn", "Unknown turn");
  const combatant = Array.from(combat.combatants).find((entry) => entry.uuid === checkpoint.combatantUuid);

  const name = combatant && combatant.visible !== false && (!combatant.hidden || user?.isGM || canManage(combatant, user))
    ? combatant.name : t("otherTurn", "Other turn");
  return t("turnLabel", "Round {round} — {name}", { round: checkpoint.round, name: name ?? t("otherTurn", "Other turn") });
}
