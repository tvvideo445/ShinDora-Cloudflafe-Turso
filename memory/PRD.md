# ShinDora Stream - Product Requirements Document & Architecture

## Overview
ShinDora Stream adalah platform video streaming proxy dan CDN manager untuk video dari VK Video, OK.ru, dan Sibnet dengan JWPlayer 8, VAST/VMAP Ads Engine, 24h Background Token Sync, Subtitle Converter, serta Direct Download Proxy berkecepatan tinggi yang terhubung langsung ke database Turso (LibSQL) di Edge Cloudflare Worker dengan antarmuka Light Theme 100% identik dengan desain referensi.

## UI Design & Feature Parity
- **Tema**: Light Theme (Terang) dengan latar belakang putih/abu-abu bersih.
- **Sidebar Kiri**:
  - Logo ShinDora Stream & subteks Admin Control Panel.
  - Menu Navigasi: `Video Links` (Active pill), `VAST Ads Engine`, `Settings & Cloudflare CDN`.
  - Kartu user status `admin` & status terotentikasi.
- **Top Actions & Stats Cards**:
  - Tombol `Sync Token 24h` (outline) & `+ Tambah Video Baru` (black pill).
  - 4 Kartu Statistik: `TOTAL VIDEOS` (271), `VK VIDEO` (105), `OK.RU` (166), `SIBNET` (0).
- **Search & Filter Bar**:
  - Search input box judul/slug/URL.
  - Dropdown `FILTER HOST: Semua Host (271)`.
- **Tabel Video & Quick Actions**:
  - Kolom: `VIDEO & SLUG`, `HOST`, `STREAMS`, `TOKEN & 24H STATUS` (dengan tombol refresh per row), `QUICK LINKS & ACTIONS`.
  - Tombol aksi: `Player`, `Embed`, `Download`, `Preview`, `Edit`, `Delete`.
- **Database Backend**:
  - Terhubung langsung ke Turso (`https://shindora-player-shindora-stream.aws-ap-northeast-1.turso.io`) via HTTP Pipeline.

## Deployment Files
- `cloudflare-worker.js`: Cloudflare Worker mandiri dengan Full Light Theme UI + Turso Database Engine.
- `wrangler.toml`: Konfigurasi deployment Wrangler dengan `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN`.
