// The closed set of error codes and the classifier for HTTP answers from
// Ituran and from the Comis Gate in front of it. Ituran uses 403 for "not in
// this account", "not entitled" and "feature off", never for a bad token; only
// 401 means the credential was refused.

export type ErrorCode =
  | 'usage'
  | 'not_connected'
  | 'auth_failed'
  | 'two_step_required'
  | 'access_blocked'
  | 'reconnect_needed'
  | 'refused'
  | 'not_visible'
  | 'not_entitled'
  | 'feature_off'
  | 'needs_app_id'
  | 'not_found'
  | 'not_tracked'
  | 'rejected'
  | 'rate_limited'
  | 'ituran_error'
  | 'unreachable'
  | 'output_too_large'
  | 'internal_error';

export type ErrorFields = Record<string, string | number>;

export class AxiError extends Error {
  readonly code: ErrorCode;
  readonly fields: ErrorFields;

  constructor(code: ErrorCode, message: string, fields: ErrorFields = {}) {
    super(message);
    this.name = 'AxiError';
    this.code = code;
    this.fields = fields;
  }

  get exitCode(): 1 | 2 {
    return this.code === 'usage' ? 2 : 1;
  }
}

export const usage = (message: string): AxiError =>
  new AxiError('usage', message);

export interface Answer {
  status: number;
  headers: Headers;
  json: unknown;
  bytes: number;
  ms: number;
}

export interface ClassifyContext {
  /** What was read, for messages: "temperature sensors (ITC)", "trips". */
  what?: string;
  plate?: string;
  /** The trips service answers 404.1 for a plate it keeps no trips for. */
  trips?: boolean;
}

/** Ituran's error codes: the top-level one and any nested in errors[]. */
export function ituranCodes(json: unknown): string[] {
  const out: string[] = [];
  if (!json || typeof json !== 'object') return out;
  const j = json as Record<string, unknown>;
  for (const key of ['error_code', 'errorCode']) {
    const v = j[key];
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
  }
  if (Array.isArray(j.errors)) {
    for (const e of j.errors) {
      const c =
        e && typeof e === 'object'
          ? ((e as Record<string, unknown>).error_code ??
            (e as Record<string, unknown>).code)
          : undefined;
      if (typeof c === 'string' || typeof c === 'number') out.push(String(c));
    }
  }
  return out;
}

/** Ituran's own words: the description and any nested field messages. */
export function ituranMessage(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const j = json as Record<string, unknown>;
  const parts: string[] = [];
  const top = j.error_description ?? j.errorDescription ?? j.message;
  if (typeof top === 'string' && top.trim()) parts.push(top.trim());
  if (Array.isArray(j.errors)) {
    for (const e of j.errors) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      const text = r.error_description ?? r.description ?? r.message;
      if (typeof text === 'string' && text.trim()) parts.push(text.trim());
    }
  } else if (j.errors && typeof j.errors === 'object') {
    for (const [field, m] of Object.entries(j.errors)) {
      parts.push(`${field}: ${Array.isArray(m) ? m.join(', ') : String(m)}`);
    }
  }
  return parts.length ? parts.join(' ') : undefined;
}

const GATE_REFUSALS: Record<string, string> = {
  secret_response:
    "The Gate withheld Ituran's answer because it carried a credential.",
  out_of_budget:
    'The Gate refused this request: the spending budget is used up.',
};

export function classify(
  answer: Answer,
  ctx: ClassifyContext = {},
): AxiError | null {
  const { status, headers, json } = answer;
  if (status >= 200 && status < 300) return null;
  const refusal = headers.get('comis-refusal');
  if (refusal === 'reconnect_needed') {
    return new AxiError(
      'reconnect_needed',
      'Ituran refused the stored sign-in. Ask the owner to reconnect Ituran.',
    );
  }
  if (refusal) {
    return new AxiError(
      'refused',
      GATE_REFUSALS[refusal] ?? `The Gate refused this request (${refusal}).`,
      { refusal },
    );
  }
  const codes = ituranCodes(json);
  const said = ituranMessage(json);
  const ituran = said ? { ituran: said } : {};
  const plate = ctx.plate ? { plate: ctx.plate } : {};
  const what = ctx.what ?? 'this';
  if (status === 474) {
    return new AxiError(
      'access_blocked',
      "Ituran's access protection blocked this computer's address. Do not retry; ask the owner to have Ituran review it.",
    );
  }
  if (status === 401) {
    return new AxiError(
      'auth_failed',
      'Ituran refused the sign-in. Check ITURAN_USERNAME and ITURAN_PASSWORD, or ITURAN_TOKEN.',
    );
  }
  if (status === 403) {
    if (codes.includes('1020')) {
      const who = ctx.plate ? `Vehicle ${ctx.plate} is` : 'This vehicle is';
      return new AxiError(
        'not_visible',
        `${who} not in this account, or this user cannot see it. Find it with \`ituran-axi vehicles <text>\`.`,
        plate,
      );
    }
    if (codes.includes('403.2')) {
      return new AxiError(
        'feature_off',
        said ?? `Ituran has not turned on ${what} for this account.`,
        ituran,
      );
    }
    return new AxiError(
      'not_entitled',
      `This Ituran account does not include ${what}. Do not retry; tell the owner if they need it.`,
      { status, ...ituran },
    );
  }
  if (codes.includes('1032')) {
    return new AxiError(
      'needs_app_id',
      `Ituran answers ${what} only for a token with an app registration, which this one lacks.`,
      ituran,
    );
  }
  if (status === 404) {
    if (ctx.trips && codes.includes('404.1')) {
      return new AxiError(
        'not_tracked',
        `Ituran keeps no trips for ${ctx.plate ?? 'this vehicle'}, as for trailers and units without trip tracking.`,
        { ...plate, ...ituran },
      );
    }
    return new AxiError(
      'not_found',
      said ? `Ituran found no ${what}: ${said}` : `Ituran found no ${what}.`,
      plate,
    );
  }
  if (status === 429 || status === 481) {
    return new AxiError(
      'rate_limited',
      'Ituran is limiting requests. Wait a minute, then run the command again.',
      { status },
    );
  }
  if (status >= 400 && status < 500) {
    return new AxiError(
      'rejected',
      said ?? `Ituran refused the request (${status}) with no message.`,
      { status, ...(codes.length ? { codes: codes.join(' ') } : {}) },
    );
  }
  if (status === 502 && !said) {
    return new AxiError(
      'unreachable',
      'Ituran, or the Gate in front of it, could not be reached (502).',
    );
  }
  return new AxiError(
    'ituran_error',
    said ?? `Ituran failed with ${status} and no message.`,
    { status },
  );
}
