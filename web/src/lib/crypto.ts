// Per-clip encryption, entirely in the browser (WebCrypto).
// A fresh AES-256-GCM key per clip. The clip never leaves the device unencrypted; the key is
// handed to the Tide network to wrap under the vault policy (see vault.ts).

export const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptClip(plain: Uint8Array) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return { iv: b64(iv), ciphertext: b64(ct), rawKey: b64(rawKey) };
}

export async function decryptClip(ciphertextB64: string, ivB64: string, rawKeyB64: string) {
  const key = await crypto.subtle.importKey("raw", unb64(rawKeyB64), { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, unb64(ciphertextB64)));
}
