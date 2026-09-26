/**
 * Some multipart parsers expose non-ASCII upload names as Latin-1 bytes.
 * Repair only the recognizable UTF-8-as-Latin-1 form so valid names are untouched.
 */
export function displayFilename(value: string) {
  if (!value || [...value].some((character) => (character.codePointAt(0) ?? 0) > 0xff)) return value;
  const repaired = Buffer.from(value, "latin1").toString("utf8");
  return !repaired.includes("\ufffd") && /[\u3400-\u9fff]/u.test(repaired) ? repaired : value;
}
