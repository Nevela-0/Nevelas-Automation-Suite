import { MOVEMENT_MODES } from "./movementSpending.js";
import { manualChoices } from "./manual.js";
import { choiceLabel, costsLabel, counterPools, poolLabel } from "./uiModel.js";
import { activityLabel } from "./movementActivities.js";

const SHORT = { standard: "Std", move: "Mv", swift: "Sw", immediate: "Imm", aoo: "AoO", action: "Acts", reaction: "React", free: "Free", nonaction: "NA" };
const ICONS = { standard: "crosshairs", move: "person-walking", swift: "bolt", immediate: "reply", aoo: "hand-fist", action: "cubes-stacked", reaction: "rotate-left", free: "feather", nonaction: "circle" };

export function buildTrackerRow({ document, combat, combatant, settings, state, movement, movementSpending, generation, panel, manage, status, error, t, onAction }) {
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const root = node("section", "nas-action-tracker");
  root.dataset.combatantUuid = combatant.uuid;
  root.setAttribute("aria-label", t("title", "Action tracker"));
  root.setAttribute("aria-busy", String(!!status?.pending));
  const icon = (name) => {
    const el = node("i", "fa-solid fa-" + name + " nas-at-icon");
    el.setAttribute("aria-hidden", "true");
    return el;
  };
  const button = (action, label, { disabled = false, value = "", glyph } = {}) => {
    const el = node("button", "nas-at-button" + (glyph ? " nas-at-icon-button" : ""));
    el.type = "button";
    Object.assign(el.dataset, { nasAction: action, value, focusKey: action + ":" + value });
    el.disabled = disabled;
    el.title = label;
    el.setAttribute("aria-label", label);
    if (glyph) el.append(icon(glyph), node("span", "nas-at-expand-label", label));
    else el.textContent = label;
    return el;
  };
  root.addEventListener("click", (event) => {
    event.stopPropagation();
    const control = event.target.closest?.("[data-nas-action]");
    if (!control || control.tagName === "SELECT" || !root.contains(control) || control.disabled) return;
    event.preventDefault();
    onAction(control.dataset.nasAction, control.dataset.value);
  });
  root.addEventListener("change", (event) => {
    const field = event.target;
    if (field.dataset.nasAction === "movementMode" && !field.disabled) onAction("movementMode", field.value);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.open) { event.preventDefault(); onAction("close-menu"); }
  });
  for (const name of ["dblclick", "pointerdown", "mousedown", "change", "keydown", "keyup", "contextmenu"]) {
    root.addEventListener(name, (event) => {
      event.stopPropagation();
      if (name === "contextmenu") event.preventDefault();
    });
  }
  const gm = status?.hasGM, locked = !gm || status?.pending || !!status?.failure;
  const spending = combat.round > 0 && !!combat.combatant;
  const ownTurn = spending && combat.combatant === combatant;
  const distance = (n, units = "") => (new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n) + " " + units).trim();
  const warning = (text) => {
    const el = manage ? button("history", text, { glyph: "triangle-exclamation" }) : node("span", "nas-at-warning");
    el.classList.add("nas-at-warning");
    if (!manage) { el.append(icon("triangle-exclamation")); el.title = text; el.setAttribute("aria-label", text); el.setAttribute("role", "img"); }
    return el;
  };
  if (error) {
    root.append(warning(t("readFailed", "Unable to load action tracking: {message}", { message: error.message })));
    return root;
  }

  const strip = node("div", "nas-at-strip");
  strip.append(node("span", "nas-at-caption", t("used", "Used")));
  const pools = counterPools(settings.economy, settings.showFree);
  for (const pool of pools) {
    const amount = state.used[pool] ?? 0, label = t("usedPool", "{pool}: {amount} used", { pool: poolLabel(pool, t), amount });
    const indicator = node("span", "nas-at-counter" + (amount > 0 ? " nas-at-used" : ""));
    indicator.append(icon(ICONS[pool]), node("span", "nas-at-counter-label", t("short." + pool, SHORT[pool]) + " "), node("span", "nas-at-count", String(amount)));
    indicator.title = label; indicator.setAttribute("aria-label", label); indicator.setAttribute("role", "img"); indicator.dataset.pool = pool;
    strip.append(indicator);
  }
  const extras = Object.fromEntries(Object.entries(state.used).filter(([pool, amount]) => !pools.includes(pool) && amount));
  if (Object.keys(extras).length) {
    const extra = node("span", "nas-at-counter nas-at-extra", "+");
    extra.title = costsLabel(extras, t); extra.setAttribute("aria-label", extra.title); strip.append(extra);
  }
  if (Object.keys(state.nextTurnCosts).length) {
    const deferred = node("span", "nas-at-deferred");
    deferred.append(icon("clock"), node("span", "nas-at-counter-label", "Next turn"));
    deferred.title = t("nextTurn", "Next turn: {costs}", { costs: costsLabel(state.nextTurnCosts, t) });
    deferred.setAttribute("aria-label", deferred.title); deferred.setAttribute("role", "img"); strip.append(deferred);
  }
  root.append(strip);

  const toolbar = node("div", "nas-at-toolbar");
  if (settings.movement && movement) {
    const total = movement.groups.length ? movement.groups.map((g) => distance(g.distance, g.units)).join(" + ") : distance(0, combatant.token?.parent?.grid?.units);
    toolbar.append(node("span", "nas-at-movement", t("moved", "Moved: {distance}", { distance: total })));
    if (movement.incomplete) toolbar.append(warning("Incomplete tracking. Review history."));
  }
  if (manage) {
    const controls = node("div", "nas-at-tools");
    const undo = button("undo-last", t("undoLast", "Undo last action"), { glyph: "rotate-left", disabled: locked || !state?.lastOperationId });
    if (locked) undo.title = !gm ? "No GM connected." : status?.failure ? "Resolve the failed change first." : "Saving…";
    const menu = button("expand", t("expand", "Manual actions"), { glyph: "ellipsis" });
    menu.classList.add("nas-at-expand"); menu.setAttribute("aria-expanded", String(!!panel.open));
    controls.append(undo, button("history", t("history", "History"), { glyph: "clock-rotate-left" }), menu);
    toolbar.append(controls);
  }
  if (toolbar.childNodes.length) root.append(toolbar);
  if (!manage) return root;

  if (status?.pending) { const pending = node("span", "nas-at-note", "Saving…"); pending.setAttribute("role", "status"); root.append(pending); }
  if (!gm) root.append(warning("No GM connected. Tracking is read-only."));
  if (status?.failure) {
    const failure = node("div", "nas-at-error nas-at-request-status"); failure.setAttribute("role", "alert");
    const text = node("span", "", "Not saved"); text.title = status.failure.message; text.setAttribute("aria-label", "Not saved: " + status.failure.message);
    failure.append(text, button("retry", t("retry", "Retry same change"), { glyph: "rotate-right", disabled: !gm || status.pending }),
      button("dismiss", t("dismiss", "Dismiss"), { glyph: "xmark", disabled: status.pending }));
    root.append(failure);
  }

  const activity = movementSpending?.activeActivity;
  const unresolved = movementSpending?.activities?.filter((a) => a.id !== activity?.id)
    .flatMap((a) => a.spring?.reservations.filter((r) => r.status === "pending") ?? []) ?? [];
  if (unresolved.length) root.append(warning("Attack unresolved. Review history before retrying."));
  if (activity) {
    const line = node("div", "nas-at-context");
    const progress = activity.spring ? activity.spring.attacks.filter((a) => !a.unlinked).length + "/" + activity.spring.limit + " attacks"
      : activity.status === "armed" ? "Ready" : activity.incomplete ? "Allowance unknown" : distance(activity.consumption ?? 0) + "/" + activity.multiplier + " allowance";
    line.append(node("span", "nas-at-activity-status", activityLabel(activity) + " · " + progress));
    line.append(button("finishActivity", activity.status === "armed" ? "Cancel activity" : "Finish activity", { glyph: activity.status === "armed" ? "xmark" : "check", value: activity.id, disabled: locked }));
    const warnings = [...(activity.warnings ?? []), ...(activity.spring?.reservations.filter((r) => r.status === "pending").map((r) => "Attack " + r.slot + " unresolved. Review history.") ?? [])];
    if (warnings.length) line.append(warning(warnings.join("\n")));
    root.append(line);
  }
  const steps = movementSpending?.steps ?? [];
  if (steps.some((s) => s.effective === "step" && s.status !== "inactive")) {
    const step = node("span", "nas-at-step-status", settings.economy === "unchained" ? "Step · 1 act" : "5-foot step");
    step.title = steps.filter((s) => s.effective === "step" && s.status !== "inactive").flatMap((s) => s.notices ?? []).join("\n") || "Review step eligibility in History.";
    root.append(step);
  }
  if (steps.some((s) => s.requested === "step" && s.status === "converted")) root.append(warning("Step counted as ordinary movement. Review history."));

  if (!panel.open) return root;
  const menu = node("div", "nas-at-panel"); menu.setAttribute("role", "group"); menu.setAttribute("aria-label", t("manual", "Record manual use"));
  menu.title = settings.automatic ? "Record tracking only." : "Automatic PF1 item tracking is off. Manual tracking only.";
  const actions = node("div", "nas-at-actions");
  for (const choice of manualChoices(settings.economy)) {
    const label = choice === "full" ? "Full-round" : choiceLabel(choice, t);
    const control = button("spend", label, { value: choice, disabled: locked || !spending });
    control.title = !spending ? "Start a combat turn first." : t("recordChoice", "Record use: {action}", { action: choiceLabel(choice, t) });
    actions.append(control);
  }
  menu.append(actions);
  if (settings.movement || movementSpending?.sequences?.length) {
    const controls = node("div", "nas-at-movement-controls");
    if (generation < 13 && settings.movement) {
      const label = node("label", "", "Mode"), field = node("select", "nas-at-mode");
      Object.assign(field.dataset, { nasAction: "movementMode", focusKey: "movementMode" }); field.disabled = locked;
      for (const [value, name] of Object.entries(MOVEMENT_MODES)) { const option = node("option", "", name); option.value = value; if (value === (movementSpending?.mode ?? "walk")) option.selected = true; field.append(option); }
      label.append(field); controls.append(label);
    }
    controls.append(button("payMovement", "Pay for movement", { disabled: locked || !ownTurn || !!activity }),
      button("endMovement", "End movement", { disabled: locked || !ownTurn }));
    menu.append(controls);
  }
  root.append(menu);
  return root;
}
