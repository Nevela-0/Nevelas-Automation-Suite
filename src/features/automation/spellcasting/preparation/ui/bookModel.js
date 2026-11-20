import { spellbookText as t } from "../i18n.js";
export const PROTOTYPE_PAGE_SIZE = 10;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function levelLabel(level) {
  return level === 0 ? t("Cantrips") : t("Level {level}", { level });
}

function makeFace(kind, data = {}) {
  return {
    id: data.id ?? `${kind}-${data.index ?? "pending"}`,
    kind,
    hard: kind === "insideFront" || kind === "insideBack",
    blank: kind === "blank",
    content: kind === "content",
    title: "",
    subtitle: "",
    spells: [],
    ...data
  };
}

function addFace(faces, kind, data = {}) {
  const index = faces.length;
  const face = makeFace(kind, {
    ...data,
    id: data.id ?? `${kind}-${index}`,
    index,
    side: index % 2 === 0 ? "left" : "right"
  });
  faces.push(face);
  return face;
}

function groupSpellsByLevel(spells) {
  const groups = new Map();
  for (const spell of spells ?? []) {
    const level = Number.isInteger(Number(spell.level)) ? Number(spell.level) : 0;
    const group = groups.get(level) ?? [];
    group.push({ ...spell, level });
    groups.set(level, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, entries]) => ({
      level,
      label: levelLabel(level),
      spells: entries.sort((left, right) => left.name.localeCompare(right.name))
    }));
}

export function compilePrototypeBook(fixture, pageSize = PROTOTYPE_PAGE_SIZE) {
  const safePageSize = Math.max(1, Math.trunc(Number(pageSize) || PROTOTYPE_PAGE_SIZE));
  const faces = [];
  const bookmarks = [];
  let folio = 1;

  addFace(faces, "insideFront", {
    title: fixture.bookName,
    subtitle: t("{name}'s prepared spells", {name: fixture.actorName})
  });
  addFace(faces, "titlePage", {
    title: t("Prepared Spells"),
    subtitle: `${fixture.actorName} - ${fixture.castingMode}`
  });

  for (const group of groupSpellsByLevel(fixture.spells)) {
    if (faces.length % 2 === 1) {
      addFace(faces, "blank", {
        level: group.level,
        levelLabel: group.label
      });
    }

    const pageCount = Math.max(1, Math.ceil(group.spells.length / safePageSize));
    const bookmark = {
      id: `bookmark-${group.level}`,
      level: group.level,
      label: group.label,
      shortLabel: `${group.level}`,
      faceIndex: faces.length
    };
    bookmarks.push(bookmark);

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      addFace(faces, "content", {
        id: `level-${group.level}-page-${pageIndex + 1}`,
        title: group.label,
        subtitle: t("{mode} spellbook", {mode: fixture.castingMode}),
        level: group.level,
        levelLabel: group.label,
        pageNumber: pageIndex + 1,
        pageCount,
        folio,
        spells: group.spells.slice(pageIndex * safePageSize, (pageIndex + 1) * safePageSize)
      });
      folio += 1;
    }
  }

  if (faces.length % 2 === 0) {
    addFace(faces, "insideBack", {
      title: t("End of prepared spells"),
      subtitle: fixture.bookName
    });
  } else {
    addFace(faces, "blank", { title: t("Endpaper") });
    addFace(faces, "insideBack", {
      title: t("End of prepared spells"),
      subtitle: fixture.bookName
    });
  }
  if (faces.length % 2 === 1) addFace(faces, "blank", { title: t("Rear endpaper") });

  return {
    id: `prototype-${fixture.key}`,
    fixtureKey: fixture.key,
    actorName: fixture.actorName,
    bookName: fixture.bookName,
    castingMode: fixture.castingMode,
    pageSize: safePageSize,
    faces,
    bookmarks,
    spells: fixture.spells.map((spell) => ({ ...spell })),
    contentFaces: faces.filter((face) => face.content)
  };
}

export function normalizePrototypeCursor(book, cursor, displayMode = "wide") {
  const maxIndex = Math.max(0, book.faces.length - 1);
  const normalized = clamp(Math.trunc(Number(cursor) || 0), 0, maxIndex);
  if (displayMode === "single") return normalized;
  return Math.floor(normalized / 2) * 2;
}

export function getPrototypeView(book, cursor, displayMode = "wide") {
  const normalized = normalizePrototypeCursor(book, cursor, displayMode);
  if (displayMode === "single") {
    return {
      cursor: normalized,
      faceIndexes: [normalized],
      left: null,
      right: book.faces[normalized] ?? null
    };
  }

  return {
    cursor: normalized,
    faceIndexes: [normalized, normalized + 1].filter((index) => index < book.faces.length),
    left: book.faces[normalized] ?? null,
    right: book.faces[normalized + 1] ?? null
  };
}

export function movePrototypeCursor(book, cursor, displayMode, direction) {
  const current = normalizePrototypeCursor(book, cursor, displayMode);
  const step = displayMode === "single" ? 1 : 2;
  const candidate = current + (direction < 0 ? -step : step);
  return normalizePrototypeCursor(book, candidate, displayMode);
}

export function canMovePrototypeCursor(book, cursor, displayMode, direction) {
  const current = normalizePrototypeCursor(book, cursor, displayMode);
  return movePrototypeCursor(book, current, displayMode, direction) !== current;
}

export function getPrototypeTurnSpec(book, cursor, displayMode, direction) {
  if (!canMovePrototypeCursor(book, cursor, displayMode, direction)) return null;

  const sourceCursor = normalizePrototypeCursor(book, cursor, displayMode);
  const destinationCursor = movePrototypeCursor(book, sourceCursor, displayMode, direction);
  const sourceView = getPrototypeView(book, sourceCursor, displayMode);
  const destinationView = getPrototypeView(book, destinationCursor, displayMode);
  const forward = direction > 0;

  if (displayMode === "single") {
    return {
      direction: forward ? 1 : -1,
      sourceCursor,
      destinationCursor,
      sourceView,
      destinationView,
      turningFaceIndex: sourceView.faceIndexes[0],
      backFaceIndex: destinationView.faceIndexes[0]
    };
  }

  return {
    direction: forward ? 1 : -1,
    sourceCursor,
    destinationCursor,
    sourceView,
    destinationView,
    turningFaceIndex: forward ? sourceView.right?.index : sourceView.left?.index,
    backFaceIndex: forward ? destinationView.left?.index : destinationView.right?.index
  };
}

export function createPrototypeDraft(book) {
  return new Map(book.spells.map((spell) => [spell.id, Math.max(0, Number(spell.prepared) || 0)]));
}

export function serializePrototypeDraft(book, draft) {
  return book.spells.map((spell) => ({
    id: spell.id,
    prepared: Math.max(0, Math.trunc(Number(draft.get(spell.id)) || 0))
  }));
}
