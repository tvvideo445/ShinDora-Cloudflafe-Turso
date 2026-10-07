# ShinDora Stream - Product Requirements Document & Architecture

## Overview
ShinDora Stream adalah platform video streaming proxy dan CDN manager untuk video dari VK Video, OK.ru, dan Sibnet dengan JWPlayer 8, VAST/VMAP Ads Engine, 24h Background Token Sync, Subtitle Converter, serta Direct Download Proxy berkecepatan tinggi yang terhubung langsung ke database Turso (LibSQL) di Edge Cloudflare Worker.

## Turso Database Configuration
- **Database URL**: `https://shindora-player-shindora-stream.aws-ap-northeast-1.turso.io`
- **Total Records Populated**: 271 Video links & Sistem Settings
- **Connection Protocol**: HTTP Pipeline (`/v2/pipeline`)
- **Cloudflare Worker**: `cloudflare-worker.js` (Standalone dengan Full Web UI & Turso Edge DB)
- **Deployment Config**: `wrangler.toml` (dengan `TURSO_DATABASE_URL` & `TURSO_AUTH_TOKEN`)
