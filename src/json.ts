// JSON.parse rounds integers beyond 2^53 - 1, and Ituran sends such values:
// keypad driver codes and some IDs. Integer tokens that would not survive the
// round trip are quoted first, so they arrive as exact digit strings.
// Floats, exponents, short integers and digits inside strings are untouched.

export function parseJson(text: string): unknown {
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  return JSON.parse(quoteUnsafeIntegers(text));
}

export function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < text.length && /[0-9eE+\-.]/.test(text[j] as string)) j++;
      const token = text.slice(i, j);
      out +=
        /^-?\d{16,}$/.test(token) && String(Number(token)) !== token
          ? `"${token}"`
          : token;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
