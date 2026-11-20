import { MODULE } from "../../common/module.js";

const stylesheetUrl = new URL("../../templates/css/action-tracker.css", import.meta.url).href;
const stylesheetPath = `/modules/${MODULE.ID}/src/templates/css/action-tracker.css`;

export function ensureTrackerStyles(document) {
  if (!document?.head) return;
  const existing = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((link) => {
    try {
      return new URL(link.getAttribute("href"), document.baseURI || stylesheetUrl).pathname.endsWith(stylesheetPath);
    } catch { return false; }
  });
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";

  link.href = stylesheetUrl;
  link.dataset.nasActionTrackerStyle = "true";
  document.head.append(link);
  return link;
}
