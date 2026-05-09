export function createNasId(length = 16) {
  const size = Number.isFinite(Number(length)) ? Math.max(1, Math.floor(Number(length))) : 16;
  const randomId = globalThis.foundry?.utils?.randomID;
  if (typeof randomId === "function") return randomId(size);

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) {
    const values = new Uint8Array(size);
    crypto.getRandomValues(values);
    for (const value of values) out += alphabet[value % alphabet.length];
    return out;
  }
  for (let i = 0; i < size; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function ensureNasId(value, length = 16) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : createNasId(length);
}
