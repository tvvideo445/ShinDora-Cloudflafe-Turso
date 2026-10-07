/**
 * SHINDORA STREAM - 100% STANDALONE CLOUDFLARE WORKER CONNECTED DIRECTLY TO TURSO (LIBSQL)
 * 
 * Worker ini mandiri 100% dan terhubung langsung ke database Turso:
 * - URL: https://shindora-player-shindora-stream.aws-ap-northeast-1.turso.io
 * - Berisi Full Web UI (Landing Page, Dashboard, Add/Edit Video, Output Generator, Settings, JWPlayer 8)
 * - REST API CRUD langsung membaca dan menulis ke Turso
 * - Streaming & Download Proxy dengan Auto-Recovery 401/403/404/410 langsung update ke Turso
 * - Subtitle Proxy (.srt ke .vtt)
 * - Cron Scheduled Auto-Sync 24 Jam
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
// EMBEDDED HTML APP BUILDER
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
  <title>ShinDora Stream - Turso Edition</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #09090b; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .glass { background: rgba(24, 24, 27, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); }
  </style>
</head>
<body class="min-h-screen flex flex-col justify-between selection:bg-blue-600/30">
  <header class="border-b border-zinc-800 bg-zinc-950/80 sticky top-0 z-50 backdrop-blur-md">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <a href="/" class="flex items-center gap-2.5">
          <div class="h-9 w-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white font-black shadow-lg shadow-blue-500/20">
            <i class="fa-solid fa-play ml-0.5 text-sm"></i>
          </div>
          <span class="font-extrabold text-xl tracking-tight text-white">ShinDora Stream</span>
        </a>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="showView('dashboard')" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
          <i class="fa-solid fa-table-list mr-1.5"></i> Video Links
        </button>
        <button onclick="showView('new-link')" class="text-xs font-bold px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-md">
          <i class="fa-solid fa-plus mr-1"></i> Tambah Video
        </button>
        <button onclick="showView('settings')" class="text-xs font-bold px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200">
          <i class="fa-solid fa-gear mr-1"></i> Settings
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex-1 w-full">
    <!-- VIEW 1: DASHBOARD TABLE -->
    <div id="viewDashboard" class="space-y-6">
      <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 class="text-2xl font-black tracking-tight text-white">Daftar Link Video (Turso LibSQL)</h1>
          <p class="text-xs text-zinc-400 mt-0.5">Terhubung langsung ke database Turso di Cloudflare Edge</p>
        </div>
        <div class="flex gap-2">
          <button onclick="syncTokens24h()" class="text-xs font-bold px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 flex items-center gap-1.5">
            <i class="fa-solid fa-arrows-rotate text-blue-400"></i> Sync Token 24h
          </button>
          <button onclick="showView('new-link')" class="text-xs font-bold px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5">
            <i class="fa-solid fa-plus"></i> Tambah Video Baru
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="p-4 rounded-2xl bg-zinc-900 border border-zinc-800">
          <div class="text-xs font-bold text-zinc-400 uppercase">Total Videos</div>
          <div id="statTotal" class="text-2xl font-black text-white mt-1">271</div>
        </div>
        <div class="p-4 rounded-2xl bg-zinc-900 border border-zinc-800">
          <div class="text-xs font-bold text-blue-400 uppercase">VK Video</div>
          <div id="statVk" class="text-2xl font-black text-blue-400 mt-1">105</div>
        </div>
        <div class="p-4 rounded-2xl bg-zinc-900 border border-zinc-800">
          <div class="text-xs font-bold text-amber-400 uppercase">OK.ru</div>
          <div id="statOk" class="text-2xl font-black text-amber-400 mt-1">166</div>
        </div>
        <div class="p-4 rounded-2xl bg-zinc-900 border border-zinc-800">
          <div class="text-xs font-bold text-purple-400 uppercase">Sibnet</div>
          <div id="statSibnet" class="text-2xl font-black text-purple-400 mt-1">0</div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-zinc-900 border border-zinc-800 flex gap-3">
        <input type="text" id="searchInput" oninput="renderTable()" placeholder="Cari judul, slug, atau URL..." class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-blue-500">
      </div>

      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-zinc-950/60 border-b border-zinc-800 text-zinc-400 uppercase font-mono text-[10px]">
              <tr>
                <th class="py-3 px-4">Video & Slug</th>
                <th class="py-3 px-4">Host</th>
                <th class="py-3 px-4">Streams</th>
                <th class="py-3 px-4 text-right">Quick Links & Actions</th>
              </tr>
            </thead>
            <tbody id="videoTableBody" class="divide-y divide-zinc-800">
              <tr><td colspan="4" class="p-8 text-center text-zinc-500">Memuat data video dari Turso...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- VIEW 2: NEW VIDEO LINK -->
    <div id="viewNewLink" class="hidden space-y-6">
      <div class="flex items-center gap-2">
        <button onclick="showView('dashboard')" class="text-xs text-zinc-400 hover:text-white">&larr; Kembali ke Daftar</button>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div class="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4">
          <h2 class="text-lg font-bold text-white">Tambah Link Video Baru</h2>
          
          <div class="space-y-1">
            <label class="text-xs font-bold text-zinc-400 uppercase">URL Video (VK / OK.ru / Sibnet)</label>
            <div class="flex gap-2">
              <input type="url" id="newOriginalUrl" placeholder="https://vkvideo.ru/... atau https://ok.ru/video/..." class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white">
              <button onclick="parseUrl()" id="parseBtn" class="bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs px-4 py-2 rounded-lg shrink-0">Parse Video</button>
            </div>
          </div>

          <div class="space-y-1">
            <label class="text-xs font-bold text-zinc-400 uppercase">Judul Video</label>
            <input type="text" id="newTitle" class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white">
          </div>

          <div class="space-y-1">
            <label class="text-xs font-bold text-zinc-400 uppercase">Custom Slug</label>
            <input type="text" id="newSlug" class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-mono">
          </div>

          <div class="space-y-1">
            <label class="text-xs font-bold text-zinc-400 uppercase">URL Thumbnail Poster</label>
            <input type="text" id="newPoster" class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white">
          </div>

          <div class="pt-2 border-t border-zinc-800 flex justify-end gap-2">
            <button onclick="showView('dashboard')" class="px-4 py-2 text-xs text-zinc-400">Batal</button>
            <button onclick="saveNewVideo()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs px-5 py-2 rounded-lg">Simpan ke Turso</button>
          </div>
        </div>

        <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4">
          <h3 class="text-sm font-bold text-blue-400 flex items-center gap-1.5"><i class="fa-solid fa-sparkles"></i> Output Generator</h3>
          <div class="space-y-3 text-xs">
            <div>
              <div class="text-[10px] text-zinc-400 uppercase font-bold mb-1">Player Link:</div>
              <div id="genPlayerLink" class="p-2 bg-zinc-950 rounded border border-zinc-800 font-mono text-[11px] break-all select-all">-</div>
            </div>
            <div>
              <div class="text-[10px] text-zinc-400 uppercase font-bold mb-1">Embed iFrame:</div>
              <div id="genEmbedCode" class="p-2 bg-zinc-950 rounded border border-zinc-800 font-mono text-[11px] break-all select-all">-</div>
            </div>
            <div>
              <div class="text-[10px] text-zinc-400 uppercase font-bold mb-1">Direct Download Link:</div>
              <div id="genDownloadLink" class="p-2 bg-zinc-950 rounded border border-zinc-800 font-mono text-[11px] break-all select-all text-blue-400">-</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- VIEW 3: SETTINGS -->
    <div id="viewSettings" class="hidden space-y-6">
      <div class="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4 max-w-2xl mx-auto">
        <h2 class="text-lg font-bold text-white flex items-center gap-2"><i class="fa-solid fa-gear text-blue-500"></i> Pengaturan CDN & Admin</h2>
        
        <div class="space-y-1">
          <label class="text-xs font-bold text-zinc-400 uppercase">Stream CDN / Worker Domain</label>
          <input type="text" id="settingCdnUrl" placeholder="https://shindora-cloudflare.maskohar445.workers.dev" class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-mono">
        </div>

        <div class="space-y-1">
          <label class="text-xs font-bold text-zinc-400 uppercase">VK Service Token (Opsional Full HD 1080p)</label>
          <input type="password" id="settingVkToken" class="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-mono">
        </div>

        <button onclick="saveSettings()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs px-5 py-2.5 rounded-lg w-full">Simpan Pengaturan</button>
      </div>
    </div>
  </main>

  <footer class="border-t border-zinc-800 py-4 text-center text-xs text-zinc-500">
    ShinDora Stream &copy; 2026 · Powered by Cloudflare Workers & Turso Database
  </footer>

  <script>
    let allLinks = [];
    let currentSources = [];

    function showView(view) {
      document.getElementById('viewDashboard').classList.add('hidden');
      document.getElementById('viewNewLink').classList.add('hidden');
      document.getElementById('viewSettings').classList.add('hidden');
      if (view === 'dashboard') {
        document.getElementById('viewDashboard').classList.remove('hidden');
        loadData();
      } else if (view === 'new-link') {
        document.getElementById('viewNewLink').classList.remove('hidden');
      } else if (view === 'settings') {
        document.getElementById('viewSettings').classList.remove('hidden');
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
      const filtered = allLinks.filter(l => (l.title || '').toLowerCase().includes(q) || (l.slug || '').toLowerCase().includes(q));
      const tbody = document.getElementById('videoTableBody');
      if (!tbody) return;

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-8 text-center text-zinc-500">Tidak ada video yang ditemukan.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(l => {
        const domain = window.location.host;
        const playerUrl = window.location.origin + '/v/' + l.slug;
        const embedCode = '<iframe src="' + playerUrl + '" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>';
        const downloadUrl = window.location.origin + '/api/download/720/' + l.slug + '.mp4';

        return '<tr class="hover:bg-zinc-800/40 transition-colors">' +
          '<td class="py-3 px-4">' +
            '<div class="flex items-center gap-3">' +
              '<div class="h-9 w-14 bg-zinc-800 rounded overflow-hidden shrink-0">' +
                (l.posterUrl ? '<img src="' + l.posterUrl + '" class="h-full w-full object-cover"/>' : '<div class="h-full flex items-center justify-center text-zinc-600 text-xs"><i class="fa-solid fa-film"></i></div>') +
              '</div>' +
              '<div>' +
                '<div class="font-bold text-white truncate max-w-xs">' + l.title + '</div>' +
                '<div class="text-[11px] font-mono text-blue-400">/v/' + l.slug + '</div>' +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td class="py-3 px-4"><span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ' + (l.hostType === 'vk' ? 'bg-blue-500/10 text-blue-400' : 'bg-amber-500/10 text-amber-400') + '">' + (l.hostType || 'VK') + '</span></td>' +
          '<td class="py-3 px-4">' +
            '<div class="flex flex-wrap gap-1">' + (l.sources || []).map(s => '<span class="bg-zinc-800 px-1.5 py-0.5 rounded text-[10px] font-mono">' + s.label + '</span>').join('') + '</div>' +
          '</td>' +
          '<td class="py-3 px-4 text-right">' +
            '<div class="flex items-center justify-end gap-1.5">' +
              '<button onclick="copyText(\\'' + playerUrl + '\\')" class="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[11px] font-semibold text-zinc-200">Player</button>' +
              '<button onclick="copyText(\\'' + embedCode.replace(/"/g, '&quot;') + '\\')" class="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[11px] font-semibold text-zinc-200">Embed</button>' +
              '<button onclick="copyText(\\'' + downloadUrl + '\\')" class="px-2 py-1 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded text-[11px] font-semibold">Download</button>' +
              '<a href="/v/' + l.slug + '" target="_blank" class="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[11px] font-semibold text-zinc-200"><i class="fa-solid fa-play"></i></a>' +
              '<button onclick="deleteVideo(\\'' + l.id + '\\')" class="px-2 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded text-[11px]"><i class="fa-solid fa-trash"></i></button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function copyText(str) {
      navigator.clipboard.writeText(str);
      alert('Tautan disalin ke clipboard!');
    }

    async function parseUrl() {
      const u = document.getElementById('newOriginalUrl').value;
      if (!u) return alert('Masukkan URL video terlebih dahulu');
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
          alert('Berhasil mengekstrak ' + currentSources.length + ' resolusi!');
        } else {
          alert('Gagal parsing: ' + (d.error || 'Unknown error'));
        }
      } catch (e) {
        alert('Parsing error');
      } finally {
        btn.innerText = 'Parse Video';
      }
    }

    function updateGenOutputs() {
      const slug = document.getElementById('newSlug').value || 'slug-video';
      const player = window.location.origin + '/v/' + slug;
      const embed = '<iframe src="' + player + '" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>';
      const dl = window.location.origin + '/api/download/720/' + slug + '.mp4';
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
        alert('Video berhasil disimpan ke Turso Database!');
        showView('dashboard');
      } else {
        alert('Gagal menyimpan.');
      }
    }

    async function deleteVideo(id) {
      if (!confirm('Hapus video ini?')) return;
      await fetch('/api/links/' + id, { method: 'DELETE' });
      loadData();
    }

    async function syncTokens24h() {
      const res = await fetch('/api/cron/refresh-tokens');
      const d = await res.json();
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
      alert('Pengaturan disimpan!');
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
