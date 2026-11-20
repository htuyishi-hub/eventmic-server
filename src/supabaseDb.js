/**
 * Lightweight zero-dependency Supabase PostgREST client.
 * Active only when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured.
 */

export function isSupabaseEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

function getBaseUrl() {
  return String(process.env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1';
}

export async function sbSelect(table, query = '') {
  const url = `${getBaseUrl()}/${table}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { headers: getHeaders() });
  if (!res.ok) {
    throw new Error(`Supabase select ${table} failed (${res.status})`);
  }
  return res.json();
}

export async function sbInsert(table, row) {
  const url = `${getBaseUrl()}/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Supabase insert ${table} failed (${res.status})`);
    err.status = res.status;
    err.detail = text;
    throw err;
  }
  const rows = await res.json();
  return rows[0] || row;
}

export async function sbUpdate(table, query, patch) {
  const url = `${getBaseUrl()}/${table}?${query}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    throw new Error(`Supabase update ${table} failed (${res.status})`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

export async function sbDelete(table, query) {
  const url = `${getBaseUrl()}/${table}?${query}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getHeaders({ Prefer: 'return=representation' })
  });
  if (!res.ok) {
    throw new Error(`Supabase delete ${table} failed (${res.status})`);
  }
  const rows = await res.json();
  return rows.length > 0;
}
