# ShinDora Stream - Product Requirements Document & Architecture

## Overview
ShinDora Stream adalah platform video streaming proxy dan CDN manager untuk video dari VK Video, OK.ru, dan Sibnet dengan JWPlayer 8, VAST/VMAP Ads Engine, 24h Background Token Sync, Subtitle Converter, serta Direct Download Proxy berkecepatan tinggi yang dapat di-deploy secara 100% mandiri ke Cloudflare Workers dengan database Cloudflare D1 SQL.

## Core Features Implemented
1. **Cloudflare D1 SQL Standalone Worker (`cloudflare-worker-d1.js`)**:
   - 100% Mandiri tanpa server origin terpisah.
   - Database SQLite di Edge melalui Cloudflare D1 SQL (`env.DB`).
   - Berkas SQL migration `schema.sql` (tabel: `links`, `settings`, `sessions`).
   - REST API lengkap (Auth, Settings, Video Links CRUD, ImageKit Signature, VAST XML Proxy).
   - In-Worker Video Scraper (VK Video API & Embed Scraper, OK.ru, Sibnet).
   - Video Stream & Download Proxy dengan auto-recovery langsung menulis ke tabel D1 saat terjadi 401/403/404/410.
   - Cloudflare Cron scheduled trigger tiap 24 jam memperbarui token di D1.
2. **Dashboard & Video Management**:
   - Video listing dengan statistik per-host (Total, VK, OK.ru, Sibnet).
   - Sinkronisasi token 24 jam satu klik & indikator status keaktifan token.
   - Output Code Generator: Direct Stream Link, Player Link, iFrame Embed Code, Direct Download Link multi-resolusi (1080p, 720p, 480p, 360p, 240p).
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
