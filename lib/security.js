import { supabaseAdmin } from './supabase';

export function getClientIp(req) {
  const xf = req.headers.get('x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

// Rate limit sederhana berbasis tabel Supabase (menggantikan in-memory Map di kode lama,
// yang PERCUMA di serverless karena tiap invocation punya memory sendiri-sendiri).
// Untuk trafik tinggi, ganti dengan Upstash Redis (@upstash/ratelimit) — jauh lebih cepat.
export async function checkRateLimit(bucket, key, max, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const { count } = await supabaseAdmin
    .from('rate_limit_log')
    .select('*', { count: 'exact', head: true })
    .eq('bucket', bucket)
    .eq('rkey', key)
    .gte('created_at', since);

  if ((count || 0) >= max) return false;

  await supabaseAdmin.from('rate_limit_log').insert({ bucket, rkey: key });
  return true;
}

export function formatRupiah(n) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(n || 0);
}

export function generateTransactionId(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

export function parseNominalStr(str) {
  return parseInt(String(str || '0').replace(/[.,\s]/g, '').replace(/[^0-9]/g, '')) || 0;
}

export function newApiKey() {
  return 'fp_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 8);
}
