# PANDUAN DEPLOYMENT SHINDORA KE CLOUDFLARE D1 (100% STANDALONE WORKER)

Konfigurasi database D1 Anda telah disesuaikan dengan ID resmi dari Cloudflare Dashboard:
- **Worker Name**: `shindora-cloudflare`
- **Database Name**: `shindora-stream`
- **Database ID**: `330e80a6-665d-4ae9-b204-f7ce1c91a6e8`

---

## **LANGKAH 1: Import Database Lengkap (271+ Video & Settings) ke Cloudflare D1**

File **`d1-dump.sql`** telah digenerate dari database SQLite Anda. Jalankan perintah ini untuk mengimpor seluruh data 271 video ke Cloudflare D1:

```bash
# Eksekusi dump SQL langsung ke Cloudflare D1
npx wrangler d1 execute shindora-stream --file=./d1-dump.sql --remote
```

*(Atau via Cloudflare Dashboard: Buka D1 SQL Database `shindora-stream` -> tab **Console** -> Tempelkan seluruh isi file `d1-dump.sql` -> Klik **Execute**).*

---

## **LANGKAH 2: Konfigurasi `wrangler.toml`**

File `wrangler.toml` di proyek ini telah diperbarui:
```toml
name = "shindora-cloudflare"
main = "cloudflare-worker-d1.js"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "shindora-stream"
database_id = "330e80a6-665d-4ae9-b204-f7ce1c91a6e8"

[triggers]
crons = ["0 0 * * *"]
```

---

## **LANGKAH 3: Deploy Worker ke Cloudflare**

Jalankan perintah deploy di terminal Anda:

```bash
npx wrangler deploy
```

---

## **JIKA MENGGUNAKAN CLOUDFLARE WORKERS BUILDS / CI:**

Jika Anda menggunakan fitur **Workers Builds (Git Connected CI)** di Cloudflare Dashboard:
1. Pastikan nama Worker di Cloudflare adalah `shindora-cloudflare`.
2. Di menu Worker `shindora-cloudflare` -> Buka **Settings** -> **Bindings** -> Pastikan ada Binding:
   - **Type**: D1 Database
   - **Variable name**: `DB`
   - **D1 database**: `shindora-stream`
3. Push perubahan file `wrangler.toml` dan `cloudflare-worker-d1.js` ke repository GitHub Anda.
4. Cloudflare CI akan melakukan build & deploy secara otomatis tanpa error `[code: 10021]`.
