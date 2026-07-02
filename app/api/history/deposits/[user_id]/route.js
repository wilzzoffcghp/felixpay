import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../../lib/supabase';
import { getSession } from '../../../../../lib/auth';

// FIX KEAMANAN: versi lama tanpa auth — siapa pun bisa lihat riwayat deposit user lain
// hanya dengan mengganti user_id di URL. Sekarang wajib session & cocok dengan pemiliknya.
export async function GET(req, { params }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (String(session.id) !== String(params.user_id)) return NextResponse.json({ error: 'Access denied' }, { status: 403 });

  const { data } = await supabaseAdmin.from('deposits').select('*').eq('user_id', params.user_id).order('created_at', { ascending: false });
  return NextResponse.json(data || []);
}
