import type pg from 'pg';
import { UI_EVENTS } from '../../src/lib/uiUsage.ts';
import { badRequest, identifier, object } from './errors.ts';

// Button-click counters uploaded by clients: which control, which local day, how many times.
// Never content. They live outside the sync log on purpose: counters do not merge like records,
// and nothing on any device ever needs to read them back.

export const USAGE_PLATFORMS = ['extension', 'app'] as const;
export type UsagePlatform = (typeof USAGE_PLATFORMS)[number];
export interface UsageRow { day: string; event: string; count: number }
export interface UsageUpload { deviceId: string; platform: UsagePlatform; rows: UsageRow[]; ignored: number }

// Clients keep 90 days; the margin allows for a retention change without a server release.
const MAX_DAYS = 120;
const MAX_EVENTS_PER_DAY = 200;
const MAX_COUNT = 1_000_000_000;
const DAY_MS = 86_400_000;
// The server does not restrict names to its own copy of the event table: a newer client may know
// events this build has never heard of. The shape bound is what keeps the table finite.
const EVENT_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;

function calendarDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls 2026-02-31 over into March; PostgreSQL would refuse it with a 500.
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? undefined : time;
}

/**
 * Structural problems reject the upload. Days a sane clock could not have produced are dropped and
 * counted instead: the usual cause is a device with a wrong date, and a rejection would make it
 * resend the same payload forever.
 */
export function validateUsage(input: unknown, now = Date.now()): UsageUpload {
  const raw = object(input);
  const deviceId = identifier(raw.deviceId, 'deviceId');
  if (!(USAGE_PLATFORMS as readonly unknown[]).includes(raw.platform)) badRequest('Invalid platform');
  const days = Object.entries(object(raw.days));
  if (days.length > MAX_DAYS) badRequest(`At most ${MAX_DAYS} days may be uploaded at once`);
  const rows: UsageRow[] = [];
  let ignored = 0;
  for (const [day, value] of days) {
    const time = calendarDay(day);
    if (time === undefined) badRequest('Invalid day');
    const counts = Object.entries(object(value));
    if (counts.length > MAX_EVENTS_PER_DAY) badRequest(`At most ${MAX_EVENTS_PER_DAY} events per day`);
    // A client's local "today" can be the server's tomorrow; its oldest bucket is months old.
    const plausible = time <= now + 2 * DAY_MS && time >= now - 400 * DAY_MS;
    for (const [event, count] of counts) {
      if (!EVENT_NAME.test(event)) badRequest('Invalid event name');
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) badRequest('Invalid count');
      if (plausible) rows.push({ day, event, count }); else ignored++;
    }
  }
  return { deviceId, platform: raw.platform as UsagePlatform, rows, ignored };
}

const count = (value: unknown): number => Number(value ?? 0);

interface EventUsage { name: string; label: string | null; last7: number; last30: number; total: number; users: number; devices: number }

/**
 * The analysis behind `admin usage`. Every event of the shared table gets a line per platform,
 * zeros included: a control nobody touched never shows up in the data, and those are the ones
 * being looked for. `unknown` holds names from clients newer than this server.
 *
 * Days are each device's local calendar days, so the 7 and 30 day windows are fuzzy by a day at
 * their far edge.
 */
export async function usageReport(pool: pg.Pool, onlyUserId?: string) {
  const filter = '($1::uuid IS NULL OR user_id=$1)';
  const args = [onlyUserId ?? null];
  if (onlyUserId && !(await pool.query('SELECT 1 FROM users WHERE id=$1', args)).rowCount) throw new Error('User does not exist');
  const overall = (await pool.query(`SELECT min(day)::text AS first, max(day)::text AS last, count(DISTINCT user_id) AS users,
    count(DISTINCT (user_id, device_id)) AS devices FROM ui_usage WHERE ${filter}`, args)).rows[0]!;
  const platforms = (await pool.query(`SELECT platform, count(DISTINCT user_id) AS users, count(DISTINCT (user_id, device_id)) AS devices,
    count(DISTINCT (user_id, device_id, day)) AS device_days, min(day)::text AS first, max(day)::text AS last
    FROM ui_usage WHERE ${filter} GROUP BY platform ORDER BY platform`, args)).rows;
  const events = (await pool.query(`SELECT platform, event, sum(count) AS total,
    COALESCE(sum(count) FILTER (WHERE day > current_date - 7), 0) AS last7,
    COALESCE(sum(count) FILTER (WHERE day > current_date - 30), 0) AS last30,
    count(DISTINCT user_id) AS users, count(DISTINCT (user_id, device_id)) AS devices
    FROM ui_usage WHERE ${filter} GROUP BY platform, event`, args)).rows;
  const labels = UI_EVENTS as Record<string, string>;
  const order = new Map(Object.keys(labels).map((name, index) => [name, index]));
  return {
    first: overall.first as string | null, last: overall.last as string | null, users: count(overall.users), devices: count(overall.devices),
    platforms: platforms.map(platform => {
      const seen = new Map(events.filter(row => row.platform === platform.platform).map(row => [row.event as string, row]));
      const lines: EventUsage[] = [...new Set([...order.keys(), ...seen.keys()])].map(name => {
        const row = seen.get(name);
        return { name, label: labels[name] ?? null, last7: count(row?.last7), last30: count(row?.last30), total: count(row?.total), users: count(row?.users), devices: count(row?.devices) };
      });
      // Most used first; ties and the zeros keep the order of the page, unknown names last.
      lines.sort((a, b) => b.total - a.total || (order.get(a.name) ?? Infinity) - (order.get(b.name) ?? Infinity) || a.name.localeCompare(b.name));
      return {
        platform: platform.platform as string, users: count(platform.users), devices: count(platform.devices),
        // One device on one day. Totals mean little without it: 40 clicks over 2 days is not 40 over 60.
        deviceDays: count(platform.device_days), first: platform.first as string, last: platform.last as string,
        unused: lines.filter(line => line.label !== null && line.total === 0).map(line => line.name),
        unknown: lines.filter(line => line.label === null).map(line => line.name),
        events: lines,
      };
    }),
  };
}
