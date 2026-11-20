import { eligiblePayment, MOVEMENT_MODES } from "./movementSpending.js";
import { checkpointLabel, costsLabel, originLabel } from "./uiModel.js";
import { activityLabel } from "./movementActivities.js";
import { springNextSlot } from "./springAttack.js";

export const formatDistance = (value, units = "") =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${units}`.trim();

export function buildHistoryView({ document, game, selection, combats, combat, combatants, histories = [],
  log, movement, error, requests, t, onFilter, onAction, expanded = new Set() }) {
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const root = node("section", "nas-action-tracker nas-at-history-window");
  root.setAttribute("aria-label", t("historyTitle", "Action and movement history"));
  const button = (action, label, { uuid = "", value = "", disabled = false } = {}) => {
    const el = node("button", "nas-at-button", label);
    el.type = "button";
    Object.assign(el.dataset, { nasAction: action, value, combatantUuid: uuid, focusKey: JSON.stringify([action, uuid, value]) });
    el.disabled = disabled;
    return el;
  };
  root.addEventListener("click", (event) => {
    const control = event.target.closest?.("[data-nas-action]");
    event.stopPropagation();
    if (!control || !root.contains(control) || control.disabled) return;
    event.preventDefault();
    let value = control.dataset.value;
    if (control.dataset.nasAction === "link-payment") {
      const sequenceId = control.closest(".nas-at-history-entry").querySelector(".nas-at-payment-sequence")?.value;
      if (!sequenceId) return;
      value = JSON.stringify([value, sequenceId]);
    }
    if (control.dataset.nasAction === "link-activity-attack") {
      const attackId = control.closest(".nas-at-history-entry").querySelector(".nas-at-activity-attack")?.value;
      if (!attackId) return;
      value = JSON.stringify([value, attackId]);
    }
    if (["classify-step", "classify-ordinary"].includes(control.dataset.nasAction)) {
      value = JSON.stringify([value, control.closest(".nas-at-history-entry").querySelector(".nas-at-step-assessment")?.value ?? "unverified"]);
    }
    onAction(control.dataset.nasAction, control.dataset.combatantUuid, value);
  });
  root.addEventListener("change", (event) => {
    event.stopPropagation();
    const field = event.target;
    if (field.dataset.nasFilter) onFilter(field.dataset.nasFilter, field.value);
  });
  const filters = node("div", "nas-at-history-filters");
  const option = (value, label) => {
    const el = node("option", "", label);
    el.value = value;
    return el;
  };
  const select = (key, label, choices, value) => {
    const field = node("select");
    field.dataset.nasFilter = key;
    field.dataset.focusKey = key;
    field.append(...choices);
    const selected = Array.from(field.querySelectorAll("option")).find((entry) => entry.value === value);
    if (selected) selected.selected = true;
    const wrapper = node("label", "nas-at-history-filter");
    wrapper.append(node("span", "", label), field);
    filters.append(wrapper);
    return field;
  };
  const unavailable = t("selectionUnavailable", "Selection unavailable");
  const encounterChoices = combats.map((entry) => option(entry.uuid, entry.name || t("encounter", "Encounter") + ` (${entry.id})`));
  if (!combats.some((entry) => entry.uuid === selection.combatUuid)) encounterChoices.unshift(option(selection.combatUuid, unavailable));
  select("combatUuid", t("encounter", "Encounter"), encounterChoices, selection.combatUuid);
  const combatantChoices = [option("*", t("allPermitted", "All permitted combatants")),
    ...combatants.map((entry) => option(entry.uuid, entry.name || t("unnamedCombatant", "Unnamed combatant")))];
  if (selection.combatantUuid !== "*" && !combatants.some((entry) => entry.uuid === selection.combatantUuid)) {
    combatantChoices.push(option(selection.combatantUuid, unavailable));
  }
  select("combatantUuid", t("combatant", "Combatant"), combatantChoices, selection.combatantUuid);
  select("type", t("entryType", "Entry type"), [
    option("all", t("allTypes", "All")), option("action", t("actions", "Actions")), option("movement", t("movementEntry", "Movement"))
  ], selection.type);
  const turnChoices = [option("all", t("allTurns", "All turns")), option("current", t("currentTurn", "Current viewed turn"))];
  const rounds = new Map();
  for (const checkpoint of log?.timeline.checkpoints ?? []) {
    if (!rounds.has(checkpoint.round)) {
      const group = node("optgroup");
      group.label = t("round", "Round {round}", { round: checkpoint.round });
      rounds.set(checkpoint.round, group);
      turnChoices.push(group);
    }
    rounds.get(checkpoint.round).append(option(checkpoint.id, checkpointLabel(combat, checkpoint, game.user, t)));
  }
  if (!["all", "current"].includes(selection.turn) && !log?.timeline.checkpoints.some((entry) => entry.id === selection.turn)) {
    turnChoices.push(option(selection.turn, unavailable));
  }
  select("turn", t("turn", "Turn"), turnChoices, selection.turn);
  root.append(filters);
  const scroll = node("div", "nas-at-history-scroll");
  scroll.tabIndex = 0;
  scroll.dataset.focusKey = "log";
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", t("historyTitle", "Action and movement history"));
  root.append(scroll);
  if (error) scroll.append(node("p", "nas-at-error", error));
  const help = node("span", "nas-at-history-help", "Tracking history");
  help.title = "Corrections affect tracking only. Movement, rolls and game effects stay unchanged.";
  root.setAttribute("aria-description", help.title);
  for (const data of histories) {
    const status = requests.status(data.combatant.uuid);
    if (data.error) scroll.append(node("p", "nas-at-error", `${data.combatant.name ?? ""}: ${data.error.message}`));
    if (!status.hasGM && data === histories[0]) scroll.append(node("p", "nas-at-note", "No GM connected · Read-only"));
    if (status.pending || status.failure) {
      const box = node("div", status.failure ? "nas-at-error" : "nas-at-note");
      box.setAttribute("role", status.failure ? "alert" : "status");
      box.append(node("strong", "", data.combatant.name ?? ""), node("p", "", status.failure?.message ?? t("saving", "Saving action tracking…")));
      if (status.failure) {
        box.append(button("retry", t("retry", "Retry same change"), { uuid: data.combatant.uuid, disabled: !status.hasGM || status.pending }),
          button("dismiss", t("dismiss", "Dismiss"), { uuid: data.combatant.uuid, disabled: status.pending }));
      }
      scroll.append(box);
    }
  }
  if (movement) {
    const summary = node("details", "nas-at-movement-summary");
    summary.dataset.disclosureKey = JSON.stringify([selection.combatantUuid, "movement-summary"]);
    if (expanded.has(summary.dataset.disclosureKey)) summary.setAttribute("open", "");
    const checkpoint = log?.timeline.checkpoints.find((entry) => entry.id === movement.checkpointId);
    const heading = node("summary", "", ["all", "current"].includes(selection.turn) ? "Movement · Current turn" : "Movement · Selected turn");
    heading.dataset.focusKey = summary.dataset.disclosureKey;
    if (movement.incomplete) heading.append(node("span", "nas-at-warning", " · Incomplete"));
    summary.append(heading);
    summary.append(node("div", "nas-at-turn", checkpointLabel(combat, checkpoint, game.user, t)));
    summary.append(node("div", "nas-at-movement", t("moved", "Moved: {distance}", {
      distance: movement.groups.length ? movement.groups.map((group) => formatDistance(group.distance, group.units)).join(" + ") : "0"
    })));
    summary.append(node("div", "nas-at-direct", movement.direct
      ? t("directDistance", "Distance from starting point: {distance}", { distance: formatDistance(movement.direct.distance, movement.direct.units) })
      : "Distance from starting point unavailable."));
    const spending = histories.find((data) => data.combatant.uuid === selection.combatantUuid)?.spending;
    if (spending) {
      const current = spending.current;
      summary.append(node("div", "nas-at-allowance", `Capacity: ${formatDistance(current?.consumption ?? 0)} used · ${formatDistance(current?.remaining ?? 0)} remaining`));
      const live = ["all", "current"].includes(selection.turn), speed = live ? spending.prepared : current;
      if (speed) summary.append(node("div", "nas-at-speed", `${live ? "Current" : "Recorded"} speed: ${MOVEMENT_MODES[speed.mode] ?? speed.mode} ${speed.speed ?? "?"} ft`));
      for (const terrain of spending.terrain ?? []) summary.append(node("div", "nas-at-terrain", t("terrainDistanceCost", "Traveled {distance} · Movement cost {cost}", {
        distance: formatDistance(terrain.distance, terrain.units), cost: terrain.incomplete ? t("terrainCostIncomplete", "Incomplete") : formatDistance(terrain.cost, terrain.units)
      })));
    }
    if (movement.incomplete) summary.append(node("p", "nas-at-note", t("movementIncomplete", "Incomplete tracking")));
    scroll.append(summary);
  }
  const list = node("ol", "nas-at-history");
  const finishEntry = (entry, { key, label, combatant, type, use, checkpoint, later }) => {
    const details = node("details", "nas-at-entry-details");
    details.dataset.disclosureKey = key;
    if (expanded.has(key)) details.setAttribute("open", "");
    const summary = node("summary", "nas-at-entry-summary");
    summary.dataset.focusKey = "details:" + key;
    const heading = node("span", "nas-at-entry-heading");
    const amount = use.kind === "activity" ? (use.actionId ? "Paid" : "No payment")
      : type === "action" ? costsLabel(use.costs, t) : formatDistance(use.distance, use.config.units);
    heading.append(node("strong", "nas-at-use-label", label), node("span", "nas-at-entry-cost", amount));
    const context = [combatant.name ?? t("unnamedCombatant", "Unnamed combatant"), checkpointLabel(combat, checkpoint, game.user, t)];
    if (type === "action") context.push(originLabel(use, t));
    const meta = node("span", "nas-at-entry-meta", context.join(" · ")); meta.title = context.join(" · ");
    summary.append(heading, meta);
    const badges = [use.undone && "Undone", use.excluded && "Excluded", use.reversed && "Reversed", later && "Later turn",
      use.kind === "activity" && use.status, use.step?.effective === "step" && "Step",
      (use.incomplete || use.terrain?.warning || (use.spending?.enabled && use.spending.warning) || use.warnings?.length
        || (use.step?.requested === "step" && use.step.reasons?.length)) && "Review"];
    if (type === "action" && Object.keys(use.nextTurnCosts).length) badges.push(t("nextTurn", "Next turn: {costs}", { costs: costsLabel(use.nextTurnCosts, t) }));
    if (badges.some(Boolean)) summary.append(node("span", "nas-at-entry-badges", badges.filter(Boolean).join(" · ")));
    const body = node("div", "nas-at-entry-body");
    for (const duplicate of entry.querySelectorAll(":scope > .nas-at-use-label, :scope > .nas-at-combatant, :scope > .nas-at-turn, :scope > .nas-at-costs, :scope > .nas-at-entry-type")) duplicate.remove();
    body.append(...Array.from(entry.childNodes));
    details.append(summary, body); entry.append(details); list.append(entry);
  };
  for (const { combatant, type, use, checkpoint, later, key } of log?.entries ?? []) {
    const status = requests.status(combatant.uuid);
    const locked = !status.hasGM || status.pending || !!status.failure;
    const entry = node("li", `nas-at-history-entry${use.undone ? " nas-at-undone" : ""}`);
    entry.dataset.entryKey = key;
    entry.dataset.focusKey = key;
    entry.tabIndex = -1;
    entry.dataset.combatantUuid = combatant.uuid;
    entry.dataset[type === "action" ? "operationId" : "movementId"] = use.operationId;
    const label = use.kind === "activity" ? activityLabel({ ...use, kind: use.activityKind }) : type === "action" ? use.label
      : use.kind === "undo" ? t("nativeUndo", "Foundry movement undo") : t("movementEntry", "Movement");
    entry.append(node("strong", "nas-at-use-label", label),
      node("div", "nas-at-combatant", combatant.name ?? t("unnamedCombatant", "Unnamed combatant")),
      node("div", "nas-at-turn", checkpointLabel(combat, checkpoint, game.user, t)),
      node("div", "nas-at-origin", t("originLabel", "Origin: {origin}", {
        origin: type === "action" ? originLabel(use, t) : use.kind === "activity" ? t("manualActivity", "Manual activity declaration") : use.kind === "undo" ? t("nativeUndo", "Foundry movement undo") : t("recordedMovement", "Recorded movement")
      })),
      node("div", "nas-at-submitter", t("submittedBy", "Submitted by: {user}", {
        user: game.users?.get(use.userId)?.name ?? use.userId ?? t("unknownUser", "Unknown user")
      })));
    const spending = histories.find((h) => h.combatant.uuid === combatant.uuid)?.spending;
    if (use.kind === "activity") {
      entry.append(node("div", "nas-at-activity-status", `${use.status} — ×${use.multiplier}; ${formatDistance(use.consumption ?? 0)} consumed; ${use.incomplete ? "unknown" : formatDistance(use.remaining ?? 0)} remaining.`));
      entry.append(node("p", "nas-at-note", `${use.recordIds.length} linked movement portions. ${use.refunded ? "Payment undone; recorded movement waived." : use.actionId ? "Fixed activity payment recorded." : "No action payment."}`));
      if (use.endedReason) entry.append(node("p", "nas-at-note", `Ended: ${use.endedReason}`));
      if (use.endNotice) entry.append(node("p", "nas-at-note", use.endNotice));
      const attack = spending?.activityUses?.find((r) => r.operationId === use.attackId);
      if (attack) entry.append(node("p", "nas-at-activity-attack-label", `Included attack: ${attack.use.label}${use.attackWaived ? " (waived)" : ""}`));
      if (use.spring) {
        entry.append(node("p", "nas-at-note", `Feat eligibility: ${use.spring.override ? "manual override" : "recognized owned feat"}. ${use.spring.mythic ? "Mythic enhancement enabled." : ""}`));
        if (use.spring.mythicPower) {
          const user = game.users?.get(use.spring.mythicPower.userId)?.name ?? "unknown user";
          entry.append(node("p", "nas-at-note", `Mythic power: 1 use declared by ${user} (manual spend).`));
        }
        for (const linked of use.spring.attacks) {
          const receipt = spending?.activityUses?.find((r) => r.operationId === linked.operationId);
          entry.append(node("p", "nas-at-activity-attack-label", `Attack ${linked.slot}: ${receipt?.use.label ?? "Recorded attack"}; expected ${linked.expectedPenalty}, applied ${linked.appliedPenalty ?? "unverified"}${linked.unlinked ? "; association removed" : linked.waived ? "; waived" : ""}.`));

          entry.append(node("p", "nas-at-note", `Recorded targets: ${linked.targets.length}; starting adjacency ${linked.adjacent === true ? "known conflict" : linked.adjacent === false ? "clear" : "unverified"}.`));
          if (!linked.unlinked && use.status !== "converted") entry.append(button("unlink-activity-attack", "Remove attack association", { uuid: combatant.uuid, value: JSON.stringify([use.id, linked.operationId]), disabled: locked }));
        }
        for (const r of use.spring.reservations.filter((r) => r.status === "pending")) {
          entry.append(node("p", "nas-at-note", `Attack ${r.slot} is unresolved. Release only after checking whether the PF1 use completed; completed rolls are not undone.`));
          entry.append(button("release-spring-attack", "Release unresolved reservation", { uuid: combatant.uuid, value: JSON.stringify([use.id, r.attackId]), disabled: locked }));
        }
      }
      for (const warning of use.warnings ?? []) entry.append(node("p", "nas-at-note", warning));
      if (use.status !== "converted" && (use.recordIds.length || use.attackId || use.spring?.attacks.length)) entry.append(button("convert-activity", t("convertActivity", "Count as normal movement"), { uuid: combatant.uuid, value: use.id, disabled: locked }));
      const recordedActions = histories.find((h) => h.combatant.uuid === combatant.uuid)?.actions ?? [];
      const candidates = spending?.activityUses?.filter((r) => {
        const action = recordedActions.find((a) => a.operationId === r.actionId);
        return r.eligible && !r.linkedActivityId && !r.override && r.checkpointId === use.checkpointId
          && (!use.spring || (!r.optOut && r.activityId === use.id && r.spring && !use.spring.attacks.some((a) => a.slot === r.spring.slot)))
          && !action?.undone && !action?.movement && !action?.activity;
      }) ?? [];
      if (((use.activityKind === "charge" && use.economy === "normal" && !use.attackId) || (use.spring && springNextSlot(use))) && !use.refunded && use.status !== "converted" && candidates.length) {
        const label = node("label", "", t("activityAttack", "Completed melee attack")), field = node("select", "nas-at-activity-attack");
        field.dataset.focusKey = JSON.stringify(["activity-attack", combatant.uuid, use.id]); field.disabled = locked;
        for (const candidate of candidates) field.append(option(candidate.operationId, candidate.use.label));
        field.firstElementChild.selected = true;
        label.append(field); entry.append(label, button("link-activity-attack", use.spring ? "Include missed Spring Attack" : t("linkActivityAttack", "Include missed Charge attack"), { uuid: combatant.uuid, value: use.id, disabled: locked }));
      }
      if (later) entry.append(node("div", "nas-at-later", t("later", "Later than the viewed turn")));
      finishEntry(entry, { key, label, combatant, type, use, checkpoint, later }); continue;
    }
    if (type === "action") {
      entry.append(node("div", "nas-at-entry-type", t("actionEntry", "Action")),
        node("div", "nas-at-costs", costsLabel(use.costs, t)));
      const completed = spending?.activityUses?.find((r) => r.operationId === use.completedActivityUse);
      if (completed?.spring) entry.append(node("p", "nas-at-note", `Spring Attack modifier: ${completed.spring.appliedPenalty ?? "unverified"}.`));
      if (Object.keys(use.nextTurnCosts).length) entry.append(node("div", "nas-at-deferred",
        t("nextTurn", "Next turn: {costs}", { costs: costsLabel(use.nextTurnCosts, t) })));
      if (use.movement) {
        const statusText = { linked: "Pays for movement", refunded: "Automatically refunded", waived: "Undone — recorded movement waived", unlinked: "Movement payment link removed" }[use.movement.status] ?? use.movement.status;
        entry.append(node("div", "nas-at-payment-status", statusText));
        const sequenceIndex = spending?.sequences?.findIndex((seq) => seq.id === use.movement.sequenceId) ?? -1;
        if (sequenceIndex >= 0) entry.append(node("div", "nas-at-sequence", t("movementSequenceNumber", "Movement sequence {number}", { number: sequenceIndex + 1 })));
      }
      if (use.step) entry.append(node("div", "nas-at-payment-status", `Step action — ${use.step.status}`));
      if (use.activity) entry.append(node("div", "nas-at-payment-status", `Activity payment — ${use.activity.status}`));
      if (!use.undone && use.movement?.payment === "manual" && use.movement.status === "linked") {
        entry.append(button("unlink-payment", t("unlinkPayment", "Stop counting this action toward movement"), { uuid: combatant.uuid, value: use.operationId, disabled: locked }));
      } else if (!use.undone && use.origin !== "movement" && use.movement?.status !== "linked") {
        const sequences = spending?.sequences?.filter((seq) => seq.checkpointId === use.checkpointId && eligiblePayment(use, seq.economy)) ?? [];
        if (sequences.length) {
          const label = node("label", "nas-at-payment-choice", t("paymentSequence", "Movement sequence"));
          const field = node("select", "nas-at-payment-sequence");
          field.dataset.focusKey = JSON.stringify(["payment-sequence", combatant.uuid, use.operationId]);
          field.disabled = locked;
          for (const sequence of sequences) field.append(option(sequence.id, t("sequenceChoice", "Sequence {number} — {consumption} movement actions", {
            number: spending.sequences.indexOf(sequence) + 1, consumption: formatDistance(sequence.consumption ?? 0)
          })));
          if (field.firstElementChild) field.firstElementChild.selected = true;
          label.append(field); entry.append(label, button("link-payment", t("linkPayment", "Count this action toward movement"), { uuid: combatant.uuid, value: use.operationId, disabled: locked }));
        }
      }
      if (use.undone) entry.append(node("span", "nas-at-undo-status", t("undone", "Undone")));
      else entry.append(button("undo", t("undoAction", "Undo action"), { uuid: combatant.uuid, value: use.operationId, disabled: locked }));
    } else {
      entry.append(node("div", "nas-at-distance", formatDistance(use.distance, use.config.units)));
      if (use.terrain) {
        entry.append(node("div", "nas-at-terrain", t("terrainDistanceCost", "Traveled {distance} · Movement cost {cost}", {
          distance: formatDistance(use.distance, use.config.units), cost: Number.isFinite(use.terrain.cost) ? formatDistance(use.terrain.cost, use.config.units) : t("terrainCostIncomplete", "Incomplete")
        })));
        if (Number.isFinite(use.terrain.multiplier)) entry.append(node("div", "nas-at-note", t("terrainMultipliers", "Terrain multipliers: {multipliers}", { multipliers: `×${formatDistance(use.terrain.multiplier)}` })));
        if (use.terrain.warning) entry.append(node("p", "nas-at-note", use.terrain.warning));
        if (use.step?.terrainOverride) entry.append(node("div", "nas-at-terrain-override", t("terrainOverrideBy", "Region step restriction overridden by: {user}", {
          user: game.users?.get(use.step.assessedBy)?.name ?? use.step.assessedBy ?? t("unknownUser", "Unknown user")
        })));
      }
      if (use.activity) entry.append(node("div", "nas-at-activity-status", `${use.activity.label} — ${use.activity.status}${use.activity.waived ? "; movement waived" : ""}`));
      if (use.step && (!use.activity || use.activity.status === "converted")) {
        entry.append(node("div", "nas-at-step-status", `Requested: ${use.step.requested}; recorded: ${use.step.effective} (${use.step.status}).`));
        if (use.step.candidateGroups > 1) entry.append(node("p", "nas-at-note", `Combined step candidate: ${formatDistance(use.step.candidateFeet)} ft across ${use.step.candidateGroups} committed movements.`));
        for (const text of [...use.step.reasons, ...use.step.notices]) entry.append(node("p", "nas-at-note", text));
        const label = node("label", "nas-at-step-environment", t("stepEnvironment", "Step path: terrain / darkness"));
        const field = node("select", "nas-at-step-assessment");
        field.dataset.focusKey = JSON.stringify(["step-assessment", combatant.uuid, use.operationId]); field.disabled = locked;
        for (const [value, text] of [["unverified", "Unverified"], ["clear", "Clear"], ["hampered", "Hampered"]]) {
          const choice = option(value, t(`stepAssessment.${value}`, text)); if (value === use.step.assessment) choice.setAttribute("selected", ""); field.append(choice);
        }
        label.append(field); entry.append(label);
        entry.append(button("classify-step", t("classifyStep", "Record group as Step"), { uuid: combatant.uuid, value: use.operationId, disabled: locked }),
          button("classify-ordinary", t("classifyOrdinary", "Record group as Ordinary"), { uuid: combatant.uuid, value: use.operationId, disabled: locked }));
      }
      if (use.spending) {
        const saved = use.spending;
        entry.append(node("div", "nas-at-saved-speed", t("savedSpeed", "{mode}; speed {speed} ft; {consumption} movement actions", {
          mode: MOVEMENT_MODES[saved.mode] ?? saved.mode, speed: saved.speed ?? "?", consumption: formatDistance(saved.consumption)
        })));
        if (saved.warning && saved.enabled) entry.append(node("div", "nas-at-note", saved.warning));
        const sequence = spending?.sequences?.find((seq) => seq.id === saved.sequenceId);
        if (sequence) entry.append(node("div", "nas-at-sequence", t("movementSequenceNumber", "Movement sequence {number}", { number: spending.sequences.indexOf(sequence) + 1 })));
        if (sequence?.waivers.some((w) => w.coverage.some((c) => c.movementId === use.operationId))) entry.append(node("div", "nas-at-payment-status", t("movementWaived", "Recorded movement has waived action coverage")));
      }
      if (use.reversed) entry.append(node("div", "nas-at-undo-status", t("movementReversed", "Reversed by Foundry undo")));
      if (use.excluded && use.kind === "move") entry.append(node("div", "nas-at-undo-status", use.exclusionReason === "teleport"
        ? t("movementTeleport", "Teleport / displacement — excluded") : t("movementExcluded", "Excluded")));
      if (use.kind === "move" && !use.excluded && !use.reversed) entry.append(button("exclude-movement", t("excludeMovement", "Exclude movement"), {
        uuid: combatant.uuid, value: use.operationId, disabled: locked
      }));
    }
    if (later) entry.append(node("div", "nas-at-later", t("later", "Later than the viewed turn")));
    finishEntry(entry, { key, label, combatant, type, use, checkpoint, later });
  }
  scroll.append(list);
  if (!log?.entries.length && !error) scroll.append(node("p", "nas-at-note", t("emptyCombinedHistory", "No recorded entries match these filters.")));
  const pagination = node("nav", "nas-at-pagination");
  pagination.setAttribute("aria-label", t("historyPages", "History pages"));
  pagination.append(button("previous", t("previous", "Previous"), { disabled: !log || log.page === 0 }),
    node("span", "", t("page", "{page} / {pages}", { page: (log?.page ?? 0) + 1, pages: log?.pages ?? 1 })),
    button("next", t("next", "Next"), { disabled: !log || log.page + 1 >= log.pages }));
  root.append(pagination, help);
  return root;
}
