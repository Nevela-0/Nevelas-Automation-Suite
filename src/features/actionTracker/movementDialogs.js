import { elementFromHtmlLike, escapeHtmlForSheet as escape, isFoundryV13Plus, legacyDialogConstructor } from "../../common/foundryCompat.js";
import { activityLabel } from "./movementActivities.js";
import { createTrackerLocalizer } from "./uiModel.js";
import { ensureTrackerStyles } from "./uiStyles.js";

export function movementDialog({ title, content, read = () => true, confirm = "Continue", activate }, game = globalThis.game) {
  const sized = new WeakSet();
  const mount = (html, app) => {
    const root = elementFromHtmlLike(html);
    ensureTrackerStyles(root?.ownerDocument);
    if (!root) return;
    activate?.(root);
    if (sized.has(root)) return;
    sized.add(root);
    const resize = () => { if (root.isConnected) app?.setPosition?.({ height: "auto" }); };
    root.addEventListener("change", resize);
    for (const details of root.querySelectorAll("details")) details.addEventListener("toggle", resize);
  };
  ensureTrackerStyles(globalThis.document);
  if (isFoundryV13Plus(game)) return globalThis.foundry.applications.api.DialogV2.wait({
    window: { title }, position: { width: 420, height: "auto" }, classes: ["nas-at-movement-dialog"],
    content, rejectClose: false, render: (_event, dialog) => mount(dialog.element, dialog),
    buttons: [{ action: "continue", label: confirm, callback: (_event, button) => read(button.form) },
      { action: "cancel", label: "Cancel", default: true, callback: () => null }]
  });
  return new Promise((resolve) => {
    const DialogClass = legacyDialogConstructor();
    if (!DialogClass) throw new Error("The Foundry movement window is not available yet.");
    const dialog = new DialogClass({ title, content, buttons: {
      continue: { label: confirm, callback: (html) => resolve(read(elementFromHtmlLike(html))) },
      cancel: { label: "Cancel", callback: () => resolve(null) }
    }, default: "cancel", close: () => resolve(null), render: (html) => mount(html, dialog) },
    { width: 420, height: "auto", classes: ["dialog", "nas-at-movement-dialog"] });
    dialog.render(true);
  });
}

export function movementChoices(economy) {
  return [["ordinary", "Ordinary / double move"], ["run3", "Run ×3"], ["run4", "Run ×4"], ["run5", "Run ×5"],
    ["charge", "Charge"], ["withdraw", "Withdraw"],
    ...(economy === "normal" ? [["chargeRestricted", "Restricted Charge"], ["withdrawRestricted", "Restricted Withdraw"]] : [])];
}
export function activityChoice(value) {
  if (/^run[345]$/.test(value)) return { activityKind: "run", multiplier: Number(value.at(-1)) };
  if (["charge", "withdraw", "chargeRestricted", "withdrawRestricted"].includes(value)) return {
    activityKind: value.replace("Restricted", ""), restricted: value.endsWith("Restricted") };
  return null;
}

function choiceCopy(choice, preview) {
  const unchained = preview.economy === "unchained";
  const activity = activityChoice(choice);
  const payment = activity?.restricted ? "Standard" : unchained ? (choice === "charge" ? "2 acts" : "3 acts") : "Standard + Move";
  const cost = activity ? payment + " · Up to ×" + (activity.multiplier ?? (activity.restricted ? 1 : 2)) + " speed"
    : unchained ? "1 act per speed allowance" : "Move → Standard → overuse";
  const note = activity?.activityKind === "charge"
    ? unchained ? "Attack costs separately." : "Includes one melee attack. Mark Charge in its attack dialog."
    : activity ? "Payment begins with movement." : "Split drags share the remaining allowance.";
  const warnings = [];
  if (activity && preview.usedEarlier) warnings.push("Earlier movement stays spent; this activity costs separately.");
  if (preview.hampered && ["run", "charge"].includes(activity?.activityKind)) warnings.push("Hampered route: check eligibility.");
  return { cost, note, warning: warnings.join(" ") };
}

export function chooseMovement(preview, game = globalThis.game) {
  const number = (n) => Number.isFinite(n) ? String(Number(n.toFixed(2))) : "?";
  if (preview.contextual && (preview.activity || preview.step)) {
    const a = preview.activity;
    const t = createTrackerLocalizer(() => game);
    const summary = a ? activityLabel(a) + " · " + (a.status === "armed" ? "Ready" : number(a.consumption) + " / " + a.multiplier + " allowance used")
      : t("stepArmed", "Your next move counts as a Step.");
    return movementDialog({ title: "Movement activity", confirm: a?.status === "active" ? "Finish activity" : "Cancel declaration",
      content: '<p>' + escape(summary) + '</p>' + (a?.status === "active" ? "<p>Spent actions stay spent.</p>" : ""),
      read: () => ({ choice: a ? "finishActivity" : "cancelStep", targetId: (a ?? preview.step).id }) }, game);
  }
  const summary = preview.contextual ? "For the next movement"
    : "Move " + number(preview.distance) + " " + preview.units
      + (preview.cost !== preview.distance ? " · Cost " + number(preview.cost) + " " + preview.units : "");
  const options = movementChoices(preview.economy).map(([value, label]) => '<option value="' + value + '">' + escape(label) + '</option>').join("");
  const initial = choiceCopy("ordinary", preview);
  const details = [];
  if (!preview.contextual) details.push("Capacity: " + number(preview.consumed) + " used · " + number(preview.remaining)
    + " remaining · " + number(preview.projected) + " projected.");
  if (preview.speeds?.length) details.push(preview.speeds.map((s) => s.mode + " " + number(s.speed) + " ft").join(" · "));
  const content = '<div class="nas-at-dialog-body"><p class="nas-at-route">' + escape(summary) + '</p>'
    + '<label>Activity<select name="nas-movement-choice">' + options + '</select></label>'
    + '<p class="nas-at-choice-cost">' + escape(initial.cost) + '</p>'
    + '<p class="nas-at-choice-note">' + escape(initial.note) + '</p><p class="nas-at-choice-warning" role="status" hidden></p>'
    + '<details class="nas-at-dialog-details"><summary>Details</summary>'
    + '<label>Terrain / darkness<select name="nas-movement-assessment"><option value="unverified">Unverified</option>'
    + '<option value="clear">Clear — manual override</option><option value="hampered">Hampered</option></select></label>'
    + details.map((text) => "<p>" + escape(text) + "</p>").join("") + '</details></div>';
  const bound = new WeakSet();
  return movementDialog({ title: "Movement activity", content, confirm: preview.contextual ? "Select" : "Continue",
    activate: (root) => {
      const field = root.querySelector('[name="nas-movement-choice"]');
      if (!field || bound.has(field)) return;
      bound.add(field);
      const update = () => {
        const { cost, note, warning } = choiceCopy(field.value, preview);
        root.querySelector(".nas-at-choice-cost").textContent = cost;
        root.querySelector(".nas-at-choice-note").textContent = note;
        const notice = root.querySelector(".nas-at-choice-warning");
        notice.textContent = warning; notice.hidden = !warning;
      };
      field.addEventListener("change", update); update();
    },
    read: (root) => ({ choice: root.querySelector('[name="nas-movement-choice"]').value,
      assessment: root.querySelector('[name="nas-movement-assessment"]').value }) }, game);
}

export function needsBlindCheck(token, game = globalThis.game) {
  const get = (key, fallback) => { try { return game.settings.get("nevelas-automation-suite", key) ?? fallback; } catch { return fallback; } };
  return get("automateConditions", true) && get("blindMovementCheck", false) && !!token.actor?.statuses?.has?.("blind");
}
export async function checkBlindMovement(token, preview, game = globalThis.game, dialog = movementDialog) {
  if (!needsBlindCheck(token, game) || preview.displaced) return true;
  if (preview.incomplete) { globalThis.ui?.notifications?.warn("Blind movement speed could not be verified; resolve its Acrobatics check manually."); return true; }
  if ((preview.blindConsumption ?? 0) + (preview.priorBlindConsumption ?? 0) <= 0.5 + 1e-9) return true;
  const roll = await dialog({ title: "Blind movement check", confirm: "Roll Acrobatics",
    content: `<p>${escape(token.name ?? "This token")} is moving beyond half speed. Roll Acrobatics (DC 10) to continue; failure makes the actor prone.</p>` }, game);
  if (!roll) return false;
  const result = await token.actor.rollSkill("acr", { dc: 10, reason: "blindMovement" });
  if (!result) return false;
  const total = result.rolls?.[0]?.total ?? result.total;
  if (!Number.isFinite(total)) return false;
  if (total >= 10) return true;
  await token.actor.setCondition("prone", true);
  return false;
}
