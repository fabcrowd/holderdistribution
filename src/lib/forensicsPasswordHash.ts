/**
 * SHA-256 of the Supply forensics gate password. The Netlify function checks this
 * hash so no dashboard env var is required — rotating the password means updating
 * this constant (and telling users).
 *
 * Do not read this as "the plaintext is safe": an earlier version of this comment
 * claimed the plaintext was never stored in the repo, and it is — in a commit body
 * in git history. The repo is private, so exposure is bounded, but the hash is a
 * plain unsalted SHA-256 of a short human password and is trivially brute-forced
 * offline by anyone who obtains it. It is deliberately kept out of the client
 * bundle (verified: absent from dist/) and lives only in the server-side function.
 * Treat this gate as "keeps the content off the public web", not as real secrecy.
 */
export const FORENSICS_PASSWORD_SHA256 =
  "dc1303c56ee8888310bd0560f5d0cb93a3e3ba4653630d6824aa56ba7c0463d8";

export const forensicsPasswordMatches = async (password: string): Promise<boolean> => {
  if (!password) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex === FORENSICS_PASSWORD_SHA256;
};
