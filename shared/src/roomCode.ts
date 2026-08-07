/**
 * Room codes are read aloud across a room (§8), so the alphabet drops every character
 * that gets misheard or misread: 0/O, 1/I/L, and U (which people hear as "you").
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 4;

/** Uppercase, strip anything not in the alphabet. Lets people type "abc-d" or "abcd ". */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, CODE_LENGTH);
}

export function isValidCode(input: string): boolean {
  return normalizeCode(input).length === CODE_LENGTH;
}
