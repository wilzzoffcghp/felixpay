import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../lib/supabase';
import { parseNominalStr } from '../../../../lib/security';
import { sendToOwner, sendDepositSuccessNotification } from '../../../../lib/telegram';
import axios from 'axios';

function formatRupiah(n) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n || 0); }

// Dipanggil oleh Vercel Cron (lihat vercel.json) tiap menit — pengganti cron.schedule('*/30 * * * * *')
// node-cron lama, yang TIDAK bisa jalan di serverless karena proses tidak persist antar-request.
export async function GET(req) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: pending } = await supabaseAdmin.from('deposits').select('*')
    .eq('status', 'pending').gt('expired_at', new Date().toISOString());
  if (!pending || pending.length === 0) return NextResponse.json({ ok: true, checked: 0 });

  const url = `https://orderhostid.my.id/?action=mutasiqr&apikey=${process.env.ORDERKUOTA_API_KEY}&username=${process.env.ORDERKUOTA_USERNAME}&token=${process.env.ORDERKUOTA_TOKEN}`;
  let mutations = [];
  try {
    const response = await axios.get(url, { timeout: 20000 });
    mutations = response.data?.result?.results || [];
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message });
  }

  let credited = 0;
  for (const mut of mutations) {
    if (mut.status !== 'IN') continue;
    const nominal = parseNominalStr(mut.kredit);
    if (nominal <= 0) continue;

    const mutKey = `${mut.tanggal || ''}|${nominal}|IN`;
    const { data: used } = await supabaseAdmin.from('mutation_log').select('mut_key').eq('mut_key', mutKey).maybeSingle();
    if (used) continue;

    const match = pending.find(d => d.total_bayar === nominal && !d.mutation_key);
    if (!match) continue;

    if (mut.tanggal) {
      try {
        const [dp, tp] = mut.tanggal.split(' ');
        const [dd, mm, yy] = dp.split('/').map(Number);
        const [hh, mn, ss] = (tp || '00:00:00').split(':').map(Number);
        const mutTime = new Date(yy, mm - 1, dd, hh, mn, ss).getTime();
        if (mutTime < new Date(match.created_at).getTime() - 7200000) continue;
      } catch (e) {}
    }

    // Insert dulu ke mutation_log dengan PK unik → kalau race, insert kedua akan gagal (unique violation), aman dari double-credit.
    const { error: logErr } = await supabaseAdmin.from('mutation_log').insert({ mut_key: mutKey });
    if (logErr) continue; // sudah diklaim proses lain barengan

    // credit_deposit_atomic: hanya sukses kalau status masih 'pending' → anti double-credit juga di level deposit.
    const { data: result } = await supabaseAdmin.rpc('credit_deposit_atomic', { p_deposit_id: match.id, p_mutation_key: mutKey });
    if (!result || result.length === 0) continue;

    credited++;
    const { data: user } = await supabaseAdmin.from('users').select('*').eq('id', match.user_id).maybeSingle();
    if (user) {
      await sendDepositSuccessNotification({ ...match, status: 'success' }, user, formatRupiah);
      await sendToOwner(`✅ *DEPOSIT BERHASIL*\n👤 ${user.username}\n+${formatRupiah(match.amount)}\n💵 Saldo: ${formatRupiah(user.balance)}`);
    }
  }

  return NextResponse.json({ ok: true, checked: pending.length, credited });
}
