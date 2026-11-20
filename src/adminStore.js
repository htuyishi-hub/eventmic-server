import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const adminsById = new Map();
const adminsByEmail = new Map();

function getStorePath() {
  const dir = process.env.DATA_DIR;
  if (!dir) return null;
  return path.join(dir, 'admins.json');
}

function loadFromDisk() {
  const file = getStorePath();
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) return;
    for (const a of rows) {
      adminsById.set(a.id, a);
      adminsByEmail.set(a.email, a);
    }
  } catch {}
}

function saveToDisk() {
  const file = getStorePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(adminsById.values()), null, 2), 'utf8');
  } catch {}
}

loadFromDisk();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, keyHex] = String(storedHash || '').split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export function registerAdmin({ name, email, password }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');

  if (cleanName.length < 2 || cleanName.length > 60) {
    throw Object.assign(new Error('Name must be between 2 and 60 characters'), { status: 400, code: 'BAD_REQUEST' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('Valid email address is required'), { status: 400, code: 'BAD_REQUEST' });
  }
  if (cleanPass.length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters'), { status: 400, code: 'BAD_REQUEST' });
  }
  if (adminsByEmail.has(cleanEmail)) {
    throw Object.assign(new Error('An account with this email already exists'), { status: 409, code: 'EMAIL_EXISTS' });
  }

  const admin = {
    id: 'adm-' + crypto.randomBytes(6).toString('hex'),
    name: cleanName,
    email: cleanEmail,
    passwordHash: hashPassword(cleanPass),
    createdAt: Date.now()
  };

  adminsById.set(admin.id, admin);
  adminsByEmail.set(admin.email, admin);
  saveToDisk();

  return { id: admin.id, name: admin.name, email: admin.email };
}

export function authenticateAdmin({ email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const admin = adminsByEmail.get(cleanEmail);
  if (!admin || !verifyPassword(String(password || ''), admin.passwordHash)) {
    return null;
  }
  return { id: admin.id, name: admin.name, email: admin.email };
}

export function getAdminById(id) {
  const a = adminsById.get(id);
  return a ? { id: a.id, name: a.name, email: a.email } : null;
}
