import crypto from 'crypto';
import { UNAMBIGUOUS_CHARS } from './codes.js';
function generateSessionCode(){let c='';for(let i=0;i<6;i++)c+=UNAMBIGUOUS_CHARS[Math.floor(Math.random()*UNAMBIGUOUS_CHARS.length)];return c;}

const schedules = new Map();

export const VALID_RECURRENCE = ['none', 'daily', 'weekly', 'monthly'];

export function computeNextOccurrence(startAt, recurrence) {
  const d = new Date(startAt);
  if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

export function listSchedules(ownerId) {
  return Array.from(schedules.values())
    .filter((s) => !ownerId || s.ownerId === ownerId)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

export function createSchedule({ ownerId = 'default-host', title, startAt, durationMinutes = 60, recurrence = 'none', settings = {} }) {
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
  schedules.set(id, item);
  return item;
}

export function getSchedule(id, ownerId) {
  const s = schedules.get(id);
  if (!s) return null;
  if (ownerId && s.ownerId !== ownerId) return null;
  return s;
}

export function deleteSchedule(id, ownerId) {
  const s = schedules.get(id);
  if (!s) return false;
  if (ownerId && s.ownerId !== ownerId) return false;
  return schedules.delete(id);
}

export function advanceOrRemoveSchedule(id) {
  const item = schedules.get(id);
  if (!item) return null;
  if (item.recurrence && item.recurrence !== 'none') {
    item.startAt = computeNextOccurrence(item.startAt, item.recurrence);
    return item;
  }
  schedules.delete(id);
  return null;
}
