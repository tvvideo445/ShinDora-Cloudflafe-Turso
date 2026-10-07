# ShinDora Stream - Product Requirements Document & Architecture

## Overview
ShinDora Stream adalah platform video streaming proxy dan CDN manager untuk video dari VK Video, OK.ru, dan Sibnet dengan JWPlayer 8, VAST/VMAP Ads Engine, 24h Background Token Sync, Subtitle Converter, serta Direct Download Proxy berkecepatan tinggi yang terintegrasi dengan Cloudflare Workers.

## Core Features Implemented
1. **Database & Video Management (273+ Videos)**:
   - 273 video links dan metadata lengkap dari backup database (105 VK Video, 167 OK.ru).
   - Stats cards live per-host.
   - Sinkronisasi token 24 jam satu klik & indikator status keaktifan token.
   - Output Code Generator: Direct Stream Link, Player Link, iFrame Embed Code, Direct Download Link multi-resolusi (1080p, 720p, 480p, 360p, 240p).
2. **Cloudflare Worker Streaming & Download Proxy**:
   - `cloudflare-worker.js`: Streaming proxy dengan HTTP 206 Partial Content byte-range seeking, 24h cron token refresh, auto token recovery saat 401/403/404/410, subtitle proxy WebVTT.
   - `cloudflare-worker-download.js`: Dedicated direct download worker dengan filename formatting otomatis `<Judul> (<Kualitas>).mp4`.
   - `cloudflare-worker-all-in-one.js`: Standalone Worker All-in-One.
   - `wrangler.toml`: Konfigurasi Wrangler siap deploy dengan `ORIGIN_APP_URL`.
   - `CLOUDFLARE_WORKER_GUIDE.md`: Panduan deployment ke Cloudflare Workers.
3. **Player & VAST Ads Engine**:
   - JW Player 8 dengan kustom tombol -10s / +10s seek di controlbar.
   - Skip Opening Anime otomatis (`⏭ Skip Opening` / `✖ Tidak Skip`).
   - Dukungan Smart TV Remote D-Pad Navigation.
   - VAST 2.0-4.2 Waterfall resolver & Live Tag XML Tester.
   - Multi-layer AdBlock detector overlay modal.
4. **Settings & Media Storage**:
   - Konfigurasi Cloudflare Worker Stream & Dedicated Download CDN.
   - Kredensial ImageKit SDK untuk upload thumbnail & subtitle (.vtt/.srt).
   - Pengaturan akun admin & session auth (kredensial default disembunyikan dari UI login).

## Credentials
- Username: `admin`
- Password: `admin123`
