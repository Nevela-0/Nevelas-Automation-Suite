import { htmlElementFromRenderArg, isFoundryV13Plus } from "../../common/foundryCompat.js";
import { createTrackerLocalizer } from "./uiModel.js";
import { ensureTrackerStyles } from "./uiStyles.js";

export const REGION_PRESETS = Object.freeze({ difficult: { walk: 2, fly: 1, swim: 1, burrow: 1 },
  undergrowth: { walk: 4, fly: 1, swim: 1, burrow: 1 } });
const MODES = ["walk", "fly", "swim", "burrow"];
const rendered = new WeakMap();

export function renderRegionPresets(app, html, game = globalThis.game) {
  if (!isFoundryV13Plus(game) || app.document?.type !== "modifyMovementCost") return;
  const root = htmlElementFromRenderArg(html);
  if (!root) return;
  const fields = Object.fromEntries(MODES.map((mode) => [mode, root.querySelector(`[name="system.difficulties.${mode}"]`)]));
  if (Object.values(fields).some((field) => !field)) return;
  const previous = rendered.get(root);
  previous?.cleanup();
  root.querySelector(".nas-at-region-presets")?.remove();
  const document = root.ownerDocument, t = createTrackerLocalizer(() => game);
  ensureTrackerStyles(document);
  const node = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };
  const section = node("div"); section.className = "nas-at-region-presets";
  const label = node("label", t("regionPreset", "Terrain movement cost"));
  const select = node("select"); select.setAttribute("aria-label", label.textContent);
  for (const [key, text] of [["none", "None"], ["difficult", "Difficult Terrain ×2"], ["undergrowth", "Heavy Undergrowth ×4"]]) {
    const option = node("option", t(`regionPresets.${key}`, text)); option.value = key; select.append(option);
  }
  const choose = (key) => {
    for (const option of select.options) option.selected = false;
    Array.from(select.options).find((option) => option.value === key).selected = true;
  };
  const read = () => Object.fromEntries(Object.entries(fields).map(([mode, field]) => [mode, field.value === "" ? null : Number(field.value)]));
  const initial = read();
  choose(previous && JSON.stringify(previous.values()) === JSON.stringify(initial) ? previous.selection()
    : Object.keys(REGION_PRESETS).find((key) => Object.entries(REGION_PRESETS[key]).every(([mode, value]) => initial[mode] === value)) ?? "none");
  const locked = () => app.isEditable === false || Object.values(fields).some((field) => field.disabled || field.readOnly);
  select.disabled = locked();
  let applying = false;
  const custom = (event) => { if (!applying && Object.values(fields).includes(event.target)) choose("none"); };
  root.addEventListener("input", custom); root.addEventListener("change", custom);
  select.addEventListener("change", (event) => {
    event.preventDefault(); event.stopPropagation();
    if (locked() || !Object.hasOwn(REGION_PRESETS, select.value)) return;
    applying = true;
    try {
      for (const [mode, value] of Object.entries(REGION_PRESETS[select.value])) {
        const field = fields[mode];

        let emitted = false;
        const observed = () => { emitted = true; };
        field.addEventListener("change", observed);
        try { field.value = String(value); }
        finally { field.removeEventListener("change", observed); }
        if (!emitted) {
          const Event = document.defaultView.Event;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    } finally { applying = false; }
  });
  label.append(select);
  section.append(label);
  fields.walk.closest("fieldset")?.prepend(section);
  if (!section.isConnected) root.prepend(section);
  rendered.set(root, { values: read, selection: () => select.value,
    cleanup: () => { root.removeEventListener("input", custom); root.removeEventListener("change", custom); } });
}
