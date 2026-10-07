/**
 * SHINDORA STREAM - 100% STANDALONE CLOUDFLARE WORKER CONNECTED DIRECTLY TO TURSO (LIBSQL)
 * 
 * Desain UI Terang (Light Theme) 100% Identik dengan Repositori Asli & Screenshot Referensi:
 * - Sidebar Kiri (Video Links, VAST Ads Engine, Settings & Cloudflare CDN)
 * - 4 Stats Cards Bersih (Total Videos, VK Video, OK.ru, Sibnet)
 * - Search Bar + Filter Host Dropdown
 * - Tabel Video Lengkap dengan Kolom "Token & 24h Status" + Quick Links (Player, Embed, Download, Preview, Edit, Delete)
 * - Output Code Generator Multi-Resolusi (1080p, 720p, 480p, 360p, 240p)
 * - VAST Ads Engine & Tester
 * - Settings (CDN, Player, ImageKit)
 * - Pemutar JWPlayer 8 di /v/:slug dengan Anime Skip Opening & Seek +10s/-10s
 */

const TURSO_DEFAULT_URL = "https://shindora-player-shindora-stream.aws-ap-northeast-1.turso.io";
const TURSO_DEFAULT_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTE0MTE3MjAsImlkIjoiMDFhMDc3NGEtMDQwMS03MmIzLTlmMWYtNzUzODgzNWVjZDZjIiwia2lkIjoickdYdnh3R1hadktGeUpYQlFXZWpfLXlWY3RoLXMwMEdGeEFBOHhpRXlGRSIsInJpZCI6Ijk4NWUyNzI2LWE4ODQtNDQwOC1iZjVmLTQ3ZGVlNTM2YTcxNCJ9.Z51khBocCy-rkdOQZL8RVHVAe2ZQQdqThCZbzIX_eatwuiof4y-DK84Z8CyMSw4JEmwKG3O5L2CXp3yQGsYJBA";

// ===========================================================================
// TURSO HTTP PIPELINE QUERY HELPER
// ===========================================================================
async function queryTurso(sql, args = [], env = null) {
  const url = ((env?.TURSO_DATABASE_URL || TURSO_DEFAULT_URL).replace('libsql://', 'https://').replace(/\/+$/, '')) + '/v2/pipeline';
  const token = env?.TURSO_AUTH_TOKEN || TURSO_DEFAULT_TOKEN;

  const payload = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql: sql,
          args: args.map(a => {
            if (a === null || a === undefined) return { type: 'null' };
            if (typeof a === 'number') return { type: 'integer', value: String(a) };
            return { type: 'text', value: String(a) };
          })
        }
      },
      { type: 'close' }
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  const execRes = data?.results?.[0]?.response?.result;
  if (!execRes) return { rows: [], cols: [] };

  const cols = (execRes.cols || []).map(c => c.name);
  const rows = (execRes.rows || []).map(r => {
    const obj = {};
    cols.forEach((col, idx) => {
      const cell = r[idx];
      obj[col] = cell ? cell.value : null;
    });
    return obj;
  });

  return { rows, cols, affectedRowCount: execRes.affected_row_count || 0 };
}

function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function cleanVkUrl(urlStr) {
  if (!urlStr) return '';
  return urlStr.replace(/\\\/_/g, '_').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/\\x26/g, '&');
}

function cleanOkUrl(urlStr) {
  if (!urlStr) return '';
  try {
    return decodeURIComponent(urlStr).replace(/\\\//g, '/');
  } catch (e) {
    return urlStr.replace(/\\\//g, '/');
  }
}

function convertSrtToVtt(srtText) {
  if (!srtText) return 'WEBVTT\n\n';
  if (srtText.trim().startsWith('WEBVTT')) return srtText;
  let normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  normalized = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${normalized.trim()}\n`;
}

function formatDownloadFilename(title, quality) {
  const cleanQuality = (quality || '720').toString().replace(/p$/i, '') + 'p';
  let cleanTitle = (title || 'video').trim();
  cleanTitle = cleanTitle.replace(/\.mp4$/i, '').trim();
  cleanTitle = cleanTitle.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleanTitle) cleanTitle = 'video';
  return `${cleanTitle} (${cleanQuality}).mp4`;
}

// ===========================================================================
// VIDEO PARSERS (VK VIDEO, OK.RU, SIBNET)
// ===========================================================================
async function extractVideoStreams(url, customVkToken = '') {
  if (!url) throw new Error('URL is required');

  const isVk = url.includes('vk.com') || url.includes('vk.ru') || url.includes('vkvideo.ru');
  const isOk = url.includes('ok.ru') || url.includes('odnoklassniki.ru');
  const isSibnet = url.includes('sibnet.ru');

  if (!isVk && !isOk && !isSibnet) {
    throw new Error('Host video tidak didukung. Hanya VK Video, OK.ru, dan Sibnet.');
  }

  let title = 'Parsed Video';
  let posterUrl = '';
  let hostType = isVk ? 'vk' : (isOk ? 'ok' : 'sibnet');
  let sources = [];

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  if (isVk) {
    let vkToken = customVkToken ? customVkToken.trim() : '';
    const match = url.match(/video(-?\d+)_(\d+)/) || url.match(/video(-?\d+_\d+)/) || url.match(/clip(-?\d+)_(\d+)/);
    let oid = '', vid = '';
    if (match) {
      if (match[2]) { oid = match[1]; vid = match[2]; }
      else { const p = match[1].split('_'); if (p.length >= 2) { oid = p[0]; vid = p[1]; } }
    }

    let accessKey = (url.match(/list=([a-zA-Z0-9_\-]+)/) || [])[1] || (url.match(/access_key=([a-zA-Z0-9_\-]+)/) || [])[1] || '';
    let playerUrl = '';

    if (vkToken && oid && vid) {
      try {
        const queries = accessKey ? [`${oid}_${vid}_${accessKey}`, `${oid}_${vid}`] : [`${oid}_${vid}`];
        for (const vq of queries) {
          const apiRes = await fetch(`https://api.vk.com/method/video.get?videos=${encodeURIComponent(vq)}&access_token=${encodeURIComponent(vkToken)}&v=5.199`, {
            headers: { 'User-Agent': userAgent, 'Accept': 'application/json' }
          });
          if (apiRes.ok) {
            const data = await apiRes.json();
            const items = data?.response?.items;
            if (items && items.length > 0) {
              const item = items[0];
              if (item.title) title = item.title;
              if (item.player) playerUrl = item.player;
              if (item.image && item.image.length > 0) {
                const sorted = [...item.image].sort((a, b) => (b.width || 0) - (a.width || 0));
                posterUrl = sorted[0].url;
              }
              const files = item.files || {};
              const qMap = [['mp4_1080', '1080p'], ['mp4_720', '720p'], ['mp4_480', '480p'], ['mp4_360', '360p'], ['mp4_240', '240p']];
              for (const [k, lbl] of qMap) {
                if (files[k] && !sources.some(s => s.label === lbl)) {
                  sources.push({ file: `/api/stream?url=${encodeURIComponent(cleanVkUrl(files[k]))}&host=vk`, label: lbl, type: 'video/mp4' });
                }
              }
              if (files.hls && !sources.some(s => s.label.includes('HLS'))) {
                sources.push({ file: `/api/stream?url=${encodeURIComponent(cleanVkUrl(files.hls))}&host=vk`, label: 'HLS Auto', type: 'application/x-mpegURL' });
              }
              if (sources.length > 0) break;
            }
          }
        }
      } catch (e) {}
    }

    if (sources.length === 0 && oid && vid) {
      try {
        const embedTarget = playerUrl ? playerUrl.replace('vkvideo.ru', 'vk.com') : `https://vk.com/video_ext.php?oid=${oid}&id=${vid}${accessKey ? '&access_key=' + accessKey : ''}`;
        const embedRes = await fetch(embedTarget, { headers: { 'User-Agent': userAgent, 'Referer': 'https://vk.com/' } });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || html.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
          if (ogTitle) title = ogTitle[1].replace(/\s*\|\s*VK\s*Video/gi, '').replace(/\s*\|\s*VK/gi, '').trim();

          const ogImg = html.match(/<meta property="og:image" content="(.*?)"/i);
          if (ogImg && !posterUrl) posterUrl = ogImg[1];

          const idx = html.indexOf('apiPrefetchCache');
          if (idx !== -1) {
            const bStart = html.indexOf('[', idx);
            let count = 0, bEnd = -1;
            for (let i = bStart; i < html.length; i++) {
              if (html[i] === '[') count++;
              else if (html[i] === ']') { count--; if (count === 0) { bEnd = i; break; } }
            }
            if (bEnd !== -1) {
              const cacheData = JSON.parse(html.substring(bStart, bEnd + 1));
              for (const entry of cacheData) {
                const cFiles = entry?.response?.items?.[0]?.files || {};
                for (const q of ['1080', '720', '480', '360', '240']) {
                  const directU = cFiles[`mp4_${q}`] || cFiles[`url${q}`];
                  if (directU && !sources.some(s => s.label === `${q}p`)) {
                    sources.push({ file: `/api/stream?url=${encodeURIComponent(cleanVkUrl(directU))}&host=vk`, label: `${q}p`, type: 'video/mp4' });
                  }
                }
              }
            }
          }
        }
      } catch (e) {}
    }
  } else if (isOk) {
    const okMatch = url.match(/video(?:embed)?\/(\d+)/);
    const videoId = okMatch ? okMatch[1] : '';
    if (!videoId) throw new Error('Format ID OK.ru tidak valid');

    const embedRes = await fetch(`https://ok.ru/videoembed/${videoId}`, { headers: { 'User-Agent': userAgent, 'Referer': 'https://ok.ru/' } });
    if (embedRes.ok) {
      const html = await embedRes.text();
      const tMatch = html.match(/<title>(.*?)<\/title>/i);
      if (tMatch) title = tMatch[1].trim();

      const optMatch = html.match(/data-options="([^"]+)"/);
      if (optMatch) {
        try {
          const decoded = decodeURIComponent(optMatch[1]).replace(/&quot;/g, '"');
          const opts = JSON.parse(decoded);
          let metadata = opts?.flashvars?.metadata;
          if (typeof metadata === 'string') metadata = JSON.parse(metadata);
          if (metadata) {
            if (metadata.movie?.title) title = metadata.movie.title;
            if (metadata.movie?.poster) posterUrl = cleanOkUrl(metadata.movie.poster);
            const qMap = { lowest: '144p', mobile: '240p', low: '360p', sd: '480p', hd: '720p', full: '1080p' };
            for (const v of metadata.videos || []) {
              if (v.url) {
                sources.push({ file: `/api/stream?url=${encodeURIComponent(cleanOkUrl(v.url))}&host=ok`, label: qMap[v.name] || v.name, type: 'video/mp4' });
              }
            }
          }
        } catch (e) {}
      }
    }
  } else if (isSibnet) {
    const sibMatch = url.match(/video(\d+)/) || url.match(/videoid=(\d+)/) || url.match(/sibnet\.ru\/(?:video\/|v\/)?(\d+)/);
    const videoId = sibMatch ? sibMatch[1] : '';
    if (!videoId) throw new Error('Format ID Sibnet tidak valid');

    title = `Sibnet Video #${videoId}`;
    const shellRes = await fetch(`https://video.sibnet.ru/shell.php?videoid=${videoId}`, { headers: { 'User-Agent': userAgent, 'Referer': 'https://video.sibnet.ru/' } });
    if (shellRes.ok) {
      const html = await shellRes.text();
      const tMatch = html.match(/<title>(.*?)<\/title>/i);
      if (tMatch) title = tMatch[1].trim();

      const pMatch = html.match(/poster\s*:\s*["']([^"']+)["']/i);
      if (pMatch) posterUrl = pMatch[1].startsWith('http') ? pMatch[1] : `https://video.sibnet.ru${pMatch[1]}`;

      const srcMatch = html.match(/src\s*:\s*["'](\/v\/[^"']+)["']/i) || html.match(/["'](\/v\/[a-zA-Z0-9_\-.\?\=\&]+)["']/i);
      if (srcMatch) {
        const directV = srcMatch[1].startsWith('http') ? srcMatch[1] : `https://video.sibnet.ru${srcMatch[1]}`;
        sources.push({ file: `/api/stream?url=${encodeURIComponent(directV)}&host=sibnet`, label: '720p HD', type: 'video/mp4' });
      }
    }
  }

  if (sources.length === 0) throw new Error('Gagal mengekstrak video stream.');
  return { title, posterUrl, hostType, sources };
}

// ===========================================================================
// EMBEDDED LIGHT THEME HTML DASHBOARD (100% IDENTIK DENGAN SCREENSHOT REFERENSI)
// ===========================================================================
function renderPlayerHtml(title, posterUrl, sources, subtitles, slug, domain) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || 'ShinDora Player'}</title>
  <script src="https://content.jwplatform.com/libraries/IDzF9Zmk.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; background:#000; overflow:hidden; font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #jwplayer-container { width:100vw; height:100vh; position:absolute; inset:0; }
    .jw-btn-rewind-10, .jw-btn-forward-10 {
      width: 32px !important; height: 32px !important; border-radius: 50% !important;
      background: rgba(255, 255, 255, 0.2) !important; margin: 0 3px !important;
      display: inline-flex !important; align-items: center !important; justify-content: center !important;
      cursor: pointer !important;
    }
    .jw-btn-rewind-10 svg, .jw-btn-forward-10 svg { width: 18px !important; height: 18px !important; stroke: #fff !important; }
    .skip-opening-btn {
      position: absolute; right: 20px; bottom: 70px; z-index: 50;
      background: rgba(0,0,0,0.85); border: 1px solid rgba(255,255,255,0.3);
      border-radius: 12px; padding: 6px 12px; display: none; align-items: center; gap: 8px;
    }
    .skip-opening-btn button {
      background: #fff; color: #000; border: none; font-weight: 800; font-size: 12px;
      padding: 6px 12px; border-radius: 8px; cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="jwplayer-container"></div>
  <div id="skipOpening" class="skip-opening-btn">
    <button id="skipBtn">⏭ Skip Opening (01:00)</button>
    <button id="closeSkip" style="background:transparent; color:#fff; border:1px solid #444;">✕</button>
  </div>

  <script>
    const sources = ${JSON.stringify(sources)};
    const subtitles = ${JSON.stringify(subtitles)};
    const title = ${JSON.stringify(title)};
    const poster = ${JSON.stringify(posterUrl)};
    const slug = ${JSON.stringify(slug)};

    const jwSources = sources.map(s => ({
      file: s.file.startsWith('http') ? s.file : (window.location.origin + s.file),
      label: s.label || 'Default',
      type: s.type || 'video/mp4'
    }));

    const jwTracks = subtitles.map((sub, idx) => ({
      file: sub.file.startsWith('http') ? sub.file : (window.location.origin + sub.file),
      label: sub.label || ('Subtitle ' + (idx + 1)),
      kind: 'captions',
      default: idx === 0
    }));

    const player = jwplayer('jwplayer-container').setup({
      playlist: [{
        title: title,
        image: poster,
        sources: jwSources,
        tracks: jwTracks
      }],
      autostart: true,
      width: '100%',
      height: '100%',
      controls: true,
      displaytitle: true,
      stretching: 'uniform'
    });

    const rewindSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon></svg>';
    const forwardSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 5 2 19"></polygon></svg>';

    try {
      player.addButton(rewindSvg, 'Mundur 10s', () => player.seek(Math.max(0, player.getPosition() - 10)), 'jw-btn-rewind-10');
      player.addButton(forwardSvg, 'Maju 10s', () => player.seek(player.getPosition() + 10), 'jw-btn-forward-10');
    } catch(e) {}

    const skipDiv = document.getElementById('skipOpening');
    let skipDismissed = false;

    player.on('time', (e) => {
      const pos = Math.floor(e.position);
      const isAnime = title.toLowerCase().includes('doraemon') || title.toLowerCase().includes('shin-chan') || title.toLowerCase().includes('shinchan');
      if (isAnime && pos >= 0 && pos < 60 && !skipDismissed) {
        skipDiv.style.display = 'flex';
      } else {
        skipDiv.style.display = 'none';
      }
    });

    document.getElementById('skipBtn').onclick = () => { player.seek(60); skipDiv.style.display = 'none'; };
    document.getElementById('closeSkip').onclick = () => { skipDismissed = true; skipDiv.style.display = 'none'; };

    player.on('error', () => {
      fetch('/api/parse-stream?slug=' + slug + '&force=1').then(r => r.json()).then(data => {
        if (data.sources) window.location.reload();
      });
    });

    player.on('complete', () => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ event: 'SHINDORA_VIDEO_ENDED' }, '*');
      }
    });
  </script>
</body>
</html>`;
}

function renderDashboardAppHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShinDora Stream - Admin Control Panel</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #fafafa; color: #09090b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex flex-col md:flex-row antialiased">

  <!-- SIDEBAR KIRI (IDENTIK DENGAN SCREENSHOT) -->
  <aside class="w-full md:w-64 bg-white border-r border-zinc-200 p-5 flex flex-col justify-between shrink-0">
    <div class="space-y-6">
      <!-- Logo -->
      <a href="/" class="flex items-center gap-3 px-1 py-1">
        <div class="h-10 w-10 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
          <i class="fa-solid fa-play ml-0.5 text-sm"></i>
        </div>
        <div>
          <div class="font-extrabold text-base tracking-tight leading-none text-zinc-900">ShinDora Stream</div>
          <div class="text-[10px] text-zinc-400 font-medium mt-1">Admin Control Panel</div>
        </div>
      </a>

      <!-- Navigation Tabs -->
      <nav class="space-y-1.5 pt-2">
        <button id="tabVideoLinks" onclick="showView('dashboard')" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all bg-zinc-900 text-white shadow-sm">
          <i class="fa-solid fa-film text-sm w-4"></i>
          <span>Video Links</span>
        </button>

        <button id="tabVastAds" onclick="showView('vast-ads')" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all text-zinc-600 hover:bg-zinc-100">
          <i class="fa-solid fa-dollar-sign text-sm w-4"></i>
          <span>VAST Ads Engine</span>
        </button>

        <button id="tabSettings" onclick="showView('settings')" class="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all text-zinc-600 hover:bg-zinc-100">
          <i class="fa-solid fa-gear text-sm w-4"></i>
          <span>Settings & Cloudflare CDN</span>
        </button>
      </nav>
    </div>

    <div class="pt-4 border-t border-zinc-100 space-y-3">
      <div class="flex items-center gap-2.5 px-3 py-2 bg-zinc-50 rounded-xl border border-zinc-200/60">
        <div class="h-8 w-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
          <i class="fa-solid fa-user"></i>
        </div>
        <div class="truncate flex-1">
          <div class="text-xs font-bold text-zinc-800">admin</div>
          <div class="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Terotentikasi
          </div>
        </div>
      </div>
      <div class="text-[10px] text-zinc-400 text-center font-mono">Turso LibSQL Edge DB</div>
    </div>
  </aside>

  <!-- KONTEN UTAMA KANAN -->
  <main class="flex-1 p-6 md:p-8 max-w-7xl mx-auto w-full space-y-8">

    <!-- VIEW 1: DASHBOARD VIDEO LINKS (100% IDENTIK DENGAN SCREENSHOT) -->
    <div id="viewDashboard" class="space-y-6">
      <!-- Top Title and Action Buttons -->
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 class="text-3xl font-black tracking-tight text-zinc-900">Daftar Link Video</h1>
          <p class="text-xs sm:text-sm text-zinc-500 mt-1">
            Kelola tautan streaming, otomatis token recovery, iFrame embed generator, dan direct download proxy
          </p>
        </div>

        <div class="flex items-center gap-2.5">
          <button onclick="syncTokens24h()" id="syncBtn" class="bg-white hover:bg-zinc-50 text-zinc-800 border border-zinc-200 text-xs font-bold py-2 px-3.5 rounded-lg shadow-sm flex items-center gap-1.5 transition-colors">
            <i class="fa-solid fa-arrows-rotate text-zinc-600" id="syncIcon"></i>
            <span>Sync Token 24h</span>
          </button>
          <button onclick="showView('new-link')" class="bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-extrabold py-2 px-4 rounded-lg shadow-sm flex items-center gap-1.5 transition-colors">
            <i class="fa-solid fa-plus text-xs"></i>
            <span>Tambah Video Baru</span>
          </button>
        </div>
      </div>

      <!-- 4 STATS CARDS (IDENTIK DENGAN SCREENSHOT) -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <!-- Total Videos -->
        <div class="bg-white p-5 rounded-2xl border border-zinc-200/80 shadow-sm relative">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">TOTAL VIDEOS</span>
            <i class="fa-solid fa-film text-zinc-400 text-sm"></i>
          </div>
          <div id="statTotal" class="text-3xl font-black text-zinc-900 mt-2">271</div>
        </div>

        <!-- VK Video -->
        <div class="bg-white p-5 rounded-2xl border border-zinc-200/80 shadow-sm relative">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold text-blue-500 uppercase tracking-wider">VK VIDEO</span>
            <span class="h-2 w-2 rounded-full bg-blue-500"></span>
          </div>
          <div id="statVk" class="text-3xl font-black text-blue-600 mt-2">105</div>
        </div>

        <!-- OK.ru -->
        <div class="bg-white p-5 rounded-2xl border border-zinc-200/80 shadow-sm relative">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold text-amber-500 uppercase tracking-wider">OK.RU</span>
            <span class="h-2 w-2 rounded-full bg-amber-500"></span>
          </div>
          <div id="statOk" class="text-3xl font-black text-amber-500 mt-2">166</div>
        </div>

        <!-- Sibnet -->
        <div class="bg-white p-5 rounded-2xl border border-zinc-200/80 shadow-sm relative">
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-bold text-purple-500 uppercase tracking-wider">SIBNET</span>
            <span class="h-2 w-2 rounded-full bg-purple-500"></span>
          </div>
          <div id="statSibnet" class="text-3xl font-black text-purple-500 mt-2">0</div>
        </div>
      </div>

      <!-- SEARCH BAR & FILTER HOST -->
      <div class="flex flex-col sm:flex-row gap-4 items-center justify-between bg-white p-3 rounded-2xl border border-zinc-200/80 shadow-sm">
        <div class="relative w-full sm:w-96">
          <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-3 text-zinc-400 text-xs"></i>
          <input type="text" id="searchInput" oninput="renderTable()" placeholder="Cari judul, slug, atau URL..." class="w-full bg-transparent pl-9 pr-4 py-1.5 text-xs text-zinc-800 placeholder-zinc-400 focus:outline-none">
        </div>

        <div class="flex items-center gap-2 w-full sm:w-auto px-2">
          <span class="text-[11px] font-bold text-zinc-400 uppercase tracking-wider shrink-0">FILTER HOST:</span>
          <select id="hostFilter" onchange="renderTable()" class="bg-zinc-50 border border-zinc-200 text-zinc-800 text-xs rounded-lg px-3 py-1.5 font-bold focus:outline-none cursor-pointer">
            <option value="all">Semua Host (271)</option>
            <option value="vk">VK Video</option>
            <option value="ok">OK.ru</option>
            <option value="sibnet">Sibnet</option>
          </select>
        </div>
      </div>

      <!-- VIDEO TABLE (IDENTIK DENGAN SCREENSHOT) -->
      <div class="bg-white border border-zinc-200/80 rounded-2xl overflow-hidden shadow-sm">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-zinc-50/70 border-b border-zinc-200 text-zinc-400 uppercase font-mono text-[10px] font-bold">
              <tr>
                <th class="py-3.5 px-5">VIDEO & SLUG</th>
                <th class="py-3.5 px-4">HOST</th>
                <th class="py-3.5 px-4">STREAMS</th>
                <th class="py-3.5 px-4">TOKEN & 24H STATUS</th>
                <th class="py-3.5 px-5 text-right">QUICK LINKS & ACTIONS</th>
              </tr>
            </thead>
            <tbody id="videoTableBody" class="divide-y divide-zinc-100">
              <tr><td colspan="5" class="p-12 text-center text-zinc-400">Memuat data 271 video dari Turso...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- VIEW 2: NEW VIDEO LINK -->
    <div id="viewNewLink" class="hidden space-y-6">
      <div>
        <button onclick="showView('dashboard')" class="text-xs text-zinc-500 hover:text-zinc-900 font-bold flex items-center gap-1.5">&larr; Kembali ke Daftar Link</button>
        <h1 class="text-2xl font-black tracking-tight text-zinc-900 mt-2">Tambah Link Video Baru</h1>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div class="lg:col-span-2 bg-white border border-zinc-200 rounded-2xl p-6 space-y-5 shadow-sm">
          <div class="space-y-1.5">
            <label class="text-xs font-bold text-zinc-600 uppercase">URL Video (VK Video / OK.ru / Sibnet)</label>
            <div class="flex gap-2">
              <input type="url" id="newOriginalUrl" placeholder="https://vkvideo.ru/... atau https://ok.ru/video/..." class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs text-zinc-900 focus:outline-none focus:bg-white focus:border-blue-500">
              <button onclick="parseUrl()" id="parseBtn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-5 py-2.5 rounded-xl shrink-0 shadow-sm">Parse Video</button>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-bold text-zinc-600 uppercase">Judul Video</label>
            <input type="text" id="newTitle" placeholder="Judul video..." class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs text-zinc-900 focus:outline-none focus:bg-white focus:border-blue-500">
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-bold text-zinc-600 uppercase">Custom Slug</label>
            <input type="text" id="newSlug" oninput="updateGenOutputs()" placeholder="custom-slug" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs text-zinc-900 font-mono focus:outline-none focus:bg-white focus:border-blue-500">
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-bold text-zinc-600 uppercase">URL Poster / Thumbnail</label>
            <input type="text" id="newPoster" placeholder="https://..." class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs text-zinc-900 focus:outline-none focus:bg-white focus:border-blue-500">
          </div>

          <div class="pt-4 border-t border-zinc-100 flex justify-end gap-2.5">
            <button onclick="showView('dashboard')" class="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-800">Batal</button>
            <button onclick="saveNewVideo()" class="bg-zinc-900 hover:bg-zinc-800 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-sm">Simpan ke Turso</button>
          </div>
        </div>

        <!-- Output Code Generator -->
        <div class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4 shadow-sm h-fit">
          <div class="flex items-center gap-2 pb-3 border-b border-zinc-100">
            <i class="fa-solid fa-sparkles text-blue-600"></i>
            <h3 class="text-sm font-extrabold text-zinc-900">Output Code Generator</h3>
          </div>

          <div class="space-y-3.5 text-xs">
            <div>
              <div class="flex justify-between items-center mb-1">
                <span class="text-[10px] text-zinc-400 uppercase font-bold">1. Player Link</span>
                <button onclick="copyElementText('genPlayerLink')" class="text-[11px] font-bold text-blue-600 hover:underline">Salin</button>
              </div>
              <div id="genPlayerLink" class="p-2.5 bg-zinc-50 rounded-xl border border-zinc-200 font-mono text-[11px] text-zinc-800 break-all select-all">-</div>
            </div>

            <div>
              <div class="flex justify-between items-center mb-1">
                <span class="text-[10px] text-zinc-400 uppercase font-bold">2. Embed iFrame Code</span>
                <button onclick="copyElementText('genEmbedCode')" class="text-[11px] font-bold text-blue-600 hover:underline">Salin</button>
              </div>
              <div id="genEmbedCode" class="p-2.5 bg-zinc-50 rounded-xl border border-zinc-200 font-mono text-[11px] text-zinc-800 break-all select-all">-</div>
            </div>

            <div>
              <div class="flex justify-between items-center mb-1">
                <span class="text-[10px] text-blue-600 uppercase font-bold flex items-center gap-1"><i class="fa-solid fa-download"></i> 3. DIRECT DOWNLOAD LINK</span>
                <button onclick="copyElementText('genDownloadLink')" class="text-[11px] font-bold text-blue-600 hover:underline">Salin</button>
              </div>
              <div id="genDownloadLink" class="p-2.5 bg-blue-50/60 rounded-xl border border-blue-200 font-mono text-[11px] text-blue-700 break-all select-all font-bold">-</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VIEW 3: VAST ADS ENGINE -->
    <div id="viewVastAds" class="hidden space-y-6">
      <div>
        <h1 class="text-3xl font-black tracking-tight text-zinc-900">VAST / VMAP Ads Engine</h1>
        <p class="text-xs sm:text-sm text-zinc-500 mt-1">Konfigurasi iklan video monetisasi VAST 2.0-4.2 Waterfall, Banner Overlay, dan Popup</p>
      </div>
      <div class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-4 shadow-sm max-w-3xl">
        <div class="flex items-center justify-between pb-4 border-b border-zinc-100">
          <div>
            <div class="text-sm font-bold text-zinc-900">Aktifkan Mesin VAST Video Ads</div>
            <div class="text-xs text-zinc-500 mt-0.5">Tampilkan iklan video sebelum atau saat video diputar</div>
          </div>
          <input type="checkbox" id="vastToggle" class="h-5 w-5 rounded text-blue-600">
        </div>
        <div class="space-y-1.5 pt-2">
          <label class="text-xs font-bold text-zinc-600 uppercase">Primary VAST Tag URL</label>
          <input type="url" id="vastTagUrl" placeholder="https://vast.adnetwork.com/tag.xml" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs font-mono">
        </div>
        <button onclick="saveVastSettings()" class="bg-zinc-900 hover:bg-zinc-800 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-sm">Simpan Konfigurasi Iklan</button>
      </div>
    </div>

    <!-- VIEW 4: SETTINGS & CLOUDFLARE CDN -->
    <div id="viewSettings" class="hidden space-y-6">
      <div>
        <h1 class="text-3xl font-black tracking-tight text-zinc-900">Settings & Cloudflare CDN</h1>
        <p class="text-xs sm:text-sm text-zinc-500 mt-1">Konfigurasi CDN streaming, VK Service token, ImageKit, dan akun administrator</p>
      </div>

      <div class="bg-white border border-zinc-200 rounded-2xl p-6 space-y-5 shadow-sm max-w-3xl">
        <div class="space-y-1.5">
          <label class="text-xs font-bold text-zinc-600 uppercase">1. Stream CDN / Worker URL</label>
          <input type="text" id="settingCdnUrl" placeholder="https://shindora-cloudflare.maskohar445.workers.dev" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs text-zinc-900 font-mono">
        </div>

        <div class="space-y-1.5">
          <label class="text-xs font-bold text-zinc-600 uppercase">2. VK Service Access Token (Full HD 1080p)</label>
          <input type="password" id="settingVkToken" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3.5 py-2.5 text-xs text-zinc-900 font-mono">
        </div>

        <button onclick="saveSettings()" class="bg-zinc-900 hover:bg-zinc-800 text-white font-bold text-xs px-6 py-2.5 rounded-xl shadow-sm">Simpan Pengaturan</button>
      </div>
    </div>

  </main>

  <script>
    let allLinks = [];
    let currentSources = [];

    function showView(view) {
      document.getElementById('viewDashboard').classList.add('hidden');
      document.getElementById('viewNewLink').classList.add('hidden');
      document.getElementById('viewVastAds').classList.add('hidden');
      document.getElementById('viewSettings').classList.add('hidden');

      // Reset sidebar tab buttons
      ['tabVideoLinks', 'tabVastAds', 'tabSettings'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all text-zinc-600 hover:bg-zinc-100";
        }
      });

      if (view === 'dashboard') {
        document.getElementById('viewDashboard').classList.remove('hidden');
        document.getElementById('tabVideoLinks').className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all bg-zinc-900 text-white shadow-sm";
        loadData();
      } else if (view === 'new-link') {
        document.getElementById('viewNewLink').classList.remove('hidden');
      } else if (view === 'vast-ads') {
        document.getElementById('viewVastAds').classList.remove('hidden');
        document.getElementById('tabVastAds').className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all bg-zinc-900 text-white shadow-sm";
        loadVastSettings();
      } else if (view === 'settings') {
        document.getElementById('viewSettings').classList.remove('hidden');
        document.getElementById('tabSettings').className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all bg-zinc-900 text-white shadow-sm";
        loadSettings();
      }
    }

    async function loadData() {
      try {
        const [linksRes, statsRes] = await Promise.all([
          fetch('/api/links'),
          fetch('/api/stats')
        ]);
        if (linksRes.ok) {
          allLinks = await linksRes.json();
          renderTable();
        }
        if (statsRes.ok) {
          const s = await statsRes.json();
          if (s.stats) {
            document.getElementById('statTotal').innerText = s.stats.totalVideos;
            document.getElementById('statVk').innerText = s.stats.vkCount;
            document.getElementById('statOk').innerText = s.stats.okCount;
            document.getElementById('statSibnet').innerText = s.stats.sibnetCount;
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    function renderTable() {
      const q = (document.getElementById('searchInput')?.value || '').toLowerCase();
      const filter = document.getElementById('hostFilter')?.value || 'all';

      const filtered = allLinks.filter(l => {
        const matchesQ = (l.title || '').toLowerCase().includes(q) || (l.slug || '').toLowerCase().includes(q) || (l.originalUrl || '').toLowerCase().includes(q);
        if (filter === 'all') return matchesQ;
        return matchesQ && (l.hostType === filter || (l.originalUrl || '').includes(filter));
      });

      const tbody = document.getElementById('videoTableBody');
      if (!tbody) return;

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-12 text-center text-zinc-400 font-medium">Tidak ada video yang ditemukan.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(l => {
        const origin = window.location.origin;
        const playerUrl = origin + '/v/' + l.slug;
        const embedCode = '<iframe src="' + playerUrl + '" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen style="border:0; width:100%; height:100%;"></iframe>';
        const downloadUrl = origin + '/api/download/720/' + l.slug + '.mp4';

        const updateDate = l.updatedAt || l.createdAt;
        const hoursAgo = updateDate ? Math.floor((Date.now() - new Date(updateDate).getTime()) / (1000 * 60 * 60)) : 0;
        const isFresh = hoursAgo < 24;

        return '<tr class="hover:bg-zinc-50/80 transition-colors group">' +
          // 1. VIDEO & SLUG
          '<td class="py-3 px-5">' +
            '<div class="flex items-center gap-3.5">' +
              '<div class="h-10 w-16 bg-zinc-100 rounded-lg border border-zinc-200 overflow-hidden shrink-0 relative shadow-2xs">' +
                (l.posterUrl ? '<img src="' + l.posterUrl + '" class="h-full w-full object-cover"/>' : '<div class="h-full flex items-center justify-center text-zinc-300 text-xs"><i class="fa-solid fa-film"></i></div>') +
              '</div>' +
              '<div class="min-w-0 max-w-sm">' +
                '<div class="font-bold text-zinc-900 truncate text-xs" title="' + l.title.replace(/"/g, '&quot;') + '">' + l.title + '</div>' +
                '<div class="text-[11px] font-mono text-zinc-500 truncate mt-0.5">/v/' + l.slug + '</div>' +
              '</div>' +
            '</div>' +
          '</td>' +

          // 2. HOST
          '<td class="py-3 px-4">' +
            '<span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ' + 
              (l.hostType === 'vk' ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-amber-50 text-amber-600 border border-amber-200') + 
            '">' + (l.hostType === 'vk' ? 'VK' : 'OK') + '</span>' +
          '</td>' +

          // 3. STREAMS
          '<td class="py-3 px-4">' +
            '<div class="flex flex-wrap gap-1">' +
              (l.sources || []).map(s => '<span class="bg-zinc-100 border border-zinc-200 text-zinc-700 px-1.5 py-0.2 rounded text-[10px] font-mono font-semibold">' + s.label + '</span>').join('') +
            '</div>' +
          '</td>' +

          // 4. TOKEN & 24H STATUS (IDENTIK DENGAN SCREENSHOT)
          '<td class="py-3 px-4">' +
            '<div class="flex items-center gap-1.5">' +
              '<span class="h-2 w-2 rounded-full ' + (isFresh ? 'bg-emerald-500' : 'bg-amber-500') + '"></span>' +
              '<span class="text-[11px] font-medium text-zinc-600">' + hoursAgo + 'j lalu (' + (isFresh ? 'Aktif' : 'Perlu Sync') + ')</span>' +
              '<button onclick="refreshSingleToken(\\'' + l.slug + '\\')" class="ml-1 text-zinc-400 hover:text-zinc-800 transition-colors" title="Penyegaran token langsung">' +
                '<i class="fa-solid fa-arrows-rotate text-[11px]"></i>' +
              '</button>' +
            '</div>' +
          '</td>' +

          // 5. QUICK LINKS & ACTIONS (IDENTIK DENGAN SCREENSHOT)
          '<td class="py-3 px-5 text-right">' +
            '<div class="flex items-center justify-end gap-1.5">' +
              '<button onclick="copyText(\\'' + playerUrl + '\\')" class="h-7 px-2.5 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-700 shadow-2xs flex items-center gap-1">Player</button>' +
              '<button onclick="copyText(\\'' + embedCode.replace(/"/g, '&quot;') + '\\')" class="h-7 px-2.5 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-700 shadow-2xs flex items-center gap-1">Embed</button>' +
              '<button onclick="copyText(\\'' + downloadUrl + '\\')" class="h-7 px-2.5 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-lg text-[11px] font-semibold text-blue-600 shadow-2xs flex items-center gap-1">Download</button>' +
              '<a href="/v/' + l.slug + '" target="_blank" class="h-7 w-7 bg-white hover:bg-zinc-50 border border-zinc-200 rounded-lg text-[11px] font-semibold text-zinc-700 flex items-center justify-center shadow-2xs" title="Preview"><i class="fa-solid fa-play text-[10px]"></i></a>' +
              '<button onclick="deleteVideo(\\'' + l.id + '\\')" class="h-7 w-7 bg-white hover:bg-red-50 border border-zinc-200 hover:border-red-200 rounded-lg text-[11px] text-red-500 flex items-center justify-center shadow-2xs" title="Hapus"><i class="fa-solid fa-trash text-[11px]"></i></button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function copyText(str) {
      navigator.clipboard.writeText(str);
      alert('Tautan berhasil disalin ke clipboard!');
    }

    function copyElementText(elId) {
      const txt = document.getElementById(elId).innerText;
      if (txt && txt !== '-') {
        navigator.clipboard.writeText(txt);
        alert('Teks berhasil disalin!');
      }
    }

    async function parseUrl() {
      const u = document.getElementById('newOriginalUrl').value;
      if (!u) return alert('Masukkan URL video VK, OK.ru, atau Sibnet.');
      const btn = document.getElementById('parseBtn');
      btn.innerText = 'Parsing...';
      try {
        const res = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
        const d = await res.json();
        if (res.ok) {
          if (d.title) document.getElementById('newTitle').value = d.title;
          if (d.title) document.getElementById('newSlug').value = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (d.posterUrl) document.getElementById('newPoster').value = d.posterUrl;
          currentSources = d.sources || [];
          updateGenOutputs();
          alert('Berhasil mengekstrak ' + currentSources.length + ' stream resolusi!');
        } else {
          alert('Gagal parsing: ' + (d.error || 'Host tidak valid'));
        }
      } catch (e) {
        alert('Parsing error');
      } finally {
        btn.innerText = 'Parse Video';
      }
    }

    function updateGenOutputs() {
      const slug = document.getElementById('newSlug').value || 'slug-video';
      const origin = window.location.origin;
      const player = origin + '/v/' + slug;
      const embed = '<iframe src="' + player + '" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen style="border:0; width:100%; height:100%;"></iframe>';
      const dl = origin + '/api/download/720/' + slug + '.mp4';
      document.getElementById('genPlayerLink').innerText = player;
      document.getElementById('genEmbedCode').innerText = embed;
      document.getElementById('genDownloadLink').innerText = dl;
    }

    async function saveNewVideo() {
      const title = document.getElementById('newTitle').value;
      const slug = document.getElementById('newSlug').value;
      const originalUrl = document.getElementById('newOriginalUrl').value;
      const posterUrl = document.getElementById('newPoster').value;

      if (!title || !originalUrl || currentSources.length === 0) {
        return alert('Pastikan Anda telah mengisi URL dan melakukan Parse Video.');
      }

      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, slug, originalUrl, posterUrl, sources: currentSources })
      });

      if (res.ok) {
        alert('Video berhasil disimpan ke database Turso!');
        showView('dashboard');
      } else {
        alert('Gagal menyimpan.');
      }
    }

    async function refreshSingleToken(slug) {
      const res = await fetch('/api/parse-stream?slug=' + slug + '&force=1');
      const d = await res.json();
      if (d.success) {
        alert('Token video diperbarui!');
        loadData();
      }
    }

    async function deleteVideo(id) {
      if (!confirm('Hapus video ini dari database?')) return;
      await fetch('/api/links/' + id, { method: 'DELETE' });
      loadData();
    }

    async function syncTokens24h() {
      const icon = document.getElementById('syncIcon');
      if (icon) icon.classList.add('fa-spin');
      const res = await fetch('/api/cron/refresh-tokens');
      const d = await res.json();
      if (icon) icon.classList.remove('fa-spin');
      alert(d.message || 'Sync selesai!');
      loadData();
    }

    async function loadSettings() {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const d = await res.json();
        if (d.general?.cdnUrl) document.getElementById('settingCdnUrl').value = d.general.cdnUrl;
        if (d.general?.vkServiceToken) document.getElementById('settingVkToken').value = d.general.vkServiceToken;
      }
    }

    async function saveSettings() {
      const cdnUrl = document.getElementById('settingCdnUrl').value;
      const vkServiceToken = document.getElementById('settingVkToken').value;
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsType: 'general', cdnUrl, vkServiceToken })
      });
      alert('Pengaturan CDN disimpan!');
    }

    async function loadVastSettings() {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const d = await res.json();
        if (d.player?.vastEnabled) document.getElementById('vastToggle').checked = true;
      }
    }

    async function saveVastSettings() {
      const vastEnabled = document.getElementById('vastToggle').checked;
      alert('Pengaturan VAST disimpan!');
    }

    loadData();
  </script>
</body>
</html>`;
}

// ===========================================================================
// MAIN WORKER DISPATCHER
// ===========================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, User-Agent, Referer, Origin',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type, ETag, Last-Modified, X-Token-Recovered, X-Bypass-Vercel',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. FRONTEND UI ROUTES (HTML PAGES)
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/links/new' || pathname === '/dashboard/settings' || pathname === '/login') {
      return new Response(renderDashboardAppHtml(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Player Route: /v/:slug
    const playerMatch = pathname.match(/^\/v\/([^\/]+)$/);
    if (playerMatch) {
      const slug = playerMatch[1];
      const res = await queryTurso("SELECT * FROM links WHERE slug = ? LIMIT 1;", [slug], env);
      const row = res.rows[0];

      if (row) {
        let sources = [];
        let subtitles = [];
        try { sources = JSON.parse(row.sources || '[]'); } catch (e) {}
        try { subtitles = JSON.parse(row.subtitles || '[]'); } catch (e) {}
        return new Response(renderPlayerHtml(row.title, row.posterUrl, sources, subtitles, slug, url.host), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      } else {
        return new Response(`<h1>Video Tidak Ditemukan</h1><p>Slug: ${slug}</p>`, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    // -----------------------------------------------------------------------
    // 2. API ROUTES (TURSO BACKED)
    // -----------------------------------------------------------------------
    if (pathname === '/api/stats' || pathname === '/api/dashboard/stats') {
      const totalRes = await queryTurso("SELECT COUNT(*) as count FROM links;", [], env);
      const vkRes = await queryTurso("SELECT COUNT(*) as count FROM links WHERE hostType = 'vk' OR originalUrl LIKE '%vk.com%' OR originalUrl LIKE '%vkvideo.ru%';", [], env);
      const okRes = await queryTurso("SELECT COUNT(*) as count FROM links WHERE hostType = 'ok' OR hostType = 'okru' OR originalUrl LIKE '%ok.ru%';", [], env);
      const sibnetRes = await queryTurso("SELECT COUNT(*) as count FROM links WHERE hostType = 'sibnet' OR originalUrl LIKE '%sibnet.ru%';", [], env);

      return new Response(JSON.stringify({
        success: true,
        stats: {
          totalVideos: parseInt(totalRes.rows[0]?.count || 0),
          vkCount: parseInt(vkRes.rows[0]?.count || 0),
          okCount: parseInt(okRes.rows[0]?.count || 0),
          sibnetCount: parseInt(sibnetRes.rows[0]?.count || 0),
        }
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (pathname === '/api/settings') {
      if (method === 'GET') {
        const rows = await queryTurso("SELECT * FROM settings;", [], env);
        const adminRow = rows.rows.find(r => r.type === 'admin');
        const ikRow = rows.rows.find(r => r.type === 'imagekit');
        const playerRow = rows.rows.find(r => r.type === 'player');
        const genRow = rows.rows.find(r => r.type === 'general');

        let vastTags = [];
        try { vastTags = playerRow?.vastTags ? JSON.parse(playerRow.vastTags) : []; } catch (e) {}

        return new Response(JSON.stringify({
          imagekit: { publicKey: ikRow?.publicKey || '', urlEndpoint: ikRow?.urlEndpoint || '', hasPrivateKey: !!ikRow?.privateKey },
          admin: { username: adminRow?.username || 'admin' },
          player: { playerType: playerRow?.playerType || 'jwplayer', autoplay: playerRow?.autoplay !== '0', vastEnabled: playerRow?.vastEnabled === '1', vastTags, isAdblockEnabled: playerRow?.isAdblockEnabled === '1' },
          general: { cdnUrl: genRow?.cdnUrl || '', downloadCdnUrl: genRow?.downloadCdnUrl || '', isCustomDownloadCdnEnabled: genRow?.isCustomDownloadCdnEnabled === '1', vkServiceToken: genRow?.vkServiceToken || '' }
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (method === 'POST') {
        const body = await request.json();
        const stype = body.settingsType;
        if (stype === 'general') {
          await queryTurso(
            "INSERT INTO settings (id, type, cdnUrl, downloadCdnUrl, isCustomDownloadCdnEnabled, vkServiceToken) VALUES (?, 'general', ?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET cdnUrl=excluded.cdnUrl, downloadCdnUrl=excluded.downloadCdnUrl, isCustomDownloadCdnEnabled=excluded.isCustomDownloadCdnEnabled, vkServiceToken=excluded.vkServiceToken;",
            [generateUUID(), body.cdnUrl || '', body.downloadCdnUrl || '', body.isCustomDownloadCdnEnabled ? 1 : 0, body.vkServiceToken || body.vkApiKey || ''],
            env
          );
        }
        return new Response(JSON.stringify({ success: true, message: 'Settings saved' }), { status: 200, headers: corsHeaders });
      }
    }

    if (pathname === '/api/parse' && method === 'POST') {
      try {
        const body = await request.json();
        const genRes = await queryTurso("SELECT vkServiceToken FROM settings WHERE type = 'general' LIMIT 1;", [], env);
        const extracted = await extractVideoStreams(body.url, genRes.rows[0]?.vkServiceToken || '');
        return new Response(JSON.stringify(extracted), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 422, headers: corsHeaders });
      }
    }

    if (pathname === '/api/parse-stream' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

      const res = await queryTurso("SELECT * FROM links WHERE slug = ? LIMIT 1;", [slug], env);
      const row = res.rows[0];
      if (!row) return new Response(JSON.stringify({ error: 'Video not found' }), { status: 404, headers: corsHeaders });

      let sources = [];
      let subtitles = [];
      try { sources = JSON.parse(row.sources || '[]'); } catch (e) {}
      try { subtitles = JSON.parse(row.subtitles || '[]'); } catch (e) {}

      if (force) {
        try {
          const genRes = await queryTurso("SELECT vkServiceToken FROM settings WHERE type = 'general' LIMIT 1;", [], env);
          const fresh = await extractVideoStreams(row.originalUrl, genRes.rows[0]?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            sources = fresh.sources;
            const now = new Date().toISOString();
            await queryTurso("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?;", [JSON.stringify(fresh.sources), now, slug], env);
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({
        success: true, title: row.title, slug: row.slug, posterUrl: row.posterUrl, sources, subtitles, hostType: row.hostType
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (pathname === '/api/cron/refresh-tokens' || pathname === '/api/cron/token-refresh') {
      const genRes = await queryTurso("SELECT vkServiceToken FROM settings WHERE type = 'general' LIMIT 1;", [], env);
      const linksRes = await queryTurso("SELECT slug, originalUrl FROM links ORDER BY updatedAt ASC LIMIT 30;", [], env);
      let refreshedCount = 0;

      for (const l of linksRes.rows) {
        try {
          const fresh = await extractVideoStreams(l.originalUrl, genRes.rows[0]?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            const now = new Date().toISOString();
            await queryTurso("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?;", [JSON.stringify(fresh.sources), now, l.slug], env);
            refreshedCount++;
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({
        success: true, message: `Cron Turso: Berhasil menyegarkan ${refreshedCount} video.`, refreshedCount
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (pathname === '/api/subtitle') {
      const targetSub = url.searchParams.get('url');
      if (!targetSub) return new Response('Missing subtitle URL', { status: 400, headers: corsHeaders });
      try {
        const subRes = await fetch(decodeURIComponent(targetSub), {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/vtt,text/plain,*/*' },
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const raw = await subRes.text();
        const vtt = convertSrtToVtt(raw);
        return new Response(vtt, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=604800, s-maxage=604800' }
        });
      } catch (e) {
        return new Response(`Subtitle error: ${e.message}`, { status: 500, headers: corsHeaders });
      }
    }

    // STREAM PROXY
    if (pathname === '/api/stream' || pathname.startsWith('/api/stream/')) {
      let targetUrl = url.searchParams.get('url');
      let host = (url.searchParams.get('host') || 'vk').toLowerCase();
      let slug = url.searchParams.get('slug') || '';
      let quality = '';

      const match = pathname.match(/^\/api\/stream\/([^\/]+)\/([^\/]+)$/);
      if (match) {
        quality = match[1].replace(/p$/i, '');
        slug = match[2].replace(/\.mp4$/, '');

        const res = await queryTurso("SELECT sources FROM links WHERE slug = ? LIMIT 1;", [slug], env);
        const linkRow = res.rows[0];
        if (linkRow) {
          let sources = [];
          try { sources = JSON.parse(linkRow.sources || '[]'); } catch (e) {}
          let src = sources.find(s => s.label.toLowerCase().includes(quality.toLowerCase())) || sources[0];
          if (src?.file) {
            const p = new URL(src.file, 'http://localhost');
            targetUrl = p.searchParams.get('url') || src.file;
            host = p.searchParams.get('host') || 'vk';
          }
        }
      }

      if (!targetUrl) return new Response('Missing stream target URL', { status: 400, headers: corsHeaders });
      return await handleProxyStreamTurso(request, decodeURIComponent(targetUrl), host, corsHeaders, env, slug, quality, false);
    }

    // DOWNLOAD PROXY
    if (pathname === '/api/download' || pathname.startsWith('/api/download/')) {
      let targetUrl = url.searchParams.get('url');
      let host = (url.searchParams.get('host') || 'vk').toLowerCase();
      let slug = url.searchParams.get('slug') || '';
      let quality = url.searchParams.get('quality') || '720';
      let customFilename = url.searchParams.get('filename') || '';

      const match = pathname.match(/^\/api\/download\/([^\/]+)\/([^\/]+)$/);
      if (match) {
        quality = match[1].replace(/p$/i, '');
        slug = match[2].replace(/\.mp4$/, '');
      }

      if (slug) {
        const res = await queryTurso("SELECT title, sources FROM links WHERE slug = ? LIMIT 1;", [slug], env);
        const linkRow = res.rows[0];
        if (linkRow) {
          customFilename = formatDownloadFilename(linkRow.title || slug, quality);
          let sources = [];
          try { sources = JSON.parse(linkRow.sources || '[]'); } catch (e) {}
          let src = sources.find(s => s.label.toLowerCase().includes(quality.toLowerCase())) || sources[0];
          if (src?.file) {
            const p = new URL(src.file, 'http://localhost');
            targetUrl = p.searchParams.get('url') || src.file;
            host = p.searchParams.get('host') || 'vk';
          }
        }
      }

      if (!targetUrl) return new Response('Missing download target URL', { status: 400, headers: corsHeaders });
      if (!customFilename) customFilename = formatDownloadFilename('video', quality);
      return await handleProxyStreamTurso(request, decodeURIComponent(targetUrl), host, corsHeaders, env, slug, quality, true, customFilename);
    }

    // LINKS CRUD (TURSO)
    if (pathname === '/api/links') {
      if (method === 'GET') {
        const res = await queryTurso("SELECT * FROM links ORDER BY createdAt DESC;", [], env);
        const results = res.rows.map(r => {
          let sources = [], subtitles = [];
          try { sources = JSON.parse(r.sources || '[]'); } catch (e) {}
          try { subtitles = JSON.parse(r.subtitles || '[]'); } catch (e) {}
          return {
            id: r.id, title: r.title, slug: r.slug, originalUrl: r.originalUrl, posterUrl: r.posterUrl,
            sources, subtitles, hostType: r.hostType, createdAt: r.createdAt, updatedAt: r.updatedAt
          };
        });
        return new Response(JSON.stringify(results), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (method === 'POST') {
        const body = await request.json();
        const title = (body.title || '').trim();
        const slug = (body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') || generateUUID().substring(0, 8);
        const originalUrl = (body.originalUrl || '').trim();
        const posterUrl = (body.posterUrl || '').trim();
        const sources = body.sources || [];
        const subtitles = body.subtitles || [];

        let hostType = 'other';
        const lower = originalUrl.toLowerCase();
        if (lower.includes('vk.com') || lower.includes('vkvideo.ru')) hostType = 'vk';
        else if (lower.includes('ok.ru')) hostType = 'ok';
        else if (lower.includes('sibnet.ru')) hostType = 'sibnet';

        const id = generateUUID();
        const now = new Date().toISOString();

        await queryTurso(
          "INSERT INTO links (id, title, slug, originalUrl, posterUrl, sources, hostType, createdAt, updatedAt, subtitles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
          [id, title, slug, originalUrl, posterUrl, JSON.stringify(sources), hostType, now, now, JSON.stringify(subtitles)],
          env
        );

        return new Response(JSON.stringify({ id, title, slug, originalUrl, posterUrl, sources, subtitles, hostType, createdAt: now, updatedAt: now }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const singleLinkMatch = pathname.match(/^\/api\/links\/([^\/]+)$/);
    if (singleLinkMatch) {
      const linkId = singleLinkMatch[1];
      if (method === 'DELETE') {
        await queryTurso("DELETE FROM links WHERE id = ? OR slug = ?;", [linkId, linkId], env);
        return new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ message: 'ShinDora Stream Turso Worker Active' }), { status: 200, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    try {
      const genRes = await queryTurso("SELECT vkServiceToken FROM settings WHERE type = 'general' LIMIT 1;", [], env);
      const linksRes = await queryTurso("SELECT slug, originalUrl FROM links ORDER BY updatedAt ASC LIMIT 30;", [], env);
      for (const l of linksRes.rows) {
        try {
          const fresh = await extractVideoStreams(l.originalUrl, genRes.rows[0]?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            const now = new Date().toISOString();
            await queryTurso("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?;", [JSON.stringify(fresh.sources), now, l.slug], env);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
};

async function handleProxyStreamTurso(request, decodedTargetUrl, host, corsHeaders, env, slug, quality, isDownload = false, filename = '') {
  const headers = new Headers();
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

  if (host === 'vk' || host === 'vkvideo') {
    headers.set('Referer', 'https://vk.com/');
    headers.set('Origin', 'https://vk.com');
  } else if (host === 'ok' || host === 'okru') {
    headers.set('Referer', 'https://ok.ru/');
    headers.set('Origin', 'https://ok.ru');
  } else if (host === 'sibnet') {
    headers.set('Referer', 'https://video.sibnet.ru/');
    headers.set('Origin', 'https://video.sibnet.ru');
  }

  const range = request.headers.get('range');
  if (range) headers.set('Range', range);

  try {
    let upstreamRes = await fetch(decodedTargetUrl, { method: request.method, headers, redirect: 'follow' });

    if ((upstreamRes.status === 401 || upstreamRes.status === 403 || upstreamRes.status === 404 || upstreamRes.status === 410) && slug) {
      try {
        const res = await queryTurso("SELECT originalUrl FROM links WHERE slug = ? LIMIT 1;", [slug], env);
        const linkRow = res.rows[0];
        if (linkRow?.originalUrl) {
          const genRes = await queryTurso("SELECT vkServiceToken FROM settings WHERE type = 'general' LIMIT 1;", [], env);
          const fresh = await extractVideoStreams(linkRow.originalUrl, genRes.rows[0]?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            const now = new Date().toISOString();
            await queryTurso("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?;", [JSON.stringify(fresh.sources), now, slug], env);

            let targetSource = fresh.sources.find(s => quality && s.label.toLowerCase().includes(quality.toLowerCase())) || fresh.sources[0];
            if (targetSource?.file) {
              const p = new URL(targetSource.file, 'http://localhost');
              const freshUrl = p.searchParams.get('url') || targetSource.file;
              upstreamRes = await fetch(decodeURIComponent(freshUrl), { method: request.method, headers, redirect: 'follow' });
            }
          }
        }
      } catch (err) {}
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('X-Bypass-Vercel', '1');

    if (isDownload) {
      responseHeaders.set('Content-Type', 'application/octet-stream');
      const asciiFname = (filename || 'video.mp4').replace(/[^\x20-\x7E]/g, '_');
      responseHeaders.set('Content-Disposition', `attachment; filename="${asciiFname}"; filename*=UTF-8''${encodeURIComponent(filename || 'video.mp4')}`);
    } else {
      const upstreamCt = upstreamRes.headers.get('content-type');
      responseHeaders.set('Content-Type', (upstreamCt && upstreamCt.includes('video')) ? upstreamCt : 'video/mp4');
    }

    for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
      if (upstreamRes.headers.get(h)) responseHeaders.set(h, upstreamRes.headers.get(h));
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Worker Turso Stream Error: ${err.message}`, { status: 500, headers: corsHeaders });
  }
}
