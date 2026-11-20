import { spellbookText as t } from "../i18n.js";
import { getHardPageHinge } from "./pageTurnGeometry.js";

const CONTROL_SELECTOR = "input, select, textarea, button";
const coverLeaves = new WeakMap();
const isElement = value => value?.nodeType === 1
  || (typeof globalThis.Element === "function" && value instanceof globalThis.Element);
const isSelect = value => value?.tagName?.toUpperCase() === "SELECT"
  || (typeof globalThis.HTMLSelectElement === "function" && value instanceof globalThis.HTMLSelectElement);
const REFERENCE_ATTRIBUTES = [
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "for"
];

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function synchronizeControlState(source, clone) {
  const sourceControls = Array.from(source.querySelectorAll(CONTROL_SELECTOR));
  const cloneControls = Array.from(clone.querySelectorAll(CONTROL_SELECTOR));
  sourceControls.forEach((sourceControl, index) => {
    const cloneControl = cloneControls[index];
    if (!cloneControl) return;
    if ("value" in sourceControl) cloneControl.value = sourceControl.value;
    if ("checked" in sourceControl) cloneControl.checked = sourceControl.checked;
    if (isSelect(sourceControl) && isSelect(cloneControl)) {
      Array.from(cloneControl.options).forEach((option, optionIndex) => {
        option.selected = sourceControl.options[optionIndex]?.selected === true;
      });
    }
  });
}

function stripInteractiveAttributes(element) {
  element.removeAttribute("id");
  element.removeAttribute("name");
  element.removeAttribute("form");
  element.removeAttribute("tabindex");
  element.removeAttribute("contenteditable");
  element.removeAttribute("autofocus");
  for (const attribute of REFERENCE_ATTRIBUTES) element.removeAttribute(attribute);

  for (const attribute of Array.from(element.attributes ?? [])) {
    const name = attribute.name.toLocaleLowerCase();
    if (name.startsWith("on") || name.startsWith("data-proto-") || name === "data-action") {
      element.removeAttribute(attribute.name);
    }
  }
}

export function clonePrototypeFaceForMotion(source) {
  if (!isElement(source)) return null;

  const clone = source.cloneNode(true);
  synchronizeControlState(source, clone);
  clone.hidden = false;
  clone.removeAttribute("hidden");
  clone.style.display = "";
  clone.classList.remove("nas-proto-face-active");
  clone.classList.add("nas-proto-motion-source");
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.style.pointerEvents = "none";

  stripInteractiveAttributes(clone);
  for (const descendant of clone.querySelectorAll("*")) stripInteractiveAttributes(descendant);
  for (const control of clone.querySelectorAll(CONTROL_SELECTOR)) {
    control.disabled = true;
    control.setAttribute("aria-hidden", "true");
  }

  return clone;
}

function polygonToCss(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return "polygon(0px 0px, 0px 0px, 0px 0px)";
  }
  return `polygon(${points.map((point) => `${point.x.toFixed(3)}px ${point.y.toFixed(3)}px`).join(", ")})`;
}

function matrixToCss(matrix) {
  return `matrix(${[
    matrix.a,
    matrix.b,
    matrix.c,
    matrix.d,
    matrix.e,
    matrix.f
  ].map((value) => Number(value).toFixed(8)).join(", ")})`;
}

function positionLeaf(leaf, stageRect, pageRect) {
  leaf.style.left = `${pageRect.left - stageRect.left}px`;
  leaf.style.top = `${pageRect.top - stageRect.top}px`;
  leaf.style.width = `${pageRect.width}px`;
  leaf.style.height = `${pageRect.height}px`;
}

function makeLeaf({ stageRect, pageRect, direction, material, doc }) {
  const leaf = doc.createElement("div");
  leaf.className = [
    "nas-proto-motion-leaf",
    direction > 0 ? "nas-proto-motion-forward" : "nas-proto-motion-backward",
    `nas-proto-motion-${material}`
  ].join(" ");
  leaf.setAttribute("aria-hidden", "true");
  leaf.setAttribute("inert", "");
  positionLeaf(leaf, stageRect, pageRect);
  return leaf;
}

function makeFaceClone(source, className, side = null, doc = source?.ownerDocument ?? globalThis.document) {
  const wrapper = doc.createElement("div");
  wrapper.className = className;
  const clone = clonePrototypeFaceForMotion(source);
  if (!clone) return null;
  if (side) {

    clone.classList.remove("nas-proto-face-left", "nas-proto-face-right", "nas-proto-face-single");
    clone.classList.add(`nas-proto-face-${side}`);
  }
  wrapper.append(clone);
  return wrapper;
}

function setCreaseStyle(element, crease, visible) {
  if (!visible || !crease || crease.length < 1) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.style.left = `${crease.midpoint.x}px`;
  element.style.top = `${crease.midpoint.y}px`;
  element.style.width = `${crease.length}px`;
  element.style.transform = `translate(-50%, -50%) rotate(${crease.angle}deg)`;
}

function createPaperTurnVisual({
  layer,
  stageRect,
  pageRect,
  frontElement,
  backElement,
  direction,
  single
}) {
  const doc = layer.ownerDocument ?? frontElement.ownerDocument ?? globalThis.document;
  const leaf = makeLeaf({
    stageRect,
    pageRect,
    direction,
    material: "paper",
    doc
  });
  const front = makeFaceClone(frontElement, "nas-proto-fold-front", null, doc);
  const folded = doc.createElement("div");
  folded.className = "nas-proto-fold-back";
  const foldedContent = makeFaceClone(
    backElement,
    "nas-proto-fold-back-content",
    single ? "single" : direction > 0 ? "left" : "right",
    doc
  );
  if (!front || !foldedContent) return null;

  const foldedShade = doc.createElement("div");
  foldedShade.className = "nas-proto-fold-back-shade";
  foldedContent.append(foldedShade);
  folded.append(foldedContent);

  const creaseShadow = doc.createElement("div");
  creaseShadow.className = "nas-proto-fold-crease-shadow";
  const creaseHighlight = doc.createElement("div");
  creaseHighlight.className = "nas-proto-fold-crease-highlight";
  leaf.append(front, folded, creaseShadow, creaseHighlight);
  layer.append(leaf);

  const update = (foldState) => {
    if (!foldState) return;
    const visibleFold = !foldState.resting && foldState.foldedPolygon.length >= 3;
    const shadowOpacity = `${foldState.shadowOpacity ?? 0}`;

    folded.style.filter = `drop-shadow(0 7px 10px rgba(36, 20, 11, ${shadowOpacity}))`;
    foldedShade.style.opacity = shadowOpacity;
    creaseShadow.style.opacity = shadowOpacity;
    creaseHighlight.style.opacity = shadowOpacity;
    creaseShadow.style.height = `${foldState.shadowWidth ?? 0}px`;
    front.style.clipPath = polygonToCss(foldState.frontPolygon);
    folded.style.clipPath = polygonToCss(foldState.foldedPolygon);
    folded.style.transform = matrixToCss(foldState.reflection);
    folded.hidden = !visibleFold;
    leaf.toggleAttribute("data-resting", foldState.resting);
    setCreaseStyle(creaseShadow, foldState.crease, visibleFold);
    setCreaseStyle(creaseHighlight, foldState.crease, visibleFold);
  };

  return {
    element: leaf,
    kind: "paper",
    styleUpdateMode: "localized",
    update,
    destroy() {
      leaf.remove();
    }
  };
}

function createHardTurnVisual({
  layer,
  stageRect,
  pageRect,
  frontElement,
  backElement,
  direction,
  single
}) {
  const doc = layer.ownerDocument ?? frontElement.ownerDocument ?? globalThis.document;
  const leaf = makeLeaf({
    stageRect,
    pageRect,
    direction,
    material: "hard",
    doc
  });
  const front = makeFaceClone(
    frontElement,
    "nas-proto-motion-face nas-proto-motion-front",
    null,
    doc
  );
  const back = makeFaceClone(
    backElement,
    "nas-proto-motion-face nas-proto-motion-back",
    single ? "single" : direction > 0 ? "left" : "right",
    doc
  );
  if (!front || !back) return null;

  const shadow = doc.createElement("div");
  shadow.className = "nas-proto-motion-shadow";
  const hinge = getHardPageHinge({ stageRect, pageRect, direction, single });

  leaf.style.transformOrigin = `${hinge.originX}px center`;
  shadow.style.left = `${hinge.x - stageRect.left}px`;
  shadow.style.top = `${pageRect.top - stageRect.top}px`;
  shadow.style.bottom = "auto";
  shadow.style.height = `${pageRect.height}px`;
  leaf.append(front, back);
  layer.append(shadow, leaf);

  const update = (foldState) => {
    if (!foldState) return;
    const normalized = clamp01(foldState.progress);
    const directionSign = direction > 0 ? -1 : 1;
    const lift = Math.sin(Math.PI * normalized);
    leaf.style.transform = `rotateY(${directionSign * normalized * 180}deg)`;
    shadow.style.width = `${34 + (lift * 78)}px`;
    shadow.style.opacity = `${lift * 0.82}`;
    shadow.style.transform = `translateX(calc(-50% + ${directionSign * (normalized - 0.5) * 42}px))`;
  };

  return {
    element: leaf,
    kind: "hard",
    styleUpdateMode: "localized-spine-hinge",
    hardHinge: { ...hinge, single },
    update,
    destroy() {
      leaf.remove();
      shadow.remove();
    }
  };
}

export function createPrototypeTurnVisual({
  stage,
  frontElement,
  backElement,
  direction,
  hard = false
}) {
  if (!isElement(stage) || !isElement(frontElement) || !isElement(backElement)) {
    return null;
  }

  const layer = stage.querySelector(".nas-proto-motion-layer");
  if (!layer) return null;
  layer.replaceChildren();

  const stageRect = stage.getBoundingClientRect();
  const pageRect = frontElement.getBoundingClientRect();
  const single = stage.closest(".nas-proto-layout-single") !== null;
  const hinge = getHardPageHinge({ stageRect, pageRect, direction, single });
  const metrics = {
    left: pageRect.left,
    top: pageRect.top,
    width: pageRect.width,
    height: pageRect.height,
    bindingInset: single ? 0 : Math.max(0, direction > 0 ? -hinge.originX : hinge.originX - pageRect.width)
  };
  const visual = hard
    ? createHardTurnVisual({
      layer,
      stageRect,
      pageRect,
      frontElement,
      backElement,
      direction,
      single
    })
    : createPaperTurnVisual({
      layer,
      stageRect,
      pageRect,
      frontElement,
      backElement,
      direction,
      single
    });
  if (!visual) {
    layer.replaceChildren();
    layer.hidden = true;
    return null;
  }

  layer.hidden = false;

  return {
    ...visual,
    layer,
    metrics,
    destroy() {
      visual.destroy();
      if (!layer.children.length) layer.hidden = true;
    }
  };
}

export function setPrototypeCoverProgress(stage, progress) {
  if (!isElement(stage)) return;
  let cover = coverLeaves.get(stage);
  if (!cover) {
    cover = stage.querySelector("[data-proto-cover]");
    if (!cover) return;
    coverLeaves.set(stage, cover);
  }
  const normalized = clamp01(progress);
  cover.style.transform = `rotateY(${normalized * -180}deg)`;
}
