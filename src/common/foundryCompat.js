export function chatMessageStyle(styleName = "OTHER") {
  const styles = globalThis.CONST?.CHAT_MESSAGE_STYLES;
  if (styles) {

    const selected = ["ROLL", "WHISPER"].includes(styleName) ? "OTHER" : styleName;
    return styles[selected] != null ? { style: styles[selected] } : {};
  }

  const types = globalThis.CONST?.CHAT_MESSAGE_TYPES;
  if (types?.[styleName] != null) return { type: types[styleName] };

  return {};
}

export function foundryGeneration(game = globalThis.game) {
  const raw = game?.release?.generation;
  const generation = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? Number(raw) : NaN;
  if (Number.isSafeInteger(generation) && generation > 0) return generation;

  const version = String(game?.version ?? "").trim().match(/^(\d+)(?:\.|$)/);
  const major = version ? Number(version[1]) : NaN;
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

export function isFoundryV13Plus(game = globalThis.game) {
  return (foundryGeneration(game) ?? 0) >= 13;
}

export function legacyFormApplicationConstructor() {
  return globalThis.foundry?.appv1?.api?.FormApplication
    ?? (typeof FormApplication === "function" ? FormApplication : null);
}

export function legacyDialogConstructor() {
  return globalThis.foundry?.appv1?.api?.Dialog
    ?? (typeof Dialog === "function" ? Dialog : null);
}

export function tokenDocumentPosition(token) {
  return Object.fromEntries(["x", "y", "elevation", "width", "height", "shape"].map((key) => [key,
    (["x", "y", "elevation"].includes(key) ? token?._source?.[key] : undefined)
      ?? token?.[key] ?? (["width", "height"].includes(key) ? 1 : 0)
  ]));
}

export function chatRenderHookName() {
  if (globalThis.game?.release?.generation == null && !globalThis.game?.version) return null;
  return isFoundryV13Plus() ? "renderChatMessageHTML" : "renderChatMessage";
}

export function onRenderChatMessageCompat(handler) {
  const hookName = chatRenderHookName();
  if (!hookName) {
    return Hooks.once("init", () => onRenderChatMessageCompat(handler));
  }

  return Hooks.on(hookName, handler);
}

export function actorDocumentConstructor() {
  return globalThis.Actor ?? globalThis.foundry?.documents?.Actor ?? null;
}

export function isActorDocument(value) {
  if (!value) return false;

  const ActorCtor = actorDocumentConstructor();
  if (ActorCtor && value instanceof ActorCtor) return true;

  return value.documentName === "Actor" || value.constructor?.name === "ActorPF";
}

export function clonePlainData(value) {
  const deepClone = globalThis.foundry?.utils?.deepClone;
  if (deepClone) return deepClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

export function elementFromHtmlLike(html) {
  const HTMLElementCtor = globalThis.HTMLElement;

  if (html?.nodeType === 1 || (HTMLElementCtor && html instanceof HTMLElementCtor)) return html;
  if (Array.isArray(html)) return elementFromHtmlLike(html[0]);
  if (html?.jquery) return elementFromHtmlLike(html[0]);
  if (HTMLElementCtor && html?.[0] instanceof HTMLElementCtor) return html[0];
  if (typeof html?.querySelector === "function") return html;
  return null;
}

export function escapeHtmlForSheet(value) {
  const text = String(value ?? "");
  const foundryEscape = globalThis.foundry?.utils?.escapeHTML;
  if (typeof foundryEscape === "function") return foundryEscape(text);

  const handlebarsEscape = globalThis.Handlebars?.escapeExpression;
  if (typeof handlebarsEscape === "function") return handlebarsEscape(text);

  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

export function htmlElementFromRenderArg(html) {
  return elementFromHtmlLike(html);
}

export function jqueryFromHtmlLike(html) {
  if (html?.jquery) return html;
  const element = elementFromHtmlLike(html);
  if (!element || typeof globalThis.jQuery !== "function") return null;
  return globalThis.jQuery(element);
}

export function queryHtml(html, selector) {
  const root = elementFromHtmlLike(html);
  return root?.querySelector?.(selector) ?? null;
}

export function queryHtmlAll(html, selector) {
  const root = elementFromHtmlLike(html);
  return root?.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
}

export function closestHtml(html, selector) {
  const element = elementFromHtmlLike(html);
  return element?.closest?.(selector) ?? null;
}

export function setElementVisible(html, visible) {
  const element = elementFromHtmlLike(html);
  if (!element) return;
  element.style.display = visible ? "" : "none";
}

export function checkboxChecked(html) {
  const element = elementFromHtmlLike(html);
  return element?.checked === true;
}

export function insertNasSettingsSectionsContainer(tabEl, container) {
  if (isFoundryV13Plus()) {
    tabEl.prepend(container);
    return;
  }

  const titleEl = tabEl.querySelector(":scope > h2.border");
  if (titleEl) titleEl.insertAdjacentElement("afterend", container);
  else tabEl.prepend(container);
}
