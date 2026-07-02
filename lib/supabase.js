import { createClient } from '@supabase/supabase-js';

// Service-role client — HANYA dipakai di server (Route Handlers), TIDAK PERNAH di client/browser.
// SUPABASE_SERVICE_ROLE_KEY tidak boleh diawali NEXT_PUBLIC_.
//
// Dibuat LAZY (baru benar-benar createClient saat pertama kali dipakai), bukan langsung saat
// file di-import. Kalau dibuat langsung di top-level, proses build Next.js ("Collecting page
// data") ikut menjalankan kode ini sebelum env var ke-inject, dan bikin build gagal dengan
// error "supabaseUrl is required" walau env var-nya sudah benar diisi di Vercel.
let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
  }
  return _client;
}

export const supabaseAdmin = new Proxy({}, {
  get(_target, prop) {
    return getClient()[prop];
  }
});
