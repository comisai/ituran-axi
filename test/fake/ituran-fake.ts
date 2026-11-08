// A fake Ituran that answers the way production answered on 2026-11-08
// (docs/ituran-axi-implementation-plan.md §2): the identity grants, a missing
// Authorization header as 400, paging envelopes (drivers at the top level),
// 404 404.3 for a search with no match, 404.1 for a plate without trips, 403
// codes, date-only bounds on trip totals, the inclusive report cursor, and the
// access-protection and pressure answers. Neutral data only.
//
// Run: node test/fake/ituran-fake.ts [port]   (prints "fake on <port>")
// User user_a, password secret-pass.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;

export interface FakeOptions {
  user?: string;
  password?: string;
  /** Answer every grant with 474, as the access protection does. */
  blocked?: boolean;
  /** Answer the password grant with no token, as for a two-step account. */
  twoStep?: boolean;
  /** Answer the first API read with 481. */
  pressureOnce?: boolean;
  /** Act as the Comis Gate whose stored sign-in Ituran refused. */
  reconnect?: boolean;
  /** Include the temperature sensors (ITC) service. */
  temps?: boolean;
  /** A bearer token accepted without a grant, as the Gate's placeholder is. */
  token?: string;
  port?: number;
}

export interface FakeState {
  requests: Array<{ method: string; path: string; auth?: string }>;
  grants: { password: number; refresh: number };
}

const RLO = String.fromCodePoint(0x202e);
const NOW = '2026-11-08T12:00:00';

/** The real time now in the account's zone, as Ituran's naive local text. */
function localNow(): string {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return f.format(new Date()).replace(' ', 'T');
}

export const PLATES = [
  '12345678',
  '23456789',
  '34567890',
  '45678901',
  '56789012',
  '6789012',
  '78901234',
  '89012345',
  '90123456',
  '11223344',
  '22334455',
  '33445566',
];
export const NOT_TRACKED = '99887766';

function vehicle(plate: string, i: number): Row {
  return {
    license_plate: plate,
    vehicle_id: 1000 + i,
    vin: `VIN${i}`,
    nickname: i === 1 ? 'משאית 2' : i === 2 ? `Van ${RLO}3` : `Van ${i}`,
    model_name: i % 2 ? 'Transit' : 'Corolla',
    make_name: i % 2 ? 'Ford' : 'Toyota',
    model_year: i === 3 ? '0' : '2022',
    color: i % 3 ? 'white' : 'red',
    motion_status: i % 4 === 0 ? 'driving' : 'parking',
    telematics_units: [{ ip_address: '10.0.0.1' }],
  };
}

const VEHICLES = [...PLATES, NOT_TRACKED].map(vehicle);

function realtime(v: Row, i: number, fields: string[]): Row {
  const out: Row = { ...v };
  if (fields.includes('LastLocation')) {
    out.last_location = {
      location: {
        point: { lat: 32.08 + i / 100, lon: 34.78 },
        // One address is long enough to be cut.
        address: {
          location:
            i === 5 ? 'Long Road '.repeat(65) : `${i} Example Street, Tel Aviv`,
          speedlimit: 50,
        },
      },
      odometer: 1000 * i,
      speed: i % 4 === 0 ? 62 : 0,
      heading: 90,
      // The last vehicle was last seen two days ago.
      timestamp:
        i === VEHICLES.length - 1
          ? '2026-11-06T11:00:00'
          : '2026-11-08T11:57:00',
    };
  }
  if (fields.includes('Driver') && i % 2 === 0) {
    out.current_driver = {
      driver_id: 500 + i,
      first_name: 'Driver',
      last_name: `D${i}`,
      phone: '050-0000000',
      cellular: '',
    };
  }
  if (fields.includes('Places'))
    out.places = i < 3 ? [{ place_name: 'Depot', place_id: 77 }] : [];
  return out;
}

const DRIVERS = Array.from({ length: 25 }, (_, i) => ({
  driver_id: 500 + i,
  first_name: i === 4 ? 'דנה' : 'Driver',
  last_name: `D${i}`,
  identification_number: '000000000',
  driver_code: i === 7 ? '3816028517986434181' : 100 + i,
  managed_code: 0,
  phone: '050-0000000',
  cellular: '',
  email: 'driver@example.com',
  is_blocked: i === 3,
}));

const PLACES = Array.from({ length: 14 }, (_, i) => ({
  place_id: i === 0 ? 77 : 100 + i,
  layer_id: 1,
  name: i === 0 ? 'Depot' : i === 5 ? 'מחסן מרכזי' : `Site ${i}`,
  description: i === 0 ? 'Main depot' : '',
  place_type: i % 2 ? 'Area' : 'Landmark',
  point: { lat: 32, lon: 34.8 },
  radius: 150,
  points: Array.from({ length: 30 }, () => ({ lat: 32, lon: 34.8 })),
}));

function trip(id: number, plate: string, day: string, hour: number): Row {
  const h = String(hour).padStart(2, '0');
  return {
    trip_id: id,
    license_plate: plate,
    driver_code: 105,
    driver_name: 'Driver D5',
    driver_source: 1,
    start_location: {
      location: {
        point: { lat: 32, lon: 34.8 },
        address: { location: 'Start Street 1, Haifa', speedlimit: 50 },
      },
      odometer: 1000,
      timestamp: `${day}T${h}:00:00`,
    },
    end_location: {
      location: {
        point: { lat: 32.1, lon: 34.9 },
        address: { location: 'End Street 2, Haifa', speedlimit: 50 },
      },
      odometer: 1012.5,
      timestamp: `${day}T${h}:30:00`,
    },
    duration_in_seconds: 1800,
    distance: 12.46,
    max_speed: 88,
    idle_duration_in_minutes: 4,
    safety: { safety_grade: 90, fuel_grade: 80, safety_events_count: 1 },
    trip_status: 'trip_end',
  };
}

const TRIPS = [
  ...Array.from({ length: 12 }, (_, i) =>
    trip(5000 + i, PLATES[0] as string, '2026-11-07', 6 + i),
  ),
  trip(6000, PLATES[1] as string, '2026-11-08', 9),
];

const RECORDS = Array.from({ length: 7 }, (_, i) => ({
  record_id: 9000 + i,
  vehicle_id: 1000,
  license_plate: PLATES[0],
  vehicle_nickname: 'Van 0',
  speed: 10 * i,
  odometer: 1000 + i,
  heading: 0,
  driver: { driver_id: 500, first_name: 'Driver', last_name: 'D0' },
  events: [{ event_id: 1, event_name: i % 2 ? 'Engine On' : 'Engine Off' }],
  location: {
    point: { lat: 32, lon: 34.8 },
    address: { location: 'Report Road 3', speedlimit: 50 },
  },
  timestamp: `2026-11-07T0${i}:00:00`,
  places: [],
}));

function paging(
  rows: Row[],
  q: URLSearchParams | Row,
  where: 'metadata' | 'top' = 'metadata',
  max = 2000,
): { rows: Row[]; block: Row } | { error: Row } {
  const get = (k: string) =>
    q instanceof URLSearchParams
      ? q.get(k)
      : q[k] === undefined
        ? null
        : String(q[k]);
  const size = Number(get('page_size') ?? 10);
  const page = Number(get('page_number') ?? 1);
  if (size < 10 || size > max)
    return {
      error: {
        error_code: '400',
        error_description: 'One or more validation errors occurred.',
        errors: [
          {
            error_code: '1000',
            error_description: `PageSize = must be between 10 and ${max}`,
          },
        ],
      },
    };
  const slice = rows.slice((page - 1) * size, page * size);
  const block = {
    page_number: page,
    page_size: size,
    total_count: rows.length,
    page_count: Math.ceil(rows.length / size),
  };
  return {
    rows: slice,
    block:
      where === 'top'
        ? { pagination: block }
        : { metadata: { pagination: block } },
  };
}

export async function startFake(options: FakeOptions = {}) {
  const user = options.user ?? 'user_a';
  const password = options.password ?? 'secret-pass';
  const state: FakeState = {
    requests: [],
    grants: { password: 0, refresh: 0 },
  };
  const tokens = new Set<string>(options.token ? [options.token] : []);
  const refreshTokens = new Set<string>();
  let pressured = !options.pressureOnce;
  let serial = 0;
  const mint = () => {
    serial++;
    const access = `tok${serial}`.padEnd(88, 'x');
    const refresh = `ref${serial}`.padEnd(40, 'r');
    tokens.add(access);
    refreshTokens.add(refresh);
    return {
      access_token: access,
      expires_in: 1440,
      token_type: 'bearer',
      refresh_token: refresh,
    };
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname;
      const auth = req.headers.authorization;
      state.requests.push({
        method: req.method ?? 'GET',
        path,
        ...(auth ? { auth } : {}),
      });
      const send = (status: number, json?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      let parsed: Row = {};
      try {
        parsed = body ? (JSON.parse(body) as Row) : {};
      } catch {
        if (req.headers['content-type']?.includes('form'))
          parsed = Object.fromEntries(new URLSearchParams(body));
      }

      if (path === '/api/v1/oauth/token' && req.method === 'POST') {
        if (options.blocked)
          return send(474, { message: 'Access denied by Link11' });
        if (parsed.grant_type === 'password') {
          state.grants.password++;
          if (parsed.username !== user || parsed.password !== password)
            return send(401, {
              error_code: '401',
              error_description: 'IncorrectUserNameOrPassword',
            });
          if (options.twoStep) return send(200, { otp_required: true });
          return send(200, mint());
        }
        if (parsed.grant_type === 'refresh_token') {
          state.grants.refresh++;
          if (!refreshTokens.has(String(parsed.refresh_token)))
            return send(400, {
              error_code: '400',
              error_description: 'invalid_grant',
            });
          refreshTokens.delete(String(parsed.refresh_token));
          return send(200, mint());
        }
        return send(400, {
          error_code: '400',
          error_description: 'unsupported_grant_type',
        });
      }

      if (options.reconnect) {
        res.writeHead(502, {
          'comis-refusal': 'reconnect_needed',
          'content-type': 'text/plain',
        });
        return res.end('reconnect needed');
      }
      if (!auth)
        return send(400, {
          error_code: 'BadRequest',
          error_description: 'Autorization header not found. (IdSP)',
        });
      if (!tokens.has(auth.replace(/^Bearer /, '')))
        return send(401, {
          error_code: '401',
          error_description: 'Unauthorized',
        });
      if (!pressured) {
        pressured = true;
        return send(481, { message: 'Too many requests' });
      }
      const q = url.searchParams;
      const rt = q.getAll('realtime_fields');
      const list = (
        rows: Row[],
        key: string,
        where: 'metadata' | 'top' = 'metadata',
        src: URLSearchParams | Row = q,
        max = 2000,
      ) => {
        const p = paging(rows, src, where, max);
        if ('error' in p) return send(400, p.error);
        return send(200, { ...p.block, [key]: p.rows });
      };

      const m = (re: RegExp) => re.exec(path);
      let r: RegExpExecArray | null;
      if (req.method === 'GET' && path === '/api/v2/users/me') {
        return send(200, {
          user_id: 1,
          user_name: 'user_a',
          role_id: 2,
          role_name: 'Manager',
          customer_id: 3,
          customer_name: 'Example Ltd',
          is_activated: true,
          bi_customer_type: 'regular',
          is_international: false,
          permissions: ['CanRunReports', 'IBI_daily', 'Profile Method : X'],
          localization: {
            timezone_name: 'Israel Standard Time',
            geo_unit_type: 'Metric',
            culture: 'en-US',
            datetime_format: 'dd/MM/yyyy',
          },
          has_drivers: true,
          bi_show_inactive_vehicles: false,
        });
      }
      if (req.method === 'GET' && path === '/api/v2/vehicles')
        return list(
          VEHICLES.map((v, i) => realtime(v, i, rt)),
          'vehicles',
        );
      r = req.method === 'GET' ? m(/^\/api\/v2\/vehicles\/([0-9A-Z]+)$/) : null;
      if (r) {
        const i = VEHICLES.findIndex((v) => v.license_plate === r?.[1]);
        if (i < 0)
          return send(404, {
            error_code: '404',
            error_description: 'Entity was not found',
            errors: [
              {
                error_code: '1020',
                error_description: `license_plate: ${r[1]}`,
              },
            ],
          });
        return send(200, realtime(VEHICLES[i] as Row, i, rt));
      }
      if (req.method === 'POST' && path === '/api/v2/vehicles/search') {
        let hits = VEHICLES.map((v, i) => realtime(v, i, rt));
        if (Array.isArray(parsed.license_plates))
          hits = hits.filter((v) =>
            (parsed.license_plates as string[]).includes(
              String(v.license_plate),
            ),
          );
        const wf = (parsed.wildcard_filter ?? {}) as Row;
        if (typeof wf.license_plate === 'string')
          hits = hits.filter((v) =>
            String(v.license_plate).includes(String(wf.license_plate)),
          );
        if (typeof wf.nickname === 'string')
          hits = hits.filter((v) =>
            String(v.nickname).includes(String(wf.nickname)),
          );
        if (!hits.length)
          return send(404, {
            error_code: '404.3',
            error_description: 'Vehicles not found',
          });
        return list(hits, 'vehicles');
      }
      if (req.method === 'GET' && path === '/api/v2/trips') {
        const plates = q.getAll('license_plates');
        if (plates.includes(NOT_TRACKED))
          return send(404, {
            error_code: '404.1',
            error_description: 'Plate does NOT exist or not tracked',
          });
        const from = q.get('from_date') ?? '';
        const to = q.get('to_date') ?? '';
        const hits = TRIPS.filter(
          (t) =>
            (!plates.length || plates.includes(String(t.license_plate))) &&
            String((t.end_location as Row).timestamp) >= from &&
            String((t.end_location as Row).timestamp) <= to,
        );
        if (!hits.length)
          return send(404, {
            error_code: '404',
            error_description: 'Trips not found',
          });
        return list(hits, 'trips');
      }
      if (req.method === 'GET' && path === '/api/v2/trips/stats') {
        if (!q.get('license_plate'))
          return send(400, {
            error_code: '400',
            error_description: 'One or more validation errors occurred.',
            errors: [
              {
                error_code: '1000',
                error_description:
                  "LicensePlate = License plate can't be empty",
              },
            ],
          });
        return send(200, {
          totals: {
            safety_grade: 90,
            distance: 149.5,
            duration: '06:00:00',
            trips_count: 12,
            idle_duration: '00:48:00',
          },
          stats: [
            {
              period_start: '2026-11-07T00:00:00.000',
              period_end: '2026-11-07T23:59:59.000',
              safety_grade: 90,
              distance: 149.5,
              duration: '06:00:00',
              trips_count: 12,
              idle_duration: '00:48:00',
            },
          ],
        });
      }
      if (req.method === 'POST' && path === '/api/v2/trips/totals') {
        if (
          /T/.test(String(parsed.to_date)) ||
          /T/.test(String(parsed.from_date))
        )
          return send(400, {
            error_code: '400',
            error_description: 'One or more validation errors occurred.',
            errors: [
              {
                error_code: '1000',
                error_description:
                  'to_date = date should be only date without time.',
              },
            ],
          });
        return send(200, {
          total_trips_distance: 1234.5,
          total_trips_duration: 'P1DT2H3M4S',
          idle_duration: 'PT5H',
          fuel_consumption: 12.5,
          trips_count: 40,
          working_time_duration: 'P2DT0H0M0S',
          drivers_count: 9,
          vehicles_count: 11,
        });
      }
      r = req.method === 'GET' ? m(/^\/api\/v2\/trips\/(\d+)$/) : null;
      if (r) {
        const t = TRIPS.find((x) => String(x.trip_id) === r?.[1]);
        return t
          ? send(200, t)
          : send(404, {
              error_code: '404',
              error_description: 'Trip not found',
            });
      }
      r = req.method === 'GET' ? m(/^\/api\/v2\/trips\/(\d+)\/points$/) : null;
      if (r) {
        const pts = Array.from({ length: 15 }, (_, i) => ({
          location: {
            point:
              i === 3 ? { lat: 0, lon: 0 } : { lat: 32 + i / 1000, lon: 34.8 },
            address: {},
          },
          odometer: 1000 + i,
          speed: i === 3 ? -999 : 40,
          heading: 0,
          timestamp: `2026-11-07T06:${String(i).padStart(2, '0')}:00`,
        }));
        return list(pts, 'trip_points');
      }
      r =
        req.method === 'GET'
          ? m(/^\/api\/v2\/trips\/(\d+)\/(safety|over-speeding)$/)
          : null;
      if (r) {
        return send(
          200,
          r[2] === 'safety'
            ? {
                metadata: { pagination: { total_count: 0 } },
                safety_events: [],
              }
            : { events: [] },
        );
      }
      if (req.method === 'GET' && path === '/api/v2/drivers')
        // Drivers page at most 1,000 at a time, unlike most lists.
        return list(DRIVERS, 'drivers', 'top', q, 1000);
      r = req.method === 'GET' ? m(/^\/api\/v2\/drivers\/(\d+)$/) : null;
      if (r) {
        const d = DRIVERS.find((x) => String(x.driver_id) === r?.[1]);
        return d
          ? send(200, d)
          : send(404, {
              error_code: '404',
              error_description: 'Driver not found',
            });
      }
      if (req.method === 'GET' && path === '/api/v2/places')
        return list(PLACES, 'places');
      if (req.method === 'GET' && path === '/api/v2/vehicle-groups') {
        return send(200, {
          vehicle_groups: [
            {
              vehicle_group_id: 1,
              vehicle_group_name: 'All',
              icon_id: 0,
              child_groups: [
                {
                  vehicle_group_id: 2,
                  vehicle_group_name: 'North',
                  icon_id: 0,
                  child_groups: [],
                },
              ],
            },
          ],
        });
      }
      if (req.method === 'GET' && path === '/api/v2/events/stats') {
        return send(200, {
          events: [
            { event_id: 11, event_name: 'Idling', num_of_vehicles: 3 },
            { event_id: 12, event_name: 'ניתוק  מתח', num_of_vehicles: 0 },
            { event_id: 13, event_name: 'Towing', num_of_vehicles: 1 },
          ],
        });
      }
      r =
        req.method === 'GET' ? m(/^\/api\/v2\/events\/(\d+)\/vehicles$/) : null;
      if (r) {
        return send(200, {
          vehicles:
            r[1] === '11'
              ? PLATES.slice(0, 3).map((p) => ({
                  license_plate: p,
                  nickname: 'Van',
                  timestamp: NOW,
                }))
              : [],
        });
      }
      if (req.method === 'GET' && path === '/api/v2/alerts') {
        const a = {
          alert_id: 1,
          alert_name: 'Speed over 110',
          alert_status: 'active',
        };
        return send(200, {
          alerts: [
            a,
            a,
            { alert_id: 2, alert_name: 'After hours', alert_status: 'active' },
          ],
        });
      }
      if (req.method === 'POST' && path === '/api/v2/diagnostics') {
        const asked = ((parsed.filter as Row)?.license_plates ??
          []) as string[];
        // "*" means every vehicle; every third one reports no diagnostics.
        const plates = asked.includes('*')
          ? VEHICLES.map((v) => String(v.license_plate))
          : asked;
        return list(
          plates.map((p, i) => ({
            license_plate: p,
            vehicle_id: 1,
            last_location: {},
            diagnostics:
              asked.includes('*') && i % 3 === 2
                ? []
                : [
                    {
                      name: 'Diagnostic_60',
                      label: 'fuel level - 60',
                      value: 41,
                      timestamp: '2026-11-08T10:00:00',
                    },
                  ],
          })),
          'vehicles',
        );
      }
      if (req.method === 'POST' && path === '/api/v2/virtual-odometer') {
        const plates = (parsed.license_plates ?? []) as string[];
        return list(
          plates.map((p) => ({
            license_plate: p,
            virtual_odometer: 12345.6,
            timestamp: NOW,
            reliability: 'low',
          })),
          'plates',
          'metadata',
          parsed,
        );
      }
      r =
        req.method === 'POST'
          ? m(
              /^\/api\/v2\/reports\/bi\/(daily|periodic|idle_percentage)\/(vehicles|drivers)$/,
            )
          : null;
      if (r) {
        const rows = PLATES.map((p, i) => ({
          date: String(parsed.from_date),
          license_plate: p,
          driver_codes: ['105'],
          distance: 10 * i,
          duration: 'PT1H2M',
          idle_duration: 'PT5M',
        }));
        if (r[1] === 'idle_percentage') {
          // The idle report nests its rows and adds a total.
          const p = paging(rows, q);
          if ('error' in p) return send(400, p.error);
          return send(200, {
            ...p.block,
            idle: {
              idle_total: {
                drivers_count: 9,
                vehicles_count: rows.length,
                distance: 660,
                duration: 'PT12H24M',
                idle_duration: 'PT1H',
              },
              idle_items: p.rows,
            },
          });
        }
        return list(rows, r[1] === 'periodic' ? 'periodic' : 'daily');
      }
      if (req.method === 'POST' && path === '/api/v2/reports/events-report') {
        const plates = (parsed.license_plates ?? []) as string[];
        if (!plates.length || plates.length > 5)
          return send(400, {
            error_code: '400',
            error_description: 'Plates = Plates is required',
          });
        // Pages of three, whatever was asked, so walks follow the cursor.
        const limit = Math.min(3, Number(parsed.records_limit ?? 1000));
        const start =
          parsed.from_record_id === undefined
            ? 0
            : RECORDS.findIndex((x) => x.record_id === parsed.from_record_id);
        const page = RECORDS.slice(start, start + limit);
        const last = page.at(-1)?.record_id;
        // The cursor is inclusive: the next page starts with this page's last row.
        return send(200, {
          has_more: start + limit < RECORDS.length,
          last_record_id: last,
          records: page,
        });
      }
      if (
        req.method === 'GET' &&
        path === '/api/v2/info/ituran-service-centers'
      ) {
        const center = (name: string, lat: number, lon: number) => ({
          name,
          phone: '03-0000000',
          opening_hours: '08:00-17:00',
          location: {
            point: { lat, lon },
            address: { location: `${name} Road 1` },
          },
        });
        return send(200, {
          service_centers: [
            center('Haifa Center', 32.8, 35.0),
            center('Tel Aviv Center', 32.09, 34.79),
            center('Beer Sheva Center', 31.25, 34.79),
          ],
        });
      }
      if (req.method === 'GET' && path === '/api/v2/bi/groups') {
        return send(200, [
          {
            id: 1,
            name: 'All vehicles',
            groups: [
              { id: 2, name: 'North', groups: [] },
              { id: 3, name: 'Empty', groups: [] },
            ],
          },
        ]);
      }
      if (req.method === 'GET' && path === '/api/v2/safety/groups') {
        const id = Number(q.getAll('group_ids')[0]);
        // Any time today counts as the future here.
        if (String(q.get('to_date')).slice(0, 10) >= localNow().slice(0, 10))
          return send(400, {
            error_code: '400',
            error_description: 'One or more validation errors occurred.',
            errors: [
              {
                error_code: '1000',
                error_description: 'date canot be future date.',
              },
            ],
          });
        // Ituran leaves out a group with no safety data.
        if (id === 3) return send(200, { groups: [] });
        return send(200, {
          groups: [
            { group_id: id, grades: { safety_grade: 70 + id, fuel_grade: 60 } },
          ],
        });
      }
      if (req.method === 'POST' && path === '/api/v2/safety/periodic') {
        if (!parsed.period_type)
          return send(400, {
            error_code: '400',
            error_description: "Required property 'period_type' not found",
          });
        const monthly = parsed.period_type === 'monthly';
        return list(
          (monthly ? ['2026-09', '2026-10'] : ['2026-11-06', '2026-11-07']).map(
            (p) => ({ period_start: p, safety_grade: 80, fuel_grade: 70 }),
          ),
          'safety',
        );
      }
      if (req.method === 'POST' && path === '/api/v2/safety/totals') {
        return send(200, {
          totals: {
            safety_grade: 71,
            fuel_grade: 64,
            event_groups: [
              { id: 1, name: 'speed', count: 5 },
              { id: 2, name: 'brakes', count: 3 },
            ],
          },
        });
      }
      if (req.method === 'POST' && path === '/api/v2/safety/vehicles') {
        return list(
          PLATES.slice(0, 4).map((p) => ({
            metadata: { license_plate: p, driver_codes: ['105'] },
            grades: { safety_grade: 80, fuel_grade: 70 },
          })),
          'safety',
        );
      }
      if (req.method === 'GET' && path === '/api/v1/maintenance/type')
        return send(200, {
          treatments: [
            { id: 1, name: 'Oil' },
            { id: 2, name: 'Tyres' },
          ],
        });
      if (req.method === 'GET' && path === '/api/v1/maintenance/treatments')
        return send(404, {
          error_code: '404',
          error_description: 'Maintenance was not found',
        });
      if (options.temps && path === '/api/v1/temperatures/current')
        return send(200, {
          vehicles: [
            {
              license_plate: PLATES[0],
              timestamp: NOW,
              sensors_data: [{ sensor_number: 1, temperature: 4.5 }],
            },
          ],
        });
      if (options.temps && path === '/api/v1/temperatures/report') {
        const missing = ['to_date', 'data_frequency'].find((k) => !q.get(k));
        if (missing)
          return send(400, {
            error_code: '400',
            error_description: 'One or more validation errors occurred.',
            errors: [
              {
                error_code: '1000',
                error_description: `${missing} is required`,
              },
            ],
          });
        return send(200, {
          records: [
            {
              timestamp: '2026-11-07T10:00:00',
              sensor_number: 1,
              temperature: 4.5,
            },
            {
              timestamp: '2026-11-07T11:00:00',
              sensor_number: 1,
              temperature: 5,
            },
          ],
        });
      }
      if (req.method === 'GET' && path.startsWith('/api/v1/temperatures/'))
        return send(403, {
          error_code: '1006',
          error_description:
            'User does not have permission to perform this action',
        });
      if (req.method === 'GET' && path.startsWith('/api/advanced/v1/'))
        return send(403);
      if (req.method === 'GET' && path === '/api/v2/drive-permission-group')
        return send(403, {
          error_code: '403.2',
          error_description:
            "You can't use drive permission groups since this feature is not enabled for your account.",
        });
      return send(404);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v2`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFake({ port: Number(process.argv[2] ?? 0) });
  console.log(`fake on ${new URL(fake.url).port}`);
}
