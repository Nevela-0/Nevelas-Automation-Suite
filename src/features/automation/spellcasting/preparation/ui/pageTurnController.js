import { spellbookText as t } from "../i18n.js";
import {
  createPrototypeTurnVisual,
  setPrototypeCoverProgress
} from "./pageTurnVisuals.js";
import {
  createPageFoldState,
  getFoldCorner,
  getFoldPointForProgress,
  interpolateFoldPoint
} from "./pageTurnGeometry.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function easeInOutCubic(value) {
  const t = clamp01(value);
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function isEditableTarget(target) {
  return target?.closest?.("input, select, textarea, button, [contenteditable='true']");
}

export class PrototypePageTurnController {
  constructor({
    root,
    stage,
    getMotionMode,
    getTurnSpec,
    getCursor,
    jumpToCursor,
    getFaceElement,
    showTransitionUnderlay,
    commitTurn,
    cancelTurn,
    getCoverOpen,
    setCoverOpen,
    prepareCover = () => {},
    onPhaseChange
  }) {
    this.root = root;
    this.stage = stage;
    this.getMotionMode = getMotionMode;
    this.getTurnSpec = getTurnSpec;
    this.getCursor = getCursor;
    this.jumpToCursor = jumpToCursor;
    this.getFaceElement = getFaceElement;
    this.showTransitionUnderlay = showTransitionUnderlay;
    this.commitTurn = commitTurn;
    this.cancelTurn = cancelTurn;
    this.getCoverOpen = getCoverOpen;
    this.setCoverOpenState = setCoverOpen;
    this.prepareCover = prepareCover;
    this.onPhaseChange = onPhaseChange;

    this.phase = "idle";
    this.activeTurn = null;
    this.activeFoldState = null;
    this.visual = null;
    this.pointer = null;
    this.previewDirection = null;
    this.coverPointer = null;
    this.coverProgress = this.getCoverOpen() ? 1 : 0;
    this.animationFrame = null;
    this.frameWindow = null;
    this.pausedForDismissal = false;
    this.animationToken = 0;
    this.suppressClickUntil = 0;
    this.cleanupCallbacks = [];
    this.navigation = null;
    this.navigationId = 0;
  }

  bind() {
    this.pausedForDismissal = false;
    this.destroyListeners();
    setPrototypeCoverProgress(this.stage, this.coverProgress);
    this.stage.dataset.cover = this.getCoverOpen() ? "open" : "closed";
    this._bindCorner(this.root.querySelector("[data-proto-turn='previous']"), -1);
    this._bindCorner(this.root.querySelector("[data-proto-turn='next']"), 1);

    const cover = this.root.querySelector("[data-proto-cover]");
    if (cover) {
      this._listen(cover, "pointerdown", (event) => this._onCoverPointerDown(event));
      this._listen(cover, "click", (event) => {
        if (performance.now() < this.suppressClickUntil) return;
        event.preventDefault();
        if (this.getCoverOpen() || this.stage.dataset.cover === "moving") return;
        this.openCover();
      });
    }

    this._listen(this.getFaceElement(0), "pointerdown", (event) => {
      if (event.currentTarget.hidden) return;
      this._onCoverPointerDown(event, { closing: true, toggleOnClick: false });
    });

    this._listen(this.stage, "pointermove", (event) => this._onCoverPointerMove(event));
    this._listen(this.stage, "pointerup", (event) => this._onCoverPointerUp(event));
    this._listen(this.stage, "pointercancel", () => this._cancelCoverDrag());
    this._listen(this.stage, "lostpointercapture", (event) => {
      if (this.coverPointer?.id === event.pointerId) this._cancelCoverDrag();
    });

    this._listen(this.stage, "keydown", (event) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        this.turn(-1);
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        this.turn(1);
      }
    });
  }

  _listen(element, eventName, callback, options) {
    element?.addEventListener?.(eventName, callback, options);
    if (element) {
      this.cleanupCallbacks.push(() => element.removeEventListener(eventName, callback, options));
    }
  }

  _bindCorner(corner, direction) {
    if (!corner) return;
    this._listen(corner, "pointerenter", () => this._setPeel(direction));
    this._listen(corner, "pointerleave", () => {
      if (corner !== corner.ownerDocument.activeElement) this._clearPeel();
    });
    this._listen(corner, "focus", () => this._setPeel(direction));
    this._listen(corner, "blur", () => {
      if (!corner.matches(":hover")) this._clearPeel();
    });
    this._listen(corner, "pointerdown", (event) => this._onTurnPointerDown(event, direction));
    this._listen(corner, "pointermove", (event) => this._onTurnPointerMove(event));
    this._listen(corner, "pointerup", (event) => this._onTurnPointerUp(event));
    this._listen(corner, "pointercancel", () => this.cancelActiveTurn());
    this._listen(corner, "click", (event) => {
      if (performance.now() < this.suppressClickUntil) return;
      event.preventDefault();
      this.turn(direction);
    });
  }

  _setPeel(direction) {
    if (this.pausedForDismissal) return;
    if (this.getMotionMode() !== "full" || !this.getCoverOpen() || this.pointer) return;
    const spec = this.getTurnSpec(direction);
    if (!spec) return;
    const canReusePreview = this.phase === "peeling"
      && this.activeTurn?.direction === spec.direction
      && this.activeTurn?.sourceCursor === spec.sourceCursor;
    if (!canReusePreview && this.phase === "peeling") {
      this.cancelActiveTurn({ restore: true });
    }
    if (!canReusePreview && (this.phase !== "idle" || !this._beginTurn(spec))) return;

    this.previewDirection = direction;
    this._setPhase("peeling");
    this.stage.dataset.peel = direction > 0 ? "next" : "previous";
    const targetPoint = getFoldPointForProgress({
      ...this.visual.metrics,
      direction,
      progress: 0.075,
      verticalInfluence: -0.3
    });
    this._animateFoldTo(targetPoint, {
      duration: 180,
      phase: "peeling"
    });
  }

  _clearPeel() {
    delete this.stage.dataset.peel;
    this.previewDirection = null;
    if (this.pointer || this.phase !== "peeling" || !this.activeTurn) return;

    const corner = getFoldCorner({
      ...this.visual.metrics,
      direction: this.activeTurn.direction
    });
    this._animateFoldTo(corner, {
      duration: 150,
      phase: "peeling",
      complete: () => this._completeTurn(false)
    });
  }

  _onTurnPointerDown(event, direction) {
    if (this.pausedForDismissal) return;
    if (event.button !== 0 || this.stage.dataset.cover === "moving" || this.phase === "settling") return;
    if (this.getMotionMode() !== "full") return;

    if (!this.getCoverOpen()) {
      if (direction > 0) this._onCoverPointerDown(event);
      return;
    }

    const spec = this.getTurnSpec(direction);
    if (!spec) {
      if (direction < 0) this._onCoverPointerDown(event, { closing: true });
      return;
    }
    const canReusePreview = this.phase === "peeling"
      && this.activeTurn?.direction === spec.direction
      && this.activeTurn?.sourceCursor === spec.sourceCursor;
    if (!canReusePreview && !this._beginTurn(spec)) return;
    this._cancelAnimation();

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    delete this.stage.dataset.peel;
    this.previewDirection = null;
    const foldState = this._stateForClientPoint(event.clientX, event.clientY);
    this._applyFoldState(foldState);
    this.pointer = {
      id: event.pointerId,
      captureTarget: event.currentTarget,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      lastTime: performance.now(),
      velocity: 0,
      progress: foldState.progress,
      moved: false
    };
    this._setPhase("dragging");
  }

  _onTurnPointerMove(event) {
    if (!this.pointer || event.pointerId !== this.pointer.id || !this.visual) return;
    const now = performance.now();
    const foldState = this._stateForClientPoint(event.clientX, event.clientY);
    const elapsed = Math.max(1, now - this.pointer.lastTime);
    const deltaProgress = foldState.progress - this.pointer.progress;
    this.pointer.velocity = (this.pointer.velocity * 0.65) + ((deltaProgress / elapsed) * 0.35);
    this.pointer.progress = foldState.progress;
    this.pointer.moved ||= Math.hypot(event.clientX - this.pointer.startX, event.clientY - this.pointer.startY) > 5;
    this.pointer.lastTime = now;
    this._applyFoldState(foldState);
  }

  _onTurnPointerUp(event) {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    event.preventDefault();
    event.currentTarget.releasePointerCapture?.(event.pointerId);

    const pointer = this.pointer;
    this.pointer = null;
    this.suppressClickUntil = performance.now() + 350;
    const commit = !pointer.moved
      || this.activeFoldState?.crossedSpine
      || pointer.progress >= 0.35
      || pointer.velocity > 0.0018;
    this._settleTurn(commit);
  }

  _beginTurn(spec) {
    this.cancelActiveTurn({ restore: true, navigation: false });
    const frontElement = this.getFaceElement(spec.turningFaceIndex);
    const backElement = this.getFaceElement(spec.backFaceIndex);
    if (!frontElement || !backElement) return false;

    this.activeTurn = spec;
    this.visual = createPrototypeTurnVisual({
      stage: this.stage,
      frontElement,
      backElement,

      direction: spec.direction
    });
    if (!this.visual) {
      this.activeTurn = null;
      return false;
    }

    const corner = getFoldCorner({
      ...this.visual.metrics,
      direction: spec.direction
    });
    this.activeFoldState = createPageFoldState({
      ...this.visual.metrics,
      direction: spec.direction,
      pointer: corner
    });
    this.showTransitionUnderlay(spec);
    this.visual.update(this.activeFoldState);
    return true;
  }

  _stateForClientPoint(clientX, clientY) {
    if (!this.activeTurn || !this.visual) return null;
    return createPageFoldState({
      ...this.visual.metrics,
      direction: this.activeTurn.direction,
      pointer: {
        x: Number(clientX) - this.visual.metrics.left,
        y: Number(clientY) - this.visual.metrics.top
      }
    });
  }

  _stateForProgress(progress, verticalInfluence = 0) {
    if (!this.activeTurn || !this.visual) return null;
    const point = getFoldPointForProgress({
      ...this.visual.metrics,
      direction: this.activeTurn.direction,
      progress,
      verticalInfluence
    });
    return createPageFoldState({
      ...this.visual.metrics,
      direction: this.activeTurn.direction,
      pointer: point
    });
  }

  _applyFoldState(foldState) {
    if (!foldState || !this.visual) return;
    this.activeFoldState = foldState;
    this.visual.update(foldState);
    this.onPhaseChange?.(this.phase, foldState.progress);
  }

  get isNavigating() {
    return this.navigation !== null;
  }

  navigateTo(cursor, { onComplete } = {}) {
    if (this.pausedForDismissal || !this.getCoverOpen()
      || this.stage.dataset.cover === "moving" || this.coverPointer
      || !Number.isFinite(cursor) || typeof this.getCursor !== "function") return false;

    this.navigationId += 1;
    this.navigation = { target: cursor, onComplete, turns: 0, stepDuration: null };
    if (this.phase === "dragging" || this.phase === "settling") return true;
    this.cancelActiveTurn({ restore: true, navigation: false });
    return this._continueNavigation();
  }

  _finishNavigation() {
    const request = this.navigation;
    const id = this.navigationId;
    this.navigation = null;
    this._setPhase("idle");
    if (id === this.navigationId && !this.pausedForDismissal) request?.onComplete?.();
  }

  _continueNavigation() {
    const request = this.navigation;
    if (!request || this.pausedForDismissal) return false;
    const current = this.getCursor();
    if (current === request.target) {
      this._finishNavigation();
      return true;
    }
    if (this.getMotionMode() === "off" && typeof this.jumpToCursor === "function") {
      this.jumpToCursor(request.target);
      this._finishNavigation();
      return true;
    }

    const direction = Math.sign(request.target - current);
    const spec = this.getTurnSpec(direction);
    const step = Math.abs((spec?.destinationCursor ?? current) - current);
    if (!spec || !step || Math.abs(request.target - spec.destinationCursor) >= Math.abs(request.target - current)) {
      this.navigation = null;
      this._setPhase("idle");
      return false;
    }
    const remaining = Math.ceil(Math.abs(request.target - current) / step);
    const reduced = this.getMotionMode() === "reduced";
    if (request.stepDuration === null) {

      request.stepDuration = reduced
        ? Math.max(24, Math.min(65, 400 / Math.max(1, remaining - 1)))
        : Math.max(40, Math.min(130, 800 / Math.max(1, remaining - 1)));
    }
    const duration = remaining === 1 ? (reduced ? 120 : 240)
      : request.stepDuration * (request.turns === 0 ? 1.15 : 1);
    request.turns += 1;
    if (this.turn(direction, { duration, navigation: true })) return true;
    this.navigation = null;
    this._setPhase("idle");
    return false;
  }

  turn(direction, { duration, navigation = false } = {}) {
    if (this.pausedForDismissal || (this.isNavigating && !navigation)) return false;
    if (this.stage.dataset.cover === "moving" || this.coverPointer) return false;
    if (!this.getCoverOpen()) {
      if (direction > 0) this.openCover();
      return false;
    }
    if (this.phase === "dragging" || this.phase === "settling") return false;

    const spec = this.getTurnSpec(direction);
    if (!spec) {
      if (direction < 0) this.closeCover();
      return false;
    }
    const motionMode = this.getMotionMode();
    if (motionMode === "off") {
      this.cancelActiveTurn({ restore: true, navigation: false });
      this.showTransitionUnderlay(spec);
      this.commitTurn(spec);
      this._setPhase("idle");
      return true;
    }
    const canReusePreview = this.phase === "peeling"
      && this.activeTurn?.direction === spec.direction
      && this.activeTurn?.sourceCursor === spec.sourceCursor;
    if (!canReusePreview && !this._beginTurn(spec)) return false;
    this._cancelAnimation();
    if (motionMode === "reduced") {
      this._applyFoldState(this._stateForProgress(0.12));
    }
    this._settleTurn(true, { duration });
    return true;
  }

  inspect(direction, progress) {
    if (this.pausedForDismissal) return;
    if (!this.getCoverOpen() || this.phase === "settling" || this.coverPointer) return;
    const normalized = clamp01(progress);
    if (normalized <= 0) {
      this.cancelActiveTurn({ restore: true });
      return;
    }

    const spec = this.getTurnSpec(direction);
    if (!spec) return;
    const sameTurn = this.phase === "inspecting"
      && this.activeTurn?.direction === spec.direction
      && this.activeTurn?.sourceCursor === spec.sourceCursor;
    if (!sameTurn && !this._beginTurn(spec)) return;

    this._cancelAnimation();
    this._setPhase("inspecting");
    this._applyFoldState(this._stateForProgress(normalized));
  }

  _settleTurn(commit, { duration: requestedDuration } = {}) {
    if (!this.activeTurn || !this.visual || !this.activeFoldState) return;
    const motionMode = this.getMotionMode();
    const targetProgress = commit ? 1 : 0;
    const startProgress = this.activeFoldState.progress;
    const duration = requestedDuration ?? (motionMode === "reduced"
      ? 160
      : Math.max(220, 560 * Math.abs(targetProgress - startProgress)));
    const targetPoint = getFoldPointForProgress({
      ...this.visual.metrics,
      direction: this.activeTurn.direction,
      progress: targetProgress
    });
    this._animateFoldTo(targetPoint, {
      duration,
      phase: "settling",
      complete: () => this._completeTurn(commit)
    });
  }

  _animateFoldTo(targetPoint, {
    duration,
    phase,
    complete = null
  }) {
    if (!this.activeTurn || !this.visual || !this.activeFoldState) return;
    const startPoint = { ...this.activeFoldState.pointer };
    this._setPhase(phase);
    this._animate({
      from: 0,
      to: 1,
      duration,
      update: (progress) => {
        const point = interpolateFoldPoint(startPoint, targetPoint, progress);
        const state = createPageFoldState({
          ...this.visual.metrics,
          direction: this.activeTurn.direction,
          pointer: point
        });
        this._applyFoldState(state);
      },
      complete: () => complete?.()
    });
  }

  _completeTurn(committed) {
    const spec = this.activeTurn;
    this.visual?.destroy();
    this.visual = null;
    this.activeTurn = null;
    this.activeFoldState = null;
    this.previewDirection = null;
    delete this.stage.dataset.peel;
    if (spec) {
      if (committed) this.commitTurn(spec);
      else this.cancelTurn(spec);
    }
    if (this.isNavigating) {

      this._setPhase("navigating");
      this._continueNavigation();
    } else this._setPhase("idle");
  }

  openCover() {
    this.setCover(true);
  }

  closeCover() {
    this.setCover(false);
  }

  _beginCoverMotion() {
    if (this.stage.dataset.cover === "moving") return;
    const settingsPage = this.getFaceElement(0)?.querySelector?.(".nas-proto-setup-page");
    if (settingsPage?.getClientRects().length) this.coverScrollTop = settingsPage.scrollTop;
    this.stage.dataset.cover = "moving";
    this.prepareCover(this.coverScrollTop ?? 0);
  }

  setCover(open, { animate = true } = {}) {
    if (this.pausedForDismissal) return;
    const target = open ? 1 : 0;
    if (this.getCoverOpen() === open && this.coverProgress === target && this.stage.dataset.cover !== "moving") return;
    this.cancelActiveTurn({ restore: true, cover: false });
    this._releaseCoverPointer();
    const mode = this.getMotionMode();
    const duration = !animate || mode === "off" ? 0
      : (mode === "reduced" ? 180 : 650) * Math.abs(target - this.coverProgress);
    this._beginCoverMotion();
    this._setPhase("settling");
    this._animate({
      from: this.coverProgress,
      to: target,
      duration,
      update: (progress) => {
        this.coverProgress = progress;
        setPrototypeCoverProgress(this.stage, progress);
        this.onPhaseChange?.("cover", progress);
      },
      complete: () => {
        this._finishCover(open);
      }
    });
  }

  _onCoverPointerDown(event, { closing = false, toggleOnClick = true } = {}) {
    if (this.pausedForDismissal) return;
    if (event.button !== 0 || this.getCoverOpen() !== closing || this.getMotionMode() !== "full"
      || this.coverPointer || this.stage.dataset.cover === "moving"
      || this.phase === "dragging" || this.phase === "settling") return;
    if (closing && (isEditableTarget(event.target) || event.target?.closest?.(".nas-proto-setup-page"))) return;
    event.preventDefault();
    this.cancelActiveTurn({ restore: true });
    this._cancelAnimation();
    this.coverPointer = {
      id: event.pointerId,
      captureTarget: this.stage,
      startX: event.clientX,
      startY: event.clientY,
      startProgress: this.coverProgress,
      progress: this.coverProgress,
      closing,
      toggleOnClick,
      moved: false,
      distance: Math.max(180, this.root.querySelector("[data-proto-cover]")?.getBoundingClientRect().width
        ?? event.currentTarget.getBoundingClientRect().width)
    };
    this.stage.setPointerCapture?.(event.pointerId);
    this._beginCoverMotion();
    this._setPhase("dragging");
  }

  _onCoverPointerMove(event) {
    if (!this.coverPointer || event.pointerId !== this.coverPointer.id) return;
    const horizontal = this.coverPointer.startX - event.clientX;
    const progress = clamp01(this.coverPointer.startProgress + horizontal / this.coverPointer.distance);
    this.coverPointer.progress = progress;
    this.coverPointer.moved ||= Math.hypot(
      event.clientX - this.coverPointer.startX,
      event.clientY - this.coverPointer.startY
    ) > 5;
    this.coverProgress = progress;
    setPrototypeCoverProgress(this.stage, progress);
    this.onPhaseChange?.("cover", progress);
  }

  _onCoverPointerUp(event) {
    if (!this.coverPointer || event.pointerId !== this.coverPointer.id) return;
    event.preventDefault();
    const pointer = this.coverPointer;
    this._releaseCoverPointer();
    this.suppressClickUntil = performance.now() + 350;
    const open = !pointer.moved
      ? pointer.toggleOnClick ? !pointer.closing : pointer.closing
      : pointer.closing ? pointer.progress > 0.72 : pointer.progress >= 0.28;
    this.setCover(open);
  }

  _cancelCoverDrag() {
    if (!this.coverPointer) return;
    this._releaseCoverPointer();
    this.suppressClickUntil = performance.now() + 350;
    this.setCover(this.getCoverOpen());
  }

  _releasePointer(pointer) {
    if (!pointer) return;
    try {
      pointer.captureTarget?.releasePointerCapture?.(pointer.id);
    } catch (_error) {

    }
  }

  _releaseCoverPointer() {
    const pointer = this.coverPointer;
    this.coverPointer = null;
    this._releasePointer(pointer);
  }

  _finishCover(open) {
    this.coverProgress = open ? 1 : 0;
    setPrototypeCoverProgress(this.stage, this.coverProgress);
    this.stage.dataset.cover = open ? "open" : "closed";
    this.setCoverOpenState(open);
    this._setPhase("idle");
  }

  _animate({ from, to, duration, update, complete }) {
    this._cancelAnimation();
    if (this.pausedForDismissal) return;
    const token = ++this.animationToken;
    if (duration <= 0) {
      update(to);
      complete();
      return;
    }

    const ownerWindow = this.stage.ownerDocument?.defaultView;
    const frameWindow = typeof ownerWindow?.requestAnimationFrame === "function" ? ownerWindow : globalThis;
    this.frameWindow = frameWindow;
    const startTime = (frameWindow.performance ?? performance).now();
    const tick = (now) => {
      if (token !== this.animationToken) return;
      const elapsed = Math.max(0, now - startTime);
      const ratio = clamp01(elapsed / duration);
      const eased = easeInOutCubic(ratio);
      update(from + ((to - from) * eased));
      if (token !== this.animationToken || this.pausedForDismissal) return;
      if (ratio >= 1) {
        this.animationFrame = null;
        this.frameWindow = null;
        complete();
        return;
      }
      this.animationFrame = frameWindow.requestAnimationFrame(tick);
    };
    this.animationFrame = frameWindow.requestAnimationFrame(tick);
  }

  _cancelAnimation() {
    this.animationToken += 1;
    if (this.animationFrame !== null) {
      (this.frameWindow ?? globalThis).cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.frameWindow = null;
  }

  cancelActiveTurn({ restore = true, cover = true, navigation = true } = {}) {
    if (navigation) {
      this.navigation = null;
      this.navigationId += 1;
    }
    if (this.pausedForDismissal) return;
    if (cover && (this.coverPointer || this.stage.dataset.cover === "moving")) {
      this._cancelAnimation();
      this._releaseCoverPointer();
      this.suppressClickUntil = performance.now() + 350;
      this._finishCover(this.getCoverOpen());
    }
    const hasActivePageTurn = Boolean(this.pointer || this.visual || this.activeTurn);
    if (!hasActivePageTurn) {
      delete this.stage.dataset.peel;
      if (this.phase === "peeling" || this.phase === "inspecting"
        || (navigation && this.phase === "navigating")) this._setPhase("idle");
      return;
    }

    this._cancelAnimation();
    if (this.pointer) {
      this._releasePointer(this.pointer);
      this.pointer = null;
      this.suppressClickUntil = performance.now() + 250;
    }
    if (this.visual) {
      this.visual.destroy();
      this.visual = null;
    }
    this.activeFoldState = null;
    this.previewDirection = null;
    if (this.activeTurn) {
      const spec = this.activeTurn;
      this.activeTurn = null;
      if (restore) this.cancelTurn(spec);
    }
    delete this.stage.dataset.peel;
    this._setPhase("idle");
  }

  _setPhase(phase) {
    this.phase = phase;
    this.stage.dataset.phase = phase;
    this.onPhaseChange?.(phase, null);
  }

  destroyListeners() {
    for (const cleanup of this.cleanupCallbacks.splice(0)) cleanup();
  }

  pauseForDismissal() {
    this.navigation = null;
    this.navigationId += 1;
    this.pausedForDismissal = true;
    this.destroyListeners();
    this._cancelAnimation();
    const pointer = this.pointer;
    this.pointer = null;
    this._releasePointer(pointer);
    this._releaseCoverPointer();
  }

  destroy() {
    this.destroyListeners();
    this.pausedForDismissal = false;
    this.cancelActiveTurn({ restore: true });
    this._cancelAnimation();
  }
}
