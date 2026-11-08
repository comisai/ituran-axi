// drivers and driver. Phone numbers and e-mail addresses are personal data:
// they appear only with --fields or --full. A name search reads the driver
// list live; nothing about drivers is written to disk.

import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import {
  api,
  columnsFlag,
  countLine,
  type FetchPage,
  intFlag,
  listOutput,
  open,
  type Row,
  recordOutput,
  rowsOf,
  shellWord,
  str,
  totalOf,
  walkAll,
  windowRows,
} from './common.ts';

/** The driver list takes pages of at most 1,000 rows. */
const DRIVER_PAGE = 1000;

function driverRow(d: Row): Row {
  const name = [str(d.first_name), str(d.last_name)]
    .filter((p) => p?.trim())
    .join(' ');
  return {
    id: d.driver_id ?? null,
    name: name || null,
    code: d.driver_code ?? null,
    blocked: typeof d.is_blocked === 'boolean' ? d.is_blocked : null,
    managed_code: d.managed_code ?? null,
    phone: str(d.phone) || str(d.cellular) || null,
    email: str(d.email) ?? null,
  };
}

const KNOWN = [
  'id',
  'name',
  'code',
  'blocked',
  'managed_code',
  'phone',
  'email',
];

export async function drivers(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const { values } = input;
  const limit = intFlag(values.limit, 'limit', 20, 1, DRIVER_PAGE);
  const page = intFlag(values.page, 'page', 1, 1, 100_000);
  const columns = columnsFlag(
    values.fields,
    ['id', 'name', 'code', 'blocked'],
    KNOWN,
  );
  const text = input.positionals.join(' ').trim();
  const fetchPage: FetchPage = async (page_number, page_size) => {
    const json = await ctx.client.read({
      method: 'GET',
      path: api(ctx, '/drivers'),
      query: { page_number, page_size },
      ctx: { what: 'drivers' },
      emptyOn404: true,
    });
    return {
      rows: rowsOf(json, 'drivers'),
      total: json === null ? 0 : totalOf(json),
    };
  };
  let rows: Row[];
  let total: number | null;
  let partial: string | undefined;
  if (text) {
    const all = await walkAll(fetchPage, DRIVER_PAGE);
    const needle = text.toLowerCase();
    const hits = all.rows
      .map(driverRow)
      .filter((d) =>
        [d.name, d.code, d.managed_code].some(
          (v) => v !== null && String(v).toLowerCase().includes(needle),
        ),
      );
    total = hits.length;
    rows = hits.slice((page - 1) * limit, page * limit);
    partial = all.partial;
  } else {
    const got = await windowRows(fetchPage, page, limit);
    rows = got.rows.map(driverRow);
    total = got.total;
  }
  const shownTo = (page - 1) * limit + rows.length;
  const help: string[] = [];
  if (total !== null && shownTo < total) {
    help.push(
      `Run \`ituran-axi drivers ${[...(text ? [shellWord(text)] : []), '--page', String(page + 1), ...(limit !== 20 ? ['--limit', String(limit)] : [])].join(' ')}\` for the next ${Math.min(limit, total - shownTo)}`,
    );
  }
  if (rows.length) help.push('Run `ituran-axi driver <id>` for one driver');
  return listOutput({
    key: 'drivers',
    summary: rows.length
      ? `${countLine(rows.length, total, 'driver')}${text ? ` matching "${text}"` : ''}`
      : `0 drivers${text ? ` match "${text}"` : ''}`,
    head: partial ? { partial } : {},
    rows,
    columns,
    help,
    full: values.full === true,
    narrower: 'ituran-axi drivers <text>',
  });
}

export async function driver(input: CommandInput): Promise<string> {
  const ctx = open(input);
  const id = input.positionals[0] as string;
  if (!/^\d{1,20}$/.test(id))
    throw usage('A driver id is a number, as `ituran-axi drivers` lists it.');
  const full = input.values.full === true;
  const d = (await ctx.client.read({
    method: 'GET',
    path: api(ctx, `/drivers/${id}`),
    ctx: { what: `driver ${id}` },
  })) as Row | null;
  if (!d || typeof d !== 'object')
    throw new AxiError('ituran_error', 'Ituran sent no driver.');
  const r = driverRow(d);
  return recordOutput(
    {
      id: r.id,
      name: r.name,
      code: r.code,
      managed_code: r.managed_code,
      blocked: r.blocked,
      ...(full
        ? {
            phone: d.phone,
            cellular: d.cellular,
            email: d.email,
            identification_number: d.identification_number,
          }
        : {}),
    },
    full,
    `ituran-axi driver ${id}`,
  );
}
