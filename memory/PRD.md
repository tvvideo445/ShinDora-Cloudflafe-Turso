# ShinDora Stream - Product Requirements Document & Architecture

## Overview
ShinDora Stream adalah platform video streaming proxy dan CDN manager untuk video dari VK Video, OK.ru, dan Sibnet dengan JWPlayer 8, VAST/VMAP Ads Engine, 24h Background Token Sync, Subtitle Converter, serta Direct Download Proxy berkecepatan tinggi yang dapat di-deploy secara 100% mandiri ke Cloudflare Workers dengan database Cloudflare D1 SQL.

## Cloudflare D1 Deployment Configuration
- **Worker Name**: `shindora-cloudflare`
- **D1 Database Name**: `shindora-stream`
- **D1 Database ID**: `330e80a6-665d-4ae9-b204-f7ce1c91a6e8`
- **D1 Binding**: `DB`
- **Database Dump**: `d1-dump.sql` (Berisi 271 video links & 4 pengaturan sistem)
- **Embedded UI**: Cloudflare Worker kini menyertakan tampilan HTML/CSS Dashboard lengkap di route `/` dan pemutar video JWPlayer di `/v/:slug`.
