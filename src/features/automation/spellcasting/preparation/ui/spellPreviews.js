import { spellbookText as t } from "../i18n.js";
import { buildPrototypeSpellName, ensureSpellPanelStyles, getPrototypeSpellStats } from "./spellPanels.js";

let sequence = 0;
const text = value => `${value ?? ""}`.trim();

export function conciseSpellText(value, limit = 220) {
  const plain = text(value).replace(/\s+/g, " ");
  if (plain.length <= limit) return plain;
  const clipped = plain.slice(0, limit - 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${boundary > limit * .65 ? clipped.slice(0, boundary) : clipped}…`;
}

function descriptionText(source, doc) {
  const html = source?.system?.description?.value ?? source?.description ?? "";
  if (!html) return "";
  const template = doc.createElement("template");
  template.innerHTML = `${html}`;
  const content = template.content;
  if (!content?.querySelectorAll) return "";
  for (const node of content.querySelectorAll("script, style, iframe, object, embed, .secret, [data-secret]")) node.remove();
  for (const node of content.querySelectorAll("br, p, div, li, h1, h2, h3, h4, tr")) node.append(doc.createTextNode(" "));
  return conciseSpellText(content.textContent);
}

export function getPrototypeSpellPreview(spell, doc) {
  if (spell?.missing) return {
    name: buildPrototypeSpellName(spell.name, spell.preparedEntry), level: "", timing: "", defense: "",
    description: t("The original spell is missing from the actor sheet.")
  };
  const source = spell?.sourceItem ?? spell?.itemData ?? spell?.knownSpell?.itemData ?? spell;
  const stats = new Map(getPrototypeSpellStats(spell));
  const prepared = Number(spell?.preparedSlotLevel ?? spell?.preparedEntry?.preparedSlotLevel);
  const original = Number(spell?.originalLevel ?? spell?.originalSpellLevel ?? source?.system?.level ?? spell?.level);
  return {
    name: buildPrototypeSpellName(source?.name || spell?.name, spell?.preparedEntry),
    level: [stats.has(t("Level")) ? `${spell?.isVariant || spell?.preparedEntry?.metamagic?.length ? t("Original spell · Level") : t("Level")} ${stats.get(t("Level"))}` : "", stats.get(t("School")),
      Number.isFinite(prepared) && prepared !== original ? t("Prepared {level}", {level: prepared}) : ""].filter(Boolean).join(" · "),
    timing: [t("Casting time"), t("Range"), t("Duration")].map(key => stats.get(key)).filter(Boolean).join(" · "),
    defense: [stats.get(t("Saving throw")) ? t("Save {value}", {value: stats.get(t("Saving throw"))}) : "",
      stats.get(t("Spell resistance")) ? t("SR {value}", {value: stats.get(t("Spell resistance"))}) : ""].filter(Boolean).join(" · "),
    description: descriptionText(source, doc)
  };
}

export class PrototypeSpellPreviews {
  constructor({ getSpell, canShow = () => true, delay = 350 } = {}) {
    this.getSpell = getSpell;
    this.canShow = canShow;
    this.delay = delay;
    this.active = null;
    this.pending = null;
    this.listeners = [];
    this.titles = new Map();
  }

  bind(root) {
    this.unbind();
    if (!root?.ownerDocument) return;
    this.root = root;
    const doc = root.ownerDocument;
    ensureSpellPanelStyles(doc);
    const listen = (target, name, callback, options) => {
      target.addEventListener(name, callback, options);
      this.listeners.push(() => target.removeEventListener(name, callback, options));
    };
    for (const anchor of root.querySelectorAll("[data-proto-details]")) {
      if (!anchor.closest(".nas-proto-canonical") || anchor.closest(".nas-proto-motion-source, .nas-proto-motion-layer")) continue;
      const title = anchor.getAttribute("title");
      if (title !== null) { this.titles.set(anchor, title); anchor.removeAttribute("title"); }
    }
    const anchorFor = target => {
      const anchor = target?.closest?.("[data-proto-details]");
      return anchor && root.contains(anchor) && anchor.closest(".nas-proto-canonical")
        && !anchor.closest(".nas-proto-motion-source, .nas-proto-motion-layer") ? anchor : null;
    };
    listen(root, "pointerover", event => {
      const anchor = anchorFor(event.target);
      if (!anchor || anchor.contains(event.relatedTarget) || (event.pointerType && event.pointerType !== "mouse")) return;
      this.schedule(anchor);
    });
    listen(root, "pointerout", event => {
      const anchor = anchorFor(event.target);
      if (anchor && !anchor.contains(event.relatedTarget) && doc.activeElement !== anchor) this.hide();
    });
    listen(root, "focusin", event => { const anchor = anchorFor(event.target); if (anchor) this.show(anchor); });
    listen(root, "focusout", event => { if (anchorFor(event.target)) this.hide(); });
    listen(root, "click", () => this.hide(), true);
    listen(doc, "pointerdown", () => this.hide(), true);
    listen(doc, "keydown", event => {
      if (event.key !== "Escape" || (!this.active && !this.pending)) return;
      this.hide();
      event.preventDefault();
      event.stopPropagation();
    }, true);
    listen(doc, "scroll", () => this.hide(), true);
    if (doc.defaultView) {
      listen(doc.defaultView, "resize", () => this.hide());
      listen(doc.defaultView, "pagehide", () => this.hide());
    }
  }

  schedule(anchor) {
    this.hide();
    const win = anchor.ownerDocument.defaultView ?? globalThis;
    const timer = win.setTimeout(() => { this.pending = null; this.show(anchor); }, this.delay);
    this.pending = { win, timer };
  }

  show(anchor) {
    this.hide();
    if (!anchor?.isConnected || !this.root?.contains(anchor) || !anchor.closest(".nas-proto-canonical")
      || anchor.closest(".nas-proto-motion-source, .nas-proto-motion-layer") || anchor.closest("[inert], [hidden]") || !this.canShow()) return;
    const spellId = anchor.closest("[data-spell-id]")?.dataset.spellId;
    const spell = this.getSpell?.(spellId);
    if (!spell) return;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView;
    ensureSpellPanelStyles(doc);
    const data = getPrototypeSpellPreview(spell, doc);
    const root = doc.createElement("aside");
    root.id = `nas-proto-spell-preview-${++sequence}`;
    root.className = "nas-proto-spell-preview";
    root.setAttribute("role", "tooltip");
    for (const [key, value] of Object.entries(data)) {
      if (!value) continue;
      const node = doc.createElement(key === "name" ? "strong" : "p");
      node.className = `nas-proto-spell-preview-${key}`;
      node.textContent = value;
      root.append(node);
    }
    doc.body.append(root);
    const describedBy = text(anchor.getAttribute("aria-describedby"));
    anchor.setAttribute("aria-describedby", [describedBy, root.id].filter(Boolean).join(" "));
    this.active = { root, anchor, describedBy };
    const bounds = anchor.getBoundingClientRect();
    const width = Math.min(340, Math.max(0, (win?.innerWidth ?? 1024) - 24));
    const height = root.getBoundingClientRect().height;
    const bottom = win?.innerHeight ?? 768;
    const left = Math.max(12, Math.min(bounds.left, (win?.innerWidth ?? 1024) - width - 12));
    const top = bounds.bottom + 8 + height <= bottom - 12 ? bounds.bottom + 8 : Math.max(12, bounds.top - height - 8);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  hide() {
    if (this.pending) { this.pending.win.clearTimeout(this.pending.timer); this.pending = null; }
    const state = this.active;
    if (!state) return;
    state.root.remove();
    const remaining = text(state.anchor.getAttribute("aria-describedby")).split(/\s+/).filter(value => value && value !== state.root.id).join(" ");
    if (remaining) state.anchor.setAttribute("aria-describedby", remaining);
    else state.anchor.removeAttribute("aria-describedby");
    this.active = null;
  }

  unbind() {
    this.hide();
    for (const remove of this.listeners.splice(0)) remove();
    for (const [anchor, title] of this.titles) anchor.setAttribute("title", title);
    this.titles.clear();
    this.root = null;
  }

  destroy() { this.unbind(); }
}
