# PANDUAN DEPLOYMENT SHINDORA KE CLOUDFLARE D1 (100% STANDALONE WORKER)

Dengan arsitektur **Cloudflare D1 SQL**, ShinDora Stream berjalan **100% mandiri** di Cloudflare tanpa memerlukan hosting server atau database luar (tanpa Vercel/Node/Python).

Semua data (video links, akun admin, settings VAST/player) tersimpan di Cloudflare D1 SQL yang terdistribusi secara global.

---

## **LANGKAH 1: Buat Database D1 di Cloudflare**

Jalankan perintah ini di terminal (atau via Cloudflare Dashboard):

```bash
# 1. Login ke akun Cloudflare
npx wrangler login

# 2. Buat database D1 baru bernama 'shindora-db'
npx wrangler d1 create shindora-db
```

Output dari perintah di atas akan memberikan `database_id`, contoh:
```toml
[[d1_databases]]
binding = "DB"
database_name = "shindora-db"
database_id = "xxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Salin nilai `database_id` tersebut ke dalam file **`wrangler.toml`**.

---

## **LANGKAH 2: Eksekusi Schema Tabel (Database Migration)**

Jalankan skrip `schema.sql` untuk membuat tabel `links`, `settings`, dan `sessions`:

```bash
# Eksekusi ke database D1 di Cloudflare
npx wrangler d1 execute shindora-db --file=./schema.sql --remote
```

*(Atau jika ingin test di local environment: `npx wrangler d1 execute shindora-db --file=./schema.sql --local`)*

---

## **LANGKAH 3: Deploy Worker ke Cloudflare**

Deploy file **`cloudflare-worker-d1.js`** yang telah memuat 100% logic API, D1 CRUD, Scraping, Stream Proxy, dan Token Recovery:

```bash
npx wrangler deploy
```

---

## **METODE DASHBOARD CLOUDFLARE (TANPA CLI):**

1. Buka [Cloudflare Dashboard](https://dash.cloudflare.com/) -> **Storage & Databases** -> **D1 SQL Database**.
2. Klik **Create database** -> Beri nama `shindora-db` -> Klik **Create**.
3. Buka tab **Console** pada database `shindora-db` tersebut, lalu salin dan tempelkan seluruh isi berkas `schema.sql`, lalu klik **Execute**.
4. Buka **Workers & Pages** -> Buat Worker baru bernama `shindora-stream-d1`.
5. Di menu Worker tersebut, buka **Settings** -> **Bindings** -> Klik **Add** -> Pilih **D1 Database**:
   - Variable name: `DB`
   - D1 database: Pilih `shindora-db`
6. Buka **Quick Edit** pada Worker, tempelkan isi berkas `cloudflare-worker-d1.js` -> Klik **Save and Deploy**.
7. Buka tab **Triggers** -> Tambahkan Cron Trigger: `0 0 * * *` (untuk sinkronisasi token 24 jam).

---

## **FITUR MANDIRI YANG BERJALAN DI WORKER D1:**

1. **Authentication & Session**: Login admin, hash cookie token tersimpan di D1 (`/api/auth/login`, `/api/auth/session`).
2. **Video Parser Engine**: Scraping VK Video, OK.ru, dan Sibnet berjalan langsung di Edge worker (`/api/parse`).
3. **Database CRUD**: Menyimpan, mengedit, menghapus link video langsung ke D1 SQL (`/api/links`).
4. **Streaming & Download Proxy**: Byte-range seeking (HTTP 206), direct download attachment filename `<Judul> (<Kualitas>).mp4` (`/api/stream` & `/api/download`).
5. **Auto Token Recovery di Edge**: Jika video mengembalikan 401/403/404/410 saat diputar, Worker langsung mengekstrak ulang stream dari sumber aslinya dan memperbarui tabel D1 secara otomatis.
6. **24h Scheduled Refresh**: Worker Cron otomatis memperbarui video yang mendekati kadaluarsa tiap 24 jam sekali.
