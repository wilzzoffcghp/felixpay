-- ============================================================
-- DIGITAL PEDIA H2H — SUPABASE SCHEMA
-- Jalankan ini di Supabase SQL Editor (Project > SQL Editor)
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- USERS ----------
create table if not exists users (
  id            bigserial primary key,
  username      text unique not null,
  password_hash text not null,               -- bcrypt hash, BUKAN plaintext (bug lama)
  api_key       text unique not null,
  balance       bigint not null default 0,
  suspended     boolean not null default false,
  suspended_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_users_apikey on users(api_key);

-- ---------- DEPOSITS ----------
create table if not exists deposits (
  id            text primary key,             -- kode trx, e.g. DP17...
  trxid_api     text,
  user_id       bigint not null references users(id),
  username      text not null,
  amount        bigint not null,
  fee           bigint not null,
  total_bayar   bigint not null,
  qr_image      text,
  status        text not null default 'pending', -- pending|success|canceled|expired
  source        text not null default 'web',      -- web|api
  mutation_key  text,
  created_at    timestamptz not null default now(),
  expired_at    timestamptz not null,
  paid_at       timestamptz,
  canceled_at   timestamptz
);
create index if not exists idx_deposits_user on deposits(user_id);
create index if not exists idx_deposits_status on deposits(status);

-- ---------- WITHDRAWALS ----------
create table if not exists withdrawals (
  id              text primary key,
  type            text not null,               -- manual|instant
  user_id         bigint not null references users(id),
  username        text not null,
  amount          bigint not null,
  fee             bigint not null,
  h2h_fee         bigint,
  markup_fee      bigint,
  total_diterima  bigint not null,
  operator        text not null,
  account_number  text not null,
  h2h_ref_id      text,
  h2h_product     text,
  h2h_invoice     text,
  h2h_price       bigint,
  h2h_last_status text,
  h2h_reason      text,
  status          text not null default 'pending', -- pending|processing|success|failed
  saldo_before    bigint,
  saldo_after     bigint,
  saldo_refunded  boolean default false,
  last_h2h_check  timestamptz,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  failed_at       timestamptz,
  processed_at    timestamptz
);
create index if not exists idx_wd_user on withdrawals(user_id);
create index if not exists idx_wd_status on withdrawals(status);

-- ---------- CHATS ----------
create table if not exists chats (
  id          bigserial primary key,
  user_id     bigint not null references users(id),
  from_admin  boolean not null default false,
  message     text not null,
  created_at  timestamptz not null default now()
);

-- ---------- ADMIN LOGS ----------
create table if not exists admin_logs (
  id                bigserial primary key,
  action            text not null,
  target_user_id    bigint,
  target_username   text,
  amount            bigint,
  old_balance       bigint,
  new_balance       bigint,
  timestamp         timestamptz not null default now()
);

-- ---------- MUTATION LOG (anti double-credit) ----------
create table if not exists mutation_log (
  mut_key     text primary key,
  created_at  timestamptz not null default now()
);

-- ---------- IP REGISTER LOG (anti brute-force register) ----------
create table if not exists ip_register_log (
  id          bigserial primary key,
  ip          text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_iplog_ip_time on ip_register_log(ip, created_at);

-- ---------- RATE LIMIT LOG (dipakai lib/security.js, pengganti in-memory Map) ----------
create table if not exists rate_limit_log (
  id          bigserial primary key,
  bucket      text not null,
  rkey        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ratelimit_bucket_key_time on rate_limit_log(bucket, rkey, created_at);

-- Housekeeping: hapus log rate-limit & mutation lebih dari 3 hari (jalankan via cron/pg_cron atau manual)
-- delete from rate_limit_log where created_at < now() - interval '3 days';
-- delete from mutation_log where created_at < now() - interval '3 days';

-- ============================================================
-- ATOMIC HELPER FUNCTIONS
-- Ini kunci fix bug "cancel kadang tidak ter-cancel":
-- update dilakukan atomic di DB dengan kondisi WHERE status='pending',
-- jadi kalau ada proses lain (auto-check deposit) yang barengan
-- mengubah status duluan, update ini otomatis return 0 rows / null
-- dan API tahu harus menolak alih-alih menimpa data.
-- ============================================================

-- Cancel deposit HANYA jika masih pending & belum expired. Atomic.
create or replace function cancel_deposit_atomic(p_deposit_id text, p_user_id bigint)
returns table (id text, status text) as $$
begin
  return query
  update deposits
  set status = 'canceled', canceled_at = now()
  where deposits.id = p_deposit_id
    and deposits.user_id = p_user_id
    and deposits.status = 'pending'
    and deposits.expired_at > now()
  returning deposits.id, deposits.status;
end;
$$ language plpgsql;

-- Mark deposit success + credit balance, atomic & idempotent (anti double-credit)
create or replace function credit_deposit_atomic(p_deposit_id text, p_mutation_key text)
returns table (user_id bigint, new_balance bigint) as $$
declare
  v_deposit deposits;
begin
  update deposits
  set status = 'success', paid_at = now(), mutation_key = p_mutation_key
  where deposits.id = p_deposit_id
    and deposits.status = 'pending'
  returning * into v_deposit;

  if v_deposit.id is null then
    return; -- sudah diproses/dibatalkan duluan, tidak double-credit
  end if;

  return query
  update users
  set balance = balance + v_deposit.amount
  where users.id = v_deposit.user_id
  returning users.id, users.balance;
end;
$$ language plpgsql;

-- Atomic balance deduction with sufficiency check (withdraw)
create or replace function deduct_balance_atomic(p_user_id bigint, p_amount bigint)
returns table (id bigint, balance bigint) as $$
begin
  return query
  update users
  set balance = users.balance - p_amount
  where users.id = p_user_id and users.balance >= p_amount
  returning users.id, users.balance;
end;
$$ language plpgsql;

-- Atomic refund
create or replace function refund_balance_atomic(p_user_id bigint, p_amount bigint)
returns table (id bigint, balance bigint) as $$
begin
  return query
  update users
  set balance = users.balance + p_amount
  where users.id = p_user_id
  returning users.id, users.balance;
end;
$$ language plpgsql;

-- Expire deposit atomically (used by status polling)
create or replace function expire_deposit_atomic(p_deposit_id text)
returns table (id text, status text) as $$
begin
  return query
  update deposits
  set status = 'expired'
  where deposits.id = p_deposit_id
    and deposits.status = 'pending'
    and deposits.expired_at <= now()
  returning deposits.id, deposits.status;
end;
$$ language plpgsql;
