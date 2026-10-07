# PANDUAN LENGKAP DEPLOYMENT CLOUDFLARE WORKER - SHINDORA STREAM

Aplikasi ShinDora Stream telah dimigrasi dan disiapkan dengan 3 berkas Cloudflare Worker mandiri:

1. `cloudflare-worker.js`: Cloudflare Worker khusus Streaming Video Proxy + Token Auto-Recovery + Subtitle Converter (.srt ke .vtt) + 24h Cron Scheduled Trigger.
2. `cloudflare-worker-download.js`: Cloudflare Worker khusus Direct Download Proxy dengan auto attachment filename `<Judul> (<Kualitas>).mp4`.
3. `cloudflare-worker-all-in-one.js`: Standalone Worker All-in-One yang menggabungkan fitur Streaming, Download, Subtitle, dan Cron dalam 1 skrip.

---

## CARA DEPLOY KE CLOUDFLARE WORKERS (METODE 1: CLOUDFLARE DASHBOARD)

1. Masuk ke [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Buka menu **Workers & Pages** -> Klik **Create application** -> **Create Worker**.
3. Beri nama Worker (contoh: `shindora-stream` atau `shindora-download`).
4. Klik **Deploy**.
5. Setelah ter-deploy, klik **Edit code** / **Quick edit**.
6. Salin dan tempelkan seluruh isi dari file:
   - `cloudflare-worker.js` (untuk stream) ATAU
   - `cloudflare-worker-all-in-one.js` (untuk semua fitur dalam 1 worker).
7. Klik **Save and Deploy**.
8. Buka **Settings** -> **Variables & Secrets**:
   - Tambahkan Environment Variable:
     - Name: `ORIGIN_APP_URL`
     - Value: URL aplikasi web Anda (contoh: `https://your-domain.com` atau domain preview).
9. (Opsional) Buka menu **Triggers** -> **Cron Triggers**:
   - Tambahkan jadwal: `0 0 * * *` (Setiap 24 jam sekali untuk auto refresh token).
10. Hubungkan Custom Domain (misal: `cdn.domainanda.com`).
11. Buka **ShinDora Dashboard** -> **Settings & Cloudflare CDN** -> Masukkan domain CDN tersebut ke kolom **Stream CDN / Cloudflare Worker URL**.

---

## CARA DEPLOY MENGGUNAKAN WRANGLER CLI (METODE 2)

```bash
# 1. Login ke akun Cloudflare
npx wrangler login

# 2. Deploy Streaming Worker
npx wrangler deploy

# 3. Atau deploy Download Worker
npx wrangler deploy --name shindora-download cloudflare-worker-download.js
```

---

## DAFTAR ENDPOINT DI CLOUDFLARE WORKER

- `GET /api/stream?url=<TargetUrl>&host=vk&slug=<Slug>`
- `GET /api/stream/:quality/:slug` (contoh: `/api/stream/720/doraemon-ep-1.mp4`)
- `GET /api/download?slug=<Slug>&quality=720`
- `GET /api/download/:quality/:slug` (contoh: `/api/download/1080/doraemon-ep-1.mp4`)
- `GET /api/subtitle?url=<RemoteSubtitleUrl>` (Auto-convert SRT ke WebVTT dengan Edge Caching)
- `GET /api/cron/refresh-tokens` (Sync dan perbarui token VK, OK.ru, Sibnet)
