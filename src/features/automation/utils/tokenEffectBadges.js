import { MODULE } from "../../../common/module.js";

const BADGE_PREFIX = "nasTokenEffectBadge:";
const providers = new Map();
let registered = false;

function texturePath(displayObject) {
  const texture = displayObject?.texture;
  return String(
    texture?.baseTexture?.resource?.src
    ?? texture?.baseTexture?.cacheId
    ?? texture?.source?.resource?.src
    ?? texture?.source?.label
    ?? texture?.textureCacheIds?.[0]
    ?? ""
  );
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").toLowerCase();
}

function badgeObjectName(providerId, name = "default") {
  return `${BADGE_PREFIX}${providerId}:${name}`;
}

function clearTokenEffectBadges(token) {
  const effects = token?.effects;
  if (!effects?.children) return;
  const stack = [...effects.children];
  while (stack.length) {
    const child = stack.pop();
    if (!child) continue;
    if (String(child.name ?? "").startsWith(BADGE_PREFIX)) {
      child.parent?.removeChild?.(child);
      child.destroy?.({ children: true });
      continue;
    }
    if (child.children?.length) stack.push(...child.children);
  }
}

function findEffectIcon(token, item) {
  const effects = token?.effects;
  if (!effects?.children || !item?.img) {
    return null;
  }
  const needle = normalizePath(item.img);
  return effects.children.find((child) => {
    const path = normalizePath(texturePath(child));
    return path && (path === needle || path.endsWith(needle) || needle.endsWith(path));
  }) ?? null;
}

function makeTokenEffectBadge(icon, descriptor, providerId) {
  const iconSize = Math.max(16, Math.min(Number(icon?.width) || 32, Number(icon?.height) || 32));
  const text = new PIXI.Text(String(descriptor.value), {
    fontFamily: descriptor.fontFamily ?? "Arial",
    fontSize: Number(descriptor.fontSize) || Math.max(18, Math.round(iconSize * 0.56)),
    fontWeight: descriptor.fontWeight ?? "bold",
    fill: descriptor.fill ?? 0xff2020,
    stroke: descriptor.stroke ?? 0x000000,
    strokeThickness: Number(descriptor.strokeThickness) || Math.max(4, Math.round(iconSize * 0.06)),
    align: "center"
  });
  text.name = badgeObjectName(providerId, descriptor.name);
  text.anchor.set(0.5);
  const x = Number.isFinite(Number(descriptor.xRatio)) ? Number(descriptor.xRatio) : 0.86;
  const y = Number.isFinite(Number(descriptor.yRatio)) ? Number(descriptor.yRatio) : 0.22;
  text.position.set(iconSize * x, iconSize * y);
  return text;
}

export function canUserSeeTokenEffectBadge(item) {
  const actor = item?.actor;
  return Boolean(game.user?.isGM || item?.isOwner || actor?.isOwner);
}

export function registerTokenEffectBadgeProvider(provider) {
  const id = String(provider?.id ?? "").trim();
  if (!id || typeof provider?.getBadgesForToken !== "function") return;
  providers.set(id, provider);
}

export function drawTokenEffectBadges(token) {
  clearTokenEffectBadges(token);
  for (const [providerId, provider] of providers.entries()) {
    let descriptors = [];
    try {
      descriptors = provider.getBadgesForToken(token) ?? [];
    } catch (_err) {
      descriptors = [];
    }
    for (const descriptor of descriptors) {
      if (!descriptor || descriptor.visible === false) {
        continue;
      }
      if (descriptor.value == null || descriptor.value === "") {
        continue;
      }
      const item = descriptor.item;
      const icon = descriptor.icon ?? findEffectIcon(token, item);
      if (!icon) {
        continue;
      }
      const badge = makeTokenEffectBadge(icon, descriptor, providerId);
      icon.addChild(badge);
    }
  }
}

export function refreshTokenEffectBadgesForActor(actor) {
  const tokens = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
  for (const token of tokens) {
    token?.drawEffects?.();
  }
}

export function refreshTokenEffectBadgesForScene(predicate = null) {
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (typeof predicate === "function" && !predicate(token)) continue;
    token?.drawEffects?.();
  }
}

export function registerTokenEffectBadges() {
  if (registered) return;
  if (!globalThis.libWrapper || !globalThis.Token?.prototype?.drawEffects) return;
  registered = true;
  libWrapper.register(
    MODULE.ID,
    "Token.prototype.drawEffects",
    async function (wrapped, ...args) {
      const result = await wrapped.apply(this, args);
      try {
        drawTokenEffectBadges(this);
      } catch (_err) {}
      return result;
    },
    "WRAPPER"
  );
}
