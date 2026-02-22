export function normalizeTargets(options) {
    const toArray = (maybe) => {
        if (maybe == null) return [];
        if (Array.isArray(maybe)) return maybe;
        if (typeof maybe[Symbol.iterator] === "function") return Array.from(maybe);
        return [maybe];
    };

    const toActor = (t) => {
        if (!t) return null;
        if (t instanceof Actor) return t;
        if (t.actor instanceof Actor) return t.actor;
        if (t.document?.actor instanceof Actor) return t.document.actor;
        if (t.object?.actor instanceof Actor) return t.object.actor;
        return null;
    };

    const hasClickContext = options?.element != null || options?.event != null || options?.message != null;

    let rawTargets = toArray(options?.targets);

    if (!rawTargets.length && hasClickContext) rawTargets = toArray(canvas.tokens?.controlled);
    if (!rawTargets.length && hasClickContext) rawTargets = toArray(game.user?.targets);
    if (!rawTargets.length && hasClickContext) rawTargets = toArray(options?.message?.targets);

    if (!rawTargets.length && !hasClickContext) rawTargets = toArray(options?.message?.targets);
    if (!rawTargets.length && !hasClickContext) rawTargets = toArray(game.user?.targets);
    if (!rawTargets.length && !hasClickContext) rawTargets = toArray(canvas.tokens?.controlled);

    const actors = rawTargets.map(toActor).filter((a) => a instanceof Actor);
    return actors;
}
