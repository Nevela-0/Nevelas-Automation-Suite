import { getFlagsContainer } from "../automation/utils/attackDialogFlags.js";
import { elementFromHtmlLike } from "../../common/foundryCompat.js";
import { SPRING_VARIANTS, springNextSlot, springPenalty } from "./springAttack.js";

export function renderSpringDialog(dialog, html, options) {
  const use = dialog?.actionUse, root = elementFromHtmlLike(html);
  if (!root) return;
  const document = root.ownerDocument;
  const focused = root.contains(document.activeElement) ? document.activeElement?.dataset?.nasSpring : null;
  root.querySelectorAll(".nas-spring-attack, .nas-spring-power").forEach((el) => el.remove());
  const emptyFlags = root.querySelector('[data-nas-spring-flags]');
  if (emptyFlags?.childElementCount === 1) emptyFlags.remove();
  if (!options?.variants?.length || use?.item?.type === "spell" || !["mwak", "msak"].includes(use?.action?.actionType ?? use?.action?.data?.actionType)
    || use?.action?.activation?.type !== "attack") return;
  use.shared ??= {};
  const { spring } = options;
  const variant = spring?.variant ?? options.highest;
  const spec = SPRING_VARIANTS[variant];
  if (!spec) return;
  const form = root.querySelector("form") ?? root;
  const flags = getFlagsContainer(form, "nasSpringFlags");
  const check = (key, caption, className, checked) => {
    const label = document.createElement("label"), field = document.createElement("input");
    label.className = `checkbox ${className}`;
    field.type = "checkbox"; field.dataset.nasSpring = key; field.checked = checked;
    field.addEventListener("change", () => {
      if (field.disabled) return;
      use.shared[key] = field.checked; update();
    });
    label.append(field, document.createTextNode(" " + caption)); flags.append(label); return field;
  };
  const selected = check("nasSpringSelected", "Spring Attack", "nas-spring-attack", use.shared.nasSpringSelected ?? !!spring);
  const mythic = spring ? spring.mythic : options.mythicAvailable;
  const power = mythic ? check("nasSpringPower", "Mythic power (1)", "nas-spring-power",
    spring ? !!spring.mythicPower : use.shared.nasSpringPower === true) : null;
  if (!mythic) use.shared.nasSpringPower = false;
  const describe = (field, text) => {
    field.title = field.parentElement.title = text;
    field.setAttribute("aria-description", text);
  };
  function update() {
    selected.disabled = !!options.disabledReason;
    const limit = spring?.limit ?? spec.limit;
    const slot = spring ? springNextSlot({ spring }) : 1;
    describe(selected, options.disabledReason ?? (slot
      ? `${spec.label}${mythic ? " · Mythic" : ""}: attack ${slot}/${limit}, modifier ${springPenalty(slot)}. Move–attack–move within one speed.`
      : "No included attacks left. A further attack is separate and ends this activity."));
    if (power) {
      power.disabled = !!options.disabledReason || !selected.checked || !!spring;
      describe(power, "Declare 1 use spent manually; NAS does not change resources.");
    }
  }
  update();
  for (const field of [selected, power]) if (field?.dataset.nasSpring === focused) field.focus();
  try { dialog.setPosition?.({ height: "auto" }); } catch {   }
}
