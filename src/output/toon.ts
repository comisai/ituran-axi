// TOON output on stdout, from the official encoder pinned exactly, with the
// AXI help footer and the size bounds Comis uses for model-facing output.

import { encode } from '@toon-format/toon';
import { AxiError, type ErrorFields } from '../errors.ts';
import { visible } from './text.ts';

/** A long field is cut to this many code points unless --full. */
export const FIELD_LIMIT = 500;
/** Default output fits this many UTF-16 units. */
export const OUTPUT_LIMIT = 4000;
/** --full output fits this many encoded bytes. */
export const FULL_LIMIT = 262144;

export type Doc = Record<string, unknown>;

/** The indented help footer that follows the encoded body as AXI text. */
export function helpBlock(lines: readonly string[]): string {
  if (!lines.length) return '';
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}\n`).join('')}`;
}

/** Encode a document (made visible first) and append help lines. */
export function render(doc: Doc, help: readonly string[] = []): string {
  return `${encode(visible(doc) as Parameters<typeof encode>[0])}\n${helpBlock(help)}`;
}

/** Cut text to `limit` code points with the standard marker naming its size. */
export function cut(text: string, limit: number = FIELD_LIMIT): string {
  const points = [...text];
  if (points.length <= limit) return text;
  return `${points.slice(0, limit).join('')} … (truncated, ${points.length} code points total; use --full to see all)`;
}

export interface BoundedView {
  /** Number of rows in the complete answer. */
  total: number;
  /** Render with the first `shown` rows and every long field cut to `fieldLimit`. */
  build: (shown: number, fieldLimit: number) => string;
  /** The command that reads more, named when the full read is too large. */
  narrower: string;
}

/**
 * Fit a view into the default bound by first shortening long fields, then
 * dropping trailing rows (the builder reports what it dropped). With --full,
 * allow up to FULL_LIMIT encoded bytes and refuse beyond that.
 */
export function bounded(view: BoundedView, full: boolean): string {
  if (full) {
    const text = view.build(view.total, Number.POSITIVE_INFINITY);
    const bytes = Buffer.byteLength(text);
    if (bytes > FULL_LIMIT) {
      throw new AxiError(
        'output_too_large',
        `The full output is ${bytes} encoded bytes; the limit is ${FULL_LIMIT}. Read less with ${view.narrower}.`,
        { bytes, limit: FULL_LIMIT },
      );
    }
    return text;
  }
  let fieldLimit = FIELD_LIMIT;
  let text = view.build(view.total, fieldLimit);
  if (text.length <= OUTPUT_LIMIT) return text;
  while (
    fieldLimit > 16 &&
    view.build(Math.min(1, view.total), fieldLimit).length > OUTPUT_LIMIT
  ) {
    fieldLimit = Math.floor(fieldLimit / 2);
  }
  text = view.build(view.total, fieldLimit);
  if (text.length <= OUTPUT_LIMIT) return text;
  let low = 0;
  let high = view.total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (view.build(mid, fieldLimit).length <= OUTPUT_LIMIT) low = mid;
    else high = mid - 1;
  }
  return view.build(low, fieldLimit);
}

/** The error record on stdout: message, code, usage, then extra fields. */
export function errorText(error: AxiError, usageLine: string): string {
  const extra: ErrorFields = {};
  for (const [k, v] of Object.entries(error.fields)) {
    if (k !== 'message' && k !== 'code' && k !== 'usage')
      extra[k] = typeof v === 'string' ? cut(v) : v;
  }
  return render({
    message: cut(error.message),
    code: error.code,
    usage: usageLine,
    ...extra,
  });
}
