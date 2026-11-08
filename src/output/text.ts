// Text from Ituran is data written by people: names, notes, event titles and
// addresses. Before printing:
// - invisible and control characters are shown as visible \uXXXX escapes
//   so bidirectional overrides cannot hide or reorder text;
// - unpaired surrogates become U+FFFD;
// - a value that looks like a credential is withheld.
// Hebrew and other ordinary text is kept as it is.

// Kept as escape text, never as literal characters: they are invisible in source.
const INVISIBLE = '\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2800';
const ESCAPE = new RegExp(
  String.raw`[${INVISIBLE}]|(?![\n\t])[\p{Cc}\p{Zl}\p{Zp}]`,
  'gu',
);
const STRIP = new RegExp(`[${INVISIBLE}]`, 'gu');
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Checked on the text with invisible characters removed, so a token split by
// zero-width characters is still found.
const CREDENTIAL = new RegExp(
  [
    String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]{8,}`,
    String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
    String.raw`\bAKIA[A-Z0-9]{16}\b`,
    String.raw`\bghp_[A-Za-z0-9]{36}\b`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{82}\b`,
    String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}`,
    '(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  ].join('|'),
);

export const WITHHELD = '[withheld: looks like a credential]';
const REPLACEMENT = String.fromCodePoint(0xfffd);

const hex = (unit: number) => `\\u${unit.toString(16).padStart(4, '0')}`;

export function visibleString(value: string): string {
  if (CREDENTIAL.test(value.replace(STRIP, ''))) return WITHHELD;
  return value.replace(LONE_SURROGATE, REPLACEMENT).replace(ESCAPE, (ch) =>
    ch
      .split('')
      .map((u) => hex(u.charCodeAt(0)))
      .join(''),
  );
}

/** Deep copy with every string (keys included) made visible. */
export function visible<T>(value: T): T {
  if (typeof value === 'string') return visibleString(value) as T;
  if (Array.isArray(value)) return value.map((v) => visible(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        visibleString(k),
        visible(v),
      ]),
    ) as T;
  }
  return value;
}
