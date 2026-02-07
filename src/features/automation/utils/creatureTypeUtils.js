export function getAlignmentValue(alignment) {
  return (alignment ?? "").toString().toLowerCase();
}

export function getCreatureTypeValues(actor) {
  const values = new Set();
  const addValue = (value) => {
    const text = value?.toString?.().trim();
    if (text) values.add(text.toLowerCase());
  };

  const types = actor?.system?.traits?.creatureTypes;
  const standard = types?.standard;
  if (standard?.forEach) {
    standard.forEach((entry) => addValue(entry));
  }
  const total = types?.total;
  if (total?.forEach) {
    total.forEach((entry) => addValue(entry));
  }
  const names = types?.names ?? [];
  if (Array.isArray(names)) {
    names.forEach((entry) => addValue(entry));
  }

  const classes = actor?.classes ?? {};
  Object.values(classes).forEach((entry) => {
    if (!entry) return;
    addValue(entry?.name);
    addValue(entry?._id);
  });

  return Array.from(values);
}
