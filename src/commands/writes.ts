// Record writes only. A preview never opens a session or reads the account.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandInput } from '../cli/table.ts';
import { readSettings } from '../config.ts';
import { usage } from '../errors.ts';
import { isWrite, type Write, writeBody } from '../http.ts';
import { visibleString } from '../output/text.ts';
import { FULL_LIMIT, render } from '../output/toon.ts';
import { normalizePlate } from '../plates.ts';
import { open } from './common.ts';

export type WriteKind = 'place' | 'alert' | 'group';
const ACTIONS: Record<WriteKind, readonly string[]> = {
  place: ['add', 'edit', 'remove'],
  alert: ['add', 'edit', 'remove', 'custom'],
  group: ['add', 'edit', 'members', 'remove'],
};

export function writeAction(kind: string, action: string | undefined): boolean {
  return (
    Object.hasOwn(ACTIONS, kind) &&
    ACTIONS[kind as WriteKind].includes(action ?? '')
  );
}

function bodyOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string')
    throw usage('Give --body <JSON|@file> for this write.');
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch {
      throw usage('The --body file could not be read.');
    }
  }
  if (Buffer.byteLength(text) > FULL_LIMIT)
    throw usage('The write body exceeds 256 KB. Send fewer fields or records.');
  let body: unknown;
  try {
    body = JSON.parse(text, (_key, value) => {
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        throw new Error('number');
      return value;
    });
  } catch {
    throw usage(
      '--body must be valid JSON with exact, safe numbers. Quote larger IDs.',
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.keys(body).length
  )
    throw usage('--body must be a nonempty JSON object.');
  return body as Record<string, unknown>;
}

/** An ASCII JSON string preserves even invisible text exactly in the preview. */
function exactJson(body: unknown): string {
  const json = JSON.stringify(body);
  if (visibleString(json) === '[withheld: looks like a credential]')
    throw usage(
      'The write body looks like it contains a credential. Remove it.',
    );
  return writeBody(body);
}

export async function writeRecord(
  kind: WriteKind,
  input: CommandInput,
): Promise<string> {
  const [action, id] = input.positionals;
  const v = input.values;
  if (!writeAction(kind, action))
    throw usage(`Use ${kind} ${ACTIONS[kind].join('|')}.`);
  if (v.full || v.refresh || v.vehicles)
    throw usage('Read flags cannot be used with a write.');
  if (v.confirm && v['dry-run'])
    throw usage('Choose --dry-run or --confirm, not both.');
  if (action === 'add' ? id !== undefined : !id || !/^\d{1,20}$/.test(id))
    throw usage(
      action === 'add'
        ? 'An add takes no record id.'
        : 'Give the numeric record id after the action.',
    );
  if (kind !== 'alert' && v.plate)
    throw usage('--plate applies only to alerts.');
  if (action === 'custom' && v.plate)
    throw usage('A custom alert change takes no --plate.');
  const settings = readSettings(input.io.env);
  if (settings.basePath !== '/api/v2')
    throw usage('Record writes require an /api/v2 API root.');
  const base =
    kind === 'place'
      ? '/places'
      : kind === 'group'
        ? '/vehicle-groups'
        : action === 'custom'
          ? '/alerts/custom'
          : typeof v.plate === 'string'
            ? `/vehicles/${normalizePlate(v.plate)}/alerts`
            : '/alerts';
  const method =
    action === 'add'
      ? 'POST'
      : action === 'remove'
        ? 'DELETE'
        : action === 'members'
          ? 'PATCH'
          : 'PUT';
  if (method === 'DELETE' && v.body !== undefined)
    throw usage('A remove takes no --body.');
  const request: Write = {
    method,
    path: `/api/v2${base}${id === undefined ? '' : `/${id}`}`,
    ...(method !== 'DELETE' ? { body: bodyOf(v.body) } : {}),
  };
  if (!isWrite(method, request.path)) throw usage('Unsupported record write.');
  const bodyJson =
    request.body === undefined ? undefined : exactJson(request.body);
  const preview = render(
    {
      summary: 'Dry run: no request sent',
      method,
      url: `${settings.origin}${request.path}`,
      ...(bodyJson === undefined
        ? {}
        : { content_type: 'application/json', body_json: bodyJson }),
    },
    [
      'Run the same command with --confirm instead of --dry-run to send it once',
    ],
  );
  if (Buffer.byteLength(preview) > FULL_LIMIT)
    throw usage(
      'The complete write preview exceeds 256 KB. Send fewer fields or records.',
    );
  if (v.confirm !== true) return preview;
  const ctx = open(input);
  const response = await ctx.client.write(request);
  if (kind === 'place') {
    // Best effort: a successful write must not be replaced by a cache error.
    try {
      rmSync(join(ctx.dir, 'places.json'), { force: true });
    } catch {
      /* stale cache can be refreshed */
    }
  }
  return render({
    summary: 'Write sent once',
    method,
    path: request.path,
    response: response ?? null,
  });
}
