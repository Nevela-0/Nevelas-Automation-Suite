
export function getFlagsContainer(form, createdMarker) {
  const existing = form.querySelector("div.form-group.stacked.flags");
  if (existing) return existing;

  const doc = form.ownerDocument;
  const row = doc.createElement("div");
  row.className = "form-group stacked flags";
  if (createdMarker) row.dataset[createdMarker] = "true";
  const heading = doc.createElement("label");
  heading.textContent = globalThis.game?.i18n?.localize?.("PF1.Misc") ?? "Misc";
  row.append(heading);
  const sibling = form.querySelector(".form-group.flags") ?? form.querySelector(".form-group");
  if (sibling) sibling.after(row);
  else form.append(row);
  return row;
}
