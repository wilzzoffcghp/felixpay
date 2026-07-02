// Migrasi data lama (data/*.json) ke Supabase — versi tahan-banting:
// baris yang datanya korup/rusak di-skip (dicatat di laporan), bukan bikin gagal semua.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const DATA_DIR = process.env.OLD_DATA_DIR || path.join(__dirname, '..', 'old-data');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const skipped = { deposits: [], withdrawals: [], chats: [] };

function readJson(name) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) { console.log(`⚠️  ${name} tidak ditemukan di ${DATA_DIR}, dilewati.`); return []; }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

// BIGINT postgres max ~9.2e18. Data lama ada yang korup (misal amount = 9e47 dari bug lama).
// Baris begini kita skip daripada bikin whole-batch gagal.
const BIGINT_MAX = 9223372036854775807n;
function safeInt(val, fallback = 0) {
  if (val === null || val === undefined) return fallback;
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n)) return null; // invalid -> caller harus skip row ini
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) return null; // kepresisian sudah gak bisa dipercaya
  try { if (BigInt(n) > BIGINT_MAX || BigInt(n) < -BIGINT_MAX) return null; } catch { return null; }
  return n;
}

async function migrateUsers() {
  const users = readJson('users.json');
  console.log(`Migrating ${users.length} users...`);
  const validIds = new Set();
  for (const u of users) {
    const password_hash = await bcrypt.hash(u.password || Math.random().toString(36), 12);
    const { error } = await supabase.from('users').upsert({
      id: u.id, username: u.username, password_hash, api_key: u.apiKey,
      balance: safeInt(u.balance, 0) ?? 0, suspended: !!u.suspended,
      suspended_at: iso(u.suspended_at), created_at: iso(u.created_at) || new Date().toISOString()
    });
    if (error) console.error(`❌ user ${u.username}:`, error.message);
    else validIds.add(u.id);
  }
  console.log('✅ Users done.');
  return validIds; // dipakai buat filter FK di deposits/withdrawals
}

async function migrateDeposits(validUserIds) {
  const deposits = readJson('deposits.json');
  console.log(`Migrating ${deposits.length} deposits...`);
  const chunk = 500;
  let okCount = 0;

  for (let i = 0; i < deposits.length; i += chunk) {
    const rawBatch = deposits.slice(i, i + chunk);
    const batch = [];
    for (const d of rawBatch) {
      const amount = safeInt(d.amount), fee = safeInt(d.fee, 0), total_bayar = safeInt(d.total_bayar);
      if (!validUserIds.has(d.user_id)) { skipped.deposits.push({ id: d.id, reason: 'user_id tidak ada di users', user_id: d.user_id }); continue; }
      if (amount === null || total_bayar === null) { skipped.deposits.push({ id: d.id, reason: 'amount/total_bayar corrupt/overflow', amount: d.amount }); continue; }
      batch.push({
        id: d.id, trxid_api: d.trxid_api, user_id: d.user_id, username: d.username,
        amount, fee: fee ?? 0, total_bayar, qr_image: d.qr_image,
        status: d.status, source: d.source || 'web', mutation_key: d.mutation_key,
        created_at: iso(d.created_at) || new Date().toISOString(),
        expired_at: iso(d.expired_at) || new Date().toISOString(),
        paid_at: iso(d.paid_at), canceled_at: iso(d.canceled_at)
      });
    }
    if (batch.length) {
      const { error } = await supabase.from('deposits').upsert(batch);
      if (error) console.error(`❌ deposits batch ${i}:`, error.message);
      else okCount += batch.length;
    }
  }
  console.log(`✅ Deposits done. Berhasil: ${okCount}, di-skip: ${skipped.deposits.length}`);
}

async function migrateWithdrawals(validUserIds) {
  const wds = readJson('withdrawals.json');
  console.log(`Migrating ${wds.length} withdrawals...`);
  const batch = [];
  for (const w of wds) {
    if (!validUserIds.has(w.user_id)) { skipped.withdrawals.push({ id: w.id, reason: 'user_id tidak ada di users' }); continue; }
    const amount = safeInt(w.amount), total_diterima = safeInt(w.total_diterima);
    if (amount === null || total_diterima === null) { skipped.withdrawals.push({ id: w.id, reason: 'amount corrupt/overflow' }); continue; }
    batch.push({
      id: w.id, type: w.type || 'manual', user_id: w.user_id, username: w.username,
      amount, fee: safeInt(w.fee, 0) ?? 0, h2h_fee: safeInt(w.h2h_fee), markup_fee: safeInt(w.markup_fee),
      total_diterima, operator: w.operator,
      account_number: w.account_number || '-', // FIX: dulu bisa null (misal dari /tf command), kolom butuh not-null
      h2h_ref_id: w.h2h_ref_id, h2h_product: w.h2h_product, h2h_invoice: w.h2h_invoice,
      h2h_price: safeInt(w.h2h_price), status: w.status, saldo_before: safeInt(w.saldo_before), saldo_after: safeInt(w.saldo_after),
      saldo_refunded: !!w.saldo_refunded, created_at: iso(w.created_at) || new Date().toISOString(),
      completed_at: iso(w.completed_at), failed_at: iso(w.failed_at), processed_at: iso(w.processed_at)
    });
  }
  if (batch.length) {
    const { error } = await supabase.from('withdrawals').upsert(batch);
    if (error) console.error('❌ withdrawals:', error.message);
  }
  console.log(`✅ Withdrawals done. Berhasil: ${batch.length}, di-skip: ${skipped.withdrawals.length}`);
}

async function migrateChats(validUserIds) {
  const chats = readJson('chats.json');
  console.log(`Migrating ${chats.length} chats...`);
  const batch = [];
  for (const c of chats) {
    if (!validUserIds.has(c.user_id)) { skipped.chats.push({ id: c.id, reason: 'user_id tidak ada di users' }); continue; }
    batch.push({ user_id: c.user_id, from_admin: !!c.from_owner, message: c.message, created_at: iso(c.timestamp) || new Date().toISOString() });
  }
  if (batch.length) {
    const { error } = await supabase.from('chats').insert(batch);
    if (error) console.error('❌ chats:', error.message);
  }
  console.log(`✅ Chats done. Berhasil: ${batch.length}, di-skip: ${skipped.chats.length}`);
}

async function getValidUserIdsFromDb() {
  const ids = new Set();
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from('users').select('id').range(from, from + pageSize - 1);
    if (error) { console.error('❌ Gagal ambil daftar user dari Supabase:', error.message); break; }
    if (!data || data.length === 0) break;
    data.forEach(u => ids.add(u.id));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  console.log(`ℹ️  ${ids.size} user sudah ada di Supabase (dipakai buat validasi FK).`);
  return ids;
}

(async () => {
  console.log(`📂 Membaca data lama dari: ${DATA_DIR}`);
  const skipUsers = process.env.SKIP_USERS === '1';
  const validUserIds = skipUsers ? await getValidUserIdsFromDb() : await migrateUsers();
  await migrateDeposits(validUserIds);
  await migrateWithdrawals(validUserIds);
  await migrateChats(validUserIds);

  fs.writeFileSync(path.join(__dirname, 'skipped-report.json'), JSON.stringify(skipped, null, 2));
  const totalSkipped = skipped.deposits.length + skipped.withdrawals.length + skipped.chats.length;
  console.log(`🎉 Migrasi selesai. Total baris di-skip: ${totalSkipped} (detail di skipped-report.json)`);
})();
