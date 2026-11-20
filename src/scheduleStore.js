import crypto from 'crypto';
import { UNAMBIGUOUS_CHARS } from './codes.js';
import { isSupabaseEnabled, sbSelect, sbInsert, sbUpdate, sbDelete } from './supabaseDb.js';

function generateSessionCode() {
  let c = '';
  for (let i = 0; i < 6; i++) {
    c += UNAMBIGUOUS_CHARS[Math.floor(Math.random() * UNAMBIGUOUS_CHARS.length)];
  }
  return c;
}

const schedules = new Map();

export const VALID_RECURRENCE = ['none', 'daily', 'weekly', 'monthly'];

export function computeNextOccurrence(startAt, recurrence) {
  const d = new Date(startAt);
  if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

function mapRow(r) {
  return {
    id: r.id,
    ownerId: r.owner_id,
    code: r.code,
    title: r.title,
    startAt: new Date(r.start_at).toISOString(),
    durationMinutes: r.duration_minutes,
    recurrence: r.recurrence,
    settings: r.settings || {},
    createdAt: Number(r.created_at)
  };
}

export async function listSchedules(ownerId) {
  if (isSupabaseEnabled()) {
    const filter = ownerId ? `owner_id=eq.${encodeURIComponent(ownerId)}&` : '';
    const rows = await sbSelect('dm_schedules', `${filter}order=start_at.asc`);
    return rows.map(mapRow);
  }
  return Array.from(schedules.values())
    .filter((s) => !ownerId || s.ownerId === ownerId)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

export async function createSchedule({ ownerId = 'default-host', title, startAt, durationMinutes = 60, recurrence = 'none', settings = {} }) {
  const id = 'sch-' + crypto.randomBytes(6).toString('hex');
  const rec = VALID_RECURRENCE.includes(recurrence) ? recurrence : 'none';
  const existingCodes = new Set(Array.from(schedules.values()).map((s) => s.code));
  let code = generateSessionCode();
  while (existingCodes.has(code)) code = generateSessionCode();

  const item = {
    id,
    ownerId,
    code,
    title: String(title || '').trim(),
    startAt: new Date(startAt).toISOString(),
    durationMinutes: Math.max(5, Math.min(480, Number(durationMinutes) || 60)),
    recurrence: rec,
    settings: {
      fairMode: ['off', 'auto', 'on'].includes(settings.fairMode) ? settings.fairMode : 'off',
      turnCapSeconds: Number(settings.turnCapSeconds) || 120,
      photos: ['on', 'speaker_only', 'off'].includes(settings.photos) ? settings.photos : 'speaker_only'
    },
    createdAt: Date.now()
  };

  if (isSupabaseEnabled()) {
    const row = await sbInsert('dm_schedules', {
      id: item.id,
      owner_id: item.ownerId,
      code: item.code,
      title: item.title,
      start_at: item.startAt,
      duration_minutes: item.durationMinutes,
      recurrence: item.recurrence,
      settings: item.settings,
      created_at: item.createdAt
    });
    return mapRow(row);
  }

  schedules.set(id, item);
  return item;
}

export async function getSchedule(id, ownerId) {
  if (isSupabaseEnabled()) {
    const filter = ownerId
      ? `id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`
      : `id=eq.${encodeURIComponent(id)}`;
    const rows = await sbSelect('dm_schedules', filter);
    return rows[0] ? mapRow(rows[0]) : null;
  }
  const s = schedules.get(id);
  if (!s) return null;
  if (ownerId && s.ownerId !== ownerId) return null;
  return s;
}

export async function deleteSchedule(id, ownerId) {
  if (isSupabaseEnabled()) {
    const filter = ownerId
      ? `id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`
      : `id=eq.${encodeURIComponent(id)}`;
    return sbDelete('dm_schedules', filter);
  }
  const s = schedules.get(id);
  if (!s) return false;
  if (ownerId && s.ownerId !== ownerId) return false;
  return schedules.delete(id);
}

export async function advanceOrRemoveSchedule(id, ownerId) {
  const item = await getSchedule(id, ownerId);
  if (!item) return null;
  if (item.recurrence && item.recurrence !== 'none') {
    const nextStart = computeNextOccurrence(item.startAt, item.recurrence);
    if (isSupabaseEnabled()) {
      const updated = await sbUpdate('dm_schedules', `id=eq.${encodeURIComponent(id)}`, { start_at: nextStart });
      return updated ? mapRow(updated) : null;
    }
    item.startAt = nextStart;
    return item;
  }
  await deleteSchedule(id, ownerId);
  return null;
}
