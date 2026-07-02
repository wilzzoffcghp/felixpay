# Digital Pedia H2H — Next.js + Supabase + Vercel

Konversi dari Express/JSON (`dpay_secure_v2`) ke Next.js App Router, database Supabase (Postgres), siap deploy Vercel.

## Apa yang berubah & kenapa

### 1. Bug "cancel kadang tidak ter-cancel" — FIXED
**Sebab lama:** setiap request (`status`, `cancel`, auto-check cron) melakukan `readDB()` → ubah di memory → `writeDB()` seluruh file JSON. Kalau dua proses jalan bersamaan (misalnya auto-check deposit tiap 30 detik pas bareng user klik cancel), yang menulis terakhir menang dan menimpa perubahan proses lain — klasik **race condition read-modify-write**.

**Fix:** semua perubahan status kritis (`cancel`, `credit`, `expire`, potong/refund saldo) sekarang lewat **fungsi Postgres atomic** (`supabase/schema.sql`) dengan kondisi `WHERE status='pending'` dalam satu statement UPDATE. Kalau proses lain sudah lebih dulu mengubah baris itu, update kedua otomatis mengembalikan 0 baris — tidak ada lagi kondisi menang-menangan. Ini juga sekaligus mencegah **double-credit** deposit dan **saldo negatif** saat withdraw.

### 2. "Endpoint kelihatan semua dari view-source" — diperbaiki secara struktural
Cek langsung ke `script.js`/`dashboard.html` lama: user login disimpan di **localStorage** (`{id, username, balance, apiKey}`), dan endpoint lama (`/api/depo/create`, `/api/withdraw/create`, dll) **mempercayai `user_id` yang dikirim dari body/URL** tanpa verifikasi kepemilikan. Ini akar masalah "kebobol" — siapa pun yang buka DevTools bisa edit `user_id` di localStorage/network request dan bertindak sebagai user lain, karena tidak ada yang membuktikan bahwa request itu benar dari pemilik akun. Ini bukan soal "endpoint kelihatan" (itu memang normal), tapi soal **tidak ada verifikasi identitas server-side**.

Yang diperbaiki:
- **Password**: dulu **plaintext** di `users.json` → sekarang **bcrypt hash**.
- **Auth**: `user_id` dari body **tidak lagi dipercaya**. Endpoint sensitif (deposit, withdraw, regenerate-apikey) sekarang membaca identitas dari **httpOnly cookie JWT** (`lib/auth.js`) yang di-set server saat login — cookie ini tidak bisa dibaca/diedit lewat `localStorage` atau `document.cookie` dari JS manapun, beda dari objek user di localStorage yang bisa diedit bebas via DevTools.
- **Rate limiting**: pindah dari in-memory `Map` (percuma di serverless, karena tiap function invocation punya memory sendiri) ke tabel Supabase (`lib/security.js`).
- **CORS**: dulu `cors()` default mengizinkan semua origin → sekarang dibatasi ke `WEBSITE_URL` (`next.config.js`).
- **Security headers**: ditambahkan `X-Frame-Options`, `HSTS`, dll (pengganti `helmet`).
- **Admin API key & timing attack**: perbandingan admin key sekarang pakai `safeEqual` (constant-time-ish), bukan `===` biasa.

### 3. node-telegram-bot-api polling & node-cron → tidak jalan di Vercel serverless
Diganti total:
- Bot polling → **webhook** (`app/api/telegram/webhook/route.js`), diverifikasi lewat header secret token dari Telegram.
- `cron.schedule(...)` → **Vercel Cron** (`vercel.json`) yang memanggil `app/api/cron/deposit-check` dan `app/api/cron/wd-check`, dilindungi `CRON_SECRET`.
- ⚠️ **Vercel Hobby plan cron minimal interval 1x/hari** — untuk cek tiap 30-60 detik seperti versi lama, **butuh plan Pro** (cron per-menit) ATAU pakai layanan eksternal (cron-job.org, GitHub Actions schedule) yang hit endpoint cron tersebut tiap 30-60 detik.
- `/tf` dan `/cektf` (transfer H2H langsung dari chat) **belum diporting** — command ini jarang dipakai dan berisiko tinggi (transfer langsung tanpa approval), sebaiknya lewat panel admin. Beri tahu saya kalau tetap dibutuhkan.
- Auto-backup zip via cron ke Telegram **tidak diporting** — Supabase sudah punya backup otomatis built-in (Point-in-Time Recovery di plan berbayar, atau `pg_dump` manual).

## Setup

1. **Supabase**: buat project baru → SQL Editor → jalankan `supabase/schema.sql`.
2. **Env**: copy `.env.example` → `.env`, isi semua (Supabase URL/service key dari Project Settings > API, generate ulang `JWT_SECRET`, `ADMIN_API_KEY`, `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET` baru — **jangan pakai yang lama**, karena `.env` lama pernah ter-bundle bareng source code).
3. **Migrasi data lama**: folder `old-data/` sudah diisi dari upload Anda. Jalankan:
   ```
   npm install
   npm run migrate
   ```
4. **Deploy ke Vercel**: push ke GitHub → import project di Vercel → isi Environment Variables (isi yang sama dari `.env`, ganti `WEBSITE_URL` ke domain Vercel/custom domain Anda).
5. **Daftarkan webhook Telegram** (sekali, setelah deploy):
   ```
   curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<domain-anda>/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
6. **Setup cron eksternal** (kalau tidak pakai Vercel Pro): daftarkan di cron-job.org / GitHub Actions untuk hit `https://<domain>/api/cron/deposit-check` dan `/api/cron/wd-check` tiap 30-60 detik, header `Authorization: Bearer <CRON_SECRET>`.

## Yang masih perlu Anda sesuaikan manual

- `public/script.js` & HTML lain pakai `axios` global — **wajib** tambahkan sekali di awal `script.js`:
  ```js
  axios.defaults.withCredentials = true; // supaya cookie httpOnly ikut terkirim ke API
  ```
  Tanpa ini, session cookie tidak akan terkirim dan semua request akan dianggap Unauthorized.
- `login.html`/`index.html`: setelah login sukses, tetap boleh simpan `{username, balance}` di localStorage untuk tampilan UI, tapi **jangan andalkan `id` dari localStorage untuk otorisasi** — backend sekarang selalu memverifikasi dari cookie, bukan dari `user_id` yang dikirim.
- Halaman admin (`admin.html`) masih perlu header `X-Admin-Key` (ganti dari cara lama) untuk memanggil `/api/admin/*`.
- Rate limiting berbasis tabel Supabase cukup untuk trafik kecil-menengah; kalau trafik besar, ganti ke Upstash Redis (`@upstash/ratelimit`) — jauh lebih cepat dan murah dari query DB tiap request.

## Struktur

```
app/api/...        → semua endpoint (Route Handlers, pengganti Express routes)
lib/                → supabase client, auth (JWT+bcrypt), security helpers, telegram helper
supabase/schema.sql → tabel + fungsi atomic (kunci fix bug cancel)
scripts/migrate-json-to-supabase.js → migrasi data lama
old-data/           → JSON asli Anda (dipakai sekali untuk migrasi, bisa dihapus setelah sukses)
public/             → HTML/CSS/JS lama (tetap dipakai sebagai static assets)
vercel.json         → cron config
```
