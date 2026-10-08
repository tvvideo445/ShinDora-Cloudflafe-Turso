/**
 * SHINDORA STREAM - 100% STANDALONE CLOUDFLARE WORKER CONNECTED DIRECTLY TO TURSO (LIBSQL)
 * 
 * Desain UI Terang 100% IDENTIK dengan screenshot resmi gdriveplayer.my.id:
 * 1. Header: Logo ShinDora CDN
 * 2. Sidebar: Video Links, VAST Ads, Settings, Logged in as Wibukohar
 * 3. Dashboard: Video Stream Links, + Tambah Link Baru, 4 Stats Cards (Total, VK, OK.ru, Sibnet)
 * 4. Daftar Video & Status Token: Checkbox, Video & Host, Status Token & 24h, Slug/Embed, Kualitas Stream, Tanggal Dibuat, Aksi
 * 5. Tambah Link Baru: Metadata Video, Subtitle Video, Stream Sources, Output Code Generator (1. Direct Stream, 2. Player Link, 3. Embed iFrame, 4. DIRECT DOWNLOAD LINK)
 * 6. VAST Ads Engine: Multiple Waterfall, Banner, Popups, Live Uji Tag VAST
 * 7. Settings: JW Player & Test, VAST Ads & Tester, CDN Cloudflare, ImageKit SDK, Akun Admin, Live Preview JW Player
 * 8. Player Embed: JWPlayer 8 dengan Seek +10s/-10s, Skip Opening Anime, Smart TV D-Pad, Event SHINDORA_VIDEO_ENDED
 */

const TURSO_DEFAULT_URL = "https://shindora-player-shindora-stream.aws-ap-northeast-1.turso.io"; // Prefer TURSO_DATABASE_URL in env.
const TURSO_DEFAULT_TOKEN = ""; // Set TURSO_AUTH_TOKEN as a Cloudflare Secret. Never hardcode it.

// ===========================================================================
// TURSO HTTP PIPELINE QUERY HELPER
// ===========================================================================
async function queryTurso(sql, args = [], env = null) {
  const url = ((env?.TURSO_DATABASE_URL || TURSO_DEFAULT_URL).replace('libsql://', 'https://').replace(/\/+$/, '')) + '/v2/pipeline';
  const token = env?.TURSO_AUTH_TOKEN || TURSO_DEFAULT_TOKEN;
  if (!token) throw new Error("TURSO_AUTH_TOKEN belum dikonfigurasi sebagai Cloudflare Secret.");

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[ch]));
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
// EMBEDDED LIGHT THEME HTML DASHBOARD (100% IDENTIK DENGAN SCREENSHOT)
// ===========================================================================
function renderPlayerHtml(title, posterUrl, sources, subtitles, slug, domain, playerSettings = {}) {
  const skipEnabled = playerSettings.skipOpeningEnabled !== false;
  const skipDuration = Math.max(0, Number(playerSettings.skipOpeningDuration || 60));
  const autoplay = playerSettings.autoplay !== false;
  const vastEnabled = playerSettings.vastEnabled === true;
  const vastTags = Array.isArray(playerSettings.vastTags) ? playerSettings.vastTags : [];
  const subtitleTracks = (subtitles || []).map((sub, idx) => ({
    file: sub.file || `/api/subtitle?slug=${encodeURIComponent(slug)}&index=${idx}`,
    label: sub.label || sub.language || ('Subtitle ' + (idx + 1)),
    kind: 'captions',
    default: idx === 0
  }));

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <title>${escapeHtml(title || 'ShinDora Player')}</title>
  <script src="https://content.jwplatform.com/libraries/IDzF9Zmk.js"></script>
  <style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#000;color:#fff;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    #jwplayer-container{position:absolute;inset:0;width:100%;height:100%}
    .skip-opening-btn{position:absolute;right:max(16px,env(safe-area-inset-right));bottom:72px;z-index:60;background:rgba(0,0,0,.9);border:1px solid rgba(255,255,255,.28);border-radius:12px;padding:6px;display:none;align-items:center;gap:6px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    .skip-opening-btn button{border:0;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:800;cursor:pointer}
    #skipBtn{background:#fff;color:#000}.skip-close{background:transparent!important;color:#fff;border:1px solid rgba(255,255,255,.25)!important}
    .player-error{position:absolute;inset:0;z-index:70;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.9);padding:24px;text-align:center}
    .player-error-card{max-width:420px;border:1px solid #2b2b2b;border-radius:14px;padding:20px;background:#111}
    .player-error button{margin-top:12px;border:0;border-radius:8px;padding:8px 14px;font-weight:800;cursor:pointer}
    @media(max-width:640px){.skip-opening-btn{bottom:58px}.skip-opening-btn button{padding:7px 10px;font-size:11px}}
  </style>
</head>
<body>
  <div id="jwplayer-container"></div>
  <div id="skipOpening" class="skip-opening-btn">
    <button id="skipBtn">⏭ Skip Opening (${Math.floor(skipDuration/60).toString().padStart(2,'0')}:${Math.floor(skipDuration%60).toString().padStart(2,'0')})</button>
    <button id="closeSkip" class="skip-close">✕</button>
  </div>
  <div id="playerError" class="player-error">
    <div class="player-error-card">
      <div style="font-weight:800;font-size:15px">Pemutaran mengalami masalah</div>
      <div id="playerErrorText" style="margin-top:7px;color:#aaa;font-size:12px">Mencoba memperbarui source video…</div>
      <button id="retryBtn">Coba Lagi</button>
    </div>
  </div>
  <script>
    const title=${JSON.stringify(title || 'ShinDora Player')};
    const poster=${JSON.stringify(posterUrl || '')};
    const slug=${JSON.stringify(slug)};
    const autoplay=${JSON.stringify(autoplay)};
    const skipEnabled=${JSON.stringify(skipEnabled)};
    const skipDuration=${JSON.stringify(skipDuration)};
    const vastEnabled=${JSON.stringify(vastEnabled)};
    const vastTags=${JSON.stringify(vastTags)};
    const rawSources=${JSON.stringify(sources || [])};
    const rawSubtitles=${JSON.stringify(subtitleTracks)};

    let player=null;
    let skipDismissed=false;
    let retrying=false;
    let retries=0;
    let lastPosition=0;

    function buildSources(list){
      return (list||[]).filter(Boolean).map(s=>({
        file:s.file && s.file.startsWith('http') ? s.file : (window.location.origin + (s.file||'')),
        label:s.label||'Default', type:s.type||'video/mp4'
      }));
    }
    function buildTracks(list){
      return (list||[]).filter(Boolean).map(s=>({
        file:s.file && s.file.startsWith('http') ? s.file : (window.location.origin + (s.file||'')),
        label:s.label||'Subtitle',kind:'captions',default:!!s.default
      }));
    }
    function showError(msg){
      document.getElementById('playerErrorText').textContent=msg||'Video gagal diputar.';
      document.getElementById('playerError').style.display='flex';
    }
    function hideError(){document.getElementById('playerError').style.display='none'}
    function doSeek(delta){
      if(!player) return;
      const pos=Number(player.getPosition?.()||0), dur=Number(player.getDuration?.()||0);
      player.seek(Math.max(0, Math.min(dur>0?dur:pos+delta, pos+delta)));
    }
    function safePlay(){try{const p=player?.getState?.();if(p==='paused'||p==='idle'){const r=player.play(); if(r&&r.catch) r.catch(()=>{})}}catch(e){}}

    function setup(){
      if(!window.jwplayer) return showError('JW Player gagal dimuat.');
      const jwSources=buildSources(rawSources);
      const jwTracks=buildTracks(rawSubtitles);
      player=window.jwplayer('jwplayer-container').setup({
        playlist:[{title,image:poster,sources:jwSources,tracks:jwTracks}],
        autostart:autoplay,width:'100%',height:'100%',controls:true,displaytitle:true,stretching:'uniform',preload:'metadata'
      });

      try{
        const rewind='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon></svg>';
        const forward='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 19"></polygon></svg>';
        player.addButton(rewind,'Mundur 10s',()=>doSeek(-10),'jw-btn-rewind-10');
        player.addButton(forward,'Maju 10s',()=>doSeek(10),'jw-btn-forward-10');
      }catch(e){}

      player.on('time',e=>{
        lastPosition=Number(e?.position||0);
        const isAnime=/doraemon|shin-chan|shinchan/i.test(title);
        const skip=document.getElementById('skipOpening');
        if(skipEnabled && isAnime && !skipDismissed && lastPosition>=0 && lastPosition<skipDuration){skip.style.display='flex'} else {skip.style.display='none'}
      });
      player.on('beforePlay',()=>hideError());
      player.on('error',()=>recoverSource());
      player.on('complete',()=>{
        try{if(window.parent&&window.parent!==window)window.parent.postMessage({event:'SHINDORA_VIDEO_ENDED',slug},'*')}catch(e){}
      });
      document.getElementById('skipBtn').onclick=()=>{try{player.seek(skipDuration)}catch(e){};document.getElementById('skipOpening').style.display='none'};
      document.getElementById('closeSkip').onclick=()=>{skipDismissed=true;document.getElementById('skipOpening').style.display='none'};
    }

    async function recoverSource(){
      if(retrying || retries>=2){showError('Source video tidak tersedia. Silakan coba lagi.');return}
      retrying=true; retries++;
      lastPosition=Number(player?.getPosition?.()||lastPosition||0);
      document.getElementById('playerErrorText').textContent='Mengambil source video terbaru…';
      try{
        const r=await fetch('/api/parse-stream?slug='+encodeURIComponent(slug)+'&force=1',{cache:'no-store'});
        const d=await r.json();
        if(!r.ok||!d.sources?.length) throw new Error(d.error||'Tidak ada source baru');
        player.load([{title,image:poster,sources:buildSources(d.sources),tracks:buildTracks(d.subtitles||rawSubtitles)}]);
        player.once('firstFrame',()=>{try{player.seek(lastPosition);safePlay()}catch(e){}});
        hideError();
      }catch(e){showError(e.message||'Gagal memperbarui source video.')}
      finally{retrying=false}
    }
    document.getElementById('retryBtn').onclick=()=>{retries=0;recoverSource()};

    window.addEventListener('keydown',e=>{
      const t=e.target;
      if(t && ['INPUT','TEXTAREA','SELECT'].includes(t.tagName)) return;
      if(!player) return;
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter',' '].includes(e.key)) e.preventDefault();
      if(e.key==='ArrowLeft') doSeek(-10);
      else if(e.key==='ArrowRight') doSeek(10);
      else if(e.key==='ArrowUp') {try{player.setVolume(Math.min(100,(player.getVolume?.()||0)+10))}catch(err){}}
      else if(e.key==='ArrowDown') {try{player.setVolume(Math.max(0,(player.getVolume?.()||0)-10))}catch(err){}}
      else if(e.key==='Enter'||e.key===' ') {try{const s=player.getState?.(); s==='playing'?player.pause():safePlay()}catch(err){}}
      else if(e.key==='Escape') {try{if(document.fullscreenElement)document.exitFullscreen()}catch(err){}}
    });

    setup();
  </script>
</body>
</html>`;
}

function renderDashboardAppHtml(initialView = 'dashboard', initialSettings = {}) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>ShinDora CDN</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <style>
    body{background:#fff;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
    .sidebar-active{background:#0f172a!important;color:#fff!important}.panel{border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 1px 2px rgba(15,23,42,.03)}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:9px;padding:.58rem .85rem;font-size:12px;font-weight:800;transition:.18s}.btn-dark{background:#0f172a;color:#fff}.btn-dark:hover{background:#1e293b}.btn-soft{border:1px solid #e2e8f0;background:#fff;color:#334155}.btn-soft:hover{background:#f8fafc}.btn-danger{border:1px solid #fecaca;background:#fff;color:#dc2626}.input{width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:.58rem .7rem;font-size:12px;outline:none}.input:focus{border-color:#94a3b8;box-shadow:0 0 0 3px rgba(148,163,184,.13)}
    .subtab-active{background:#fff;border:1px solid #e2e8f0;color:#0f172a;box-shadow:0 1px 2px rgba(15,23,42,.04)}.subtab{color:#64748b}.hidden{display:none!important}.toast{position:fixed;right:18px;bottom:18px;z-index:9999;max-width:360px;background:#0f172a;color:#fff;border-radius:10px;padding:11px 14px;font-size:12px;font-weight:700;box-shadow:0 14px 38px rgba(15,23,42,.25)}
    .host-badge{font-size:9px;font-weight:900;padding:3px 6px;border-radius:999px}.thumb{width:64px;height:40px;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;background:#f8fafc}.table-wrap{overflow:auto}.table-wrap::-webkit-scrollbar{height:7px}.table-wrap::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:10px}
    .codebox{background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:9px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;min-height:38px}.status-dot{width:7px;height:7px;border-radius:50%;display:inline-block}.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:1000;display:flex;align-items:center;justify-content:center;padding:18px}.modal{width:min(760px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:18px;border:1px solid #e2e8f0;box-shadow:0 24px 80px rgba(15,23,42,.25)}
    @media(max-width:900px){.sidebar{width:100%!important;min-height:auto!important;border-right:0!important;border-bottom:1px solid #e2e8f0}.main{padding:20px!important}}
  </style>
</head>
<body class="min-h-screen flex flex-col md:flex-row">
  <aside class="sidebar w-64 bg-white border-r border-slate-200 p-5 flex flex-col justify-between shrink-0 min-h-screen">
    <div class="space-y-7">
      <a href="/dashboard" class="flex items-center gap-3"><i class="fa-solid fa-table-cells-large text-xl"></i><span class="font-black text-lg tracking-tight">ShinDora CDN</span></a>
      <nav class="space-y-2">
        <button id="tabVideoLinks" onclick="showView('dashboard')" class="w-full flex items-center gap-3 px-3.5 py-3 rounded-lg text-sm font-semibold sidebar-active"><i class="fa-solid fa-link w-4"></i><span>Video Links</span></button>
        <button id="tabVastAds" onclick="showView('vast-ads')" class="w-full flex items-center gap-3 px-3.5 py-3 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-50"><i class="fa-solid fa-tv w-4"></i><span>VAST Ads</span></button>
        <button id="tabSettings" onclick="showView('settings')" class="w-full flex items-center gap-3 px-3.5 py-3 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-50"><i class="fa-solid fa-gear w-4"></i><span>Settings</span></button>
      </nav>
    </div>
    <div class="pt-5 mt-6 border-t border-slate-100 space-y-3">
      <div class="flex items-center gap-3"><i class="fa-solid fa-user text-slate-400 text-sm"></i><div><div class="text-[11px] text-slate-400">Logged in as</div><div id="loggedUser" class="text-xs font-bold text-slate-800">-</div></div></div>
      <button onclick="logoutAdmin()" class="flex items-center gap-2 text-xs font-bold text-red-500"><i class="fa-solid fa-arrow-right-from-bracket"></i><span>Sign Out</span></button>
    </div>
  </aside>

  <main class="main flex-1 p-8 md:p-10 max-w-[1500px] mx-auto w-full">
    <section id="viewDashboard" class="space-y-6">
      <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"><div><h1 class="text-3xl font-black tracking-tight">Video Stream Links</h1><p class="text-xs sm:text-sm text-slate-500 mt-1">Kelola link proxy video VK, OK.ru, dan Sibnet dengan status token, auto 24h refresh & pemutar JW Player.</p></div><div class="flex gap-2"><button onclick="loadData()" class="btn btn-soft"><i class="fa-solid fa-arrows-rotate"></i> Refresh</button><button onclick="openNewVideo()" class="btn btn-dark"><i class="fa-solid fa-plus"></i> Tambah Link Baru</button></div></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="panel p-5"><div class="flex justify-between text-xs font-bold text-slate-600"><span>Total Video</span><i class="fa-solid fa-film"></i></div><div id="statTotal" class="text-3xl font-black mt-3">0</div><div class="text-[11px] text-slate-400 mt-1">Video aktif dalam sistem</div></div>
        <div class="panel p-5"><div class="flex justify-between text-xs font-bold text-slate-600"><span>VK Video Links</span><i class="fa-solid fa-video text-blue-500"></i></div><div id="statVk" class="text-3xl font-black text-blue-600 mt-3">0</div><div class="text-[11px] text-slate-400 mt-1">Menggunakan proxy VK</div></div>
        <div class="panel p-5"><div class="flex justify-between text-xs font-bold text-slate-600"><span>OK.ru Links</span><i class="fa-solid fa-video text-orange-500"></i></div><div id="statOk" class="text-3xl font-black text-orange-500 mt-3">0</div><div class="text-[11px] text-slate-400 mt-1">Menggunakan proxy OK.ru</div></div>
        <div class="panel p-5"><div class="flex justify-between text-xs font-bold text-slate-600"><span>Sibnet Links</span><i class="fa-solid fa-video text-emerald-500"></i></div><div id="statSibnet" class="text-3xl font-black text-emerald-600 mt-3">0</div><div class="text-[11px] text-slate-400 mt-1">Menggunakan proxy Sibnet</div></div>
      </div>
      <div class="panel p-5 md:p-6 space-y-5">
        <div class="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4"><div><h2 class="text-base font-bold">Daftar Video & Status Token</h2><p class="text-xs text-slate-400 mt-0.5">Status source dihitung dari waktu pembaruan terakhir.</p></div><div class="flex flex-col sm:flex-row gap-2"><select id="hostFilter" onchange="page=1;renderTable()" class="input sm:w-44"><option value="all">Semua Host</option><option value="vk">VK Video</option><option value="ok">OK.ru</option><option value="sibnet">Sibnet</option></select><div class="relative sm:w-64"><i class="fa-solid fa-magnifying-glass absolute left-3 top-3 text-slate-400 text-xs"></i><input id="searchInput" oninput="page=1;renderTable()" class="input pl-8" placeholder="Cari judul, slug..."></div></div></div>
        <div id="bulkBar" class="hidden items-center justify-between gap-2 rounded-xl bg-slate-50 border border-slate-200 p-3"><div class="text-xs font-bold"><span id="selectedCount">0</span> dipilih</div><button onclick="deleteSelected()" class="btn btn-danger"><i class="fa-solid fa-trash"></i> Hapus Terpilih</button></div>
        <div class="table-wrap"><table class="w-full text-left text-xs min-w-[1050px]"><thead class="border-b border-slate-100 text-slate-400 uppercase font-mono text-[10px] font-bold"><tr><th class="py-3 px-2"><input id="selectAll" type="checkbox" onchange="toggleAll(this)"></th><th class="py-3 px-3">VIDEO & HOST</th><th class="py-3 px-3">STATUS TOKEN & 24H</th><th class="py-3 px-3">SLUG / EMBED</th><th class="py-3 px-3">KUALITAS STREAM</th><th class="py-3 px-3">TANGGAL DIBUAT</th><th class="py-3 px-3 text-right">AKSI</th></tr></thead><tbody id="videoTableBody"><tr><td colspan="7" class="p-10 text-center text-slate-400">Memuat data...</td></tr></tbody></table></div>
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2"><div id="pageInfo" class="text-xs text-slate-400">0 data</div><div class="flex items-center gap-2"><select id="pageSize" class="input w-24" onchange="page=1;renderTable()"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select><button onclick="page=Math.max(1,page-1);renderTable()" class="btn btn-soft"><i class="fa-solid fa-chevron-left"></i></button><button onclick="page=page+1;renderTable()" class="btn btn-soft"><i class="fa-solid fa-chevron-right"></i></button></div></div>
      </div>
    </section>

    <section id="viewNewLink" class="hidden space-y-6">
      <div class="flex items-center justify-between"><div><h1 id="newLinkHeading" class="text-2xl font-black">Tambah Link Baru</h1><p class="text-xs text-slate-400 mt-1">Metadata video, subtitle, source dan generator output.</p></div><button onclick="showView('dashboard')" class="btn btn-soft"><i class="fa-solid fa-arrow-left"></i> Kembali</button></div>
      <div class="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div class="xl:col-span-2 panel p-6 space-y-5">
          <div><div class="text-base font-bold">Metadata Video</div><div class="text-xs text-slate-400 mt-1">Masukkan URL VK, OK.ru atau Sibnet lalu Parse Video.</div></div>
          <div><label class="text-xs font-bold">URL Video VK / OK.ru / Sibnet</label><div class="flex gap-2 mt-1.5"><input id="newOriginalUrl" class="input" placeholder="https://..."><button id="parseBtn" onclick="parseUrl()" class="btn btn-dark shrink-0">Parse Video</button></div></div>
          <div><label class="text-xs font-bold">Judul Video</label><input id="newTitle" class="input mt-1.5"></div>
          <div><label class="text-xs font-bold">Custom Slug (Opsional)</label><input id="newSlug" oninput="updateGenOutputs()" class="input mt-1.5 font-mono"></div>
          <div><label class="text-xs font-bold">URL Poster / Thumbnail</label><div class="flex gap-2 mt-1.5"><input id="newPoster" class="input" placeholder="https://ik.imagekit.io/..."><button onclick="uploadImageKit('thumbnail')" class="btn btn-soft shrink-0"><i class="fa-solid fa-cloud-arrow-up"></i> Upload</button></div><input id="thumbFile" type="file" accept="image/*" class="hidden" onchange="handleImageFile(this)"><button onclick="document.getElementById('thumbFile').click()" class="text-[11px] text-slate-500 mt-2">Pilih file thumbnail dari komputer</button><img id="thumbPreview" class="hidden mt-3 w-40 h-24 rounded-lg object-cover border" alt="Preview"></div>
          <div class="pt-4 border-t border-slate-100"><div class="flex items-center justify-between"><div><div class="text-xs font-bold">Subtitle Video</div><div class="text-[11px] text-slate-400">Support URL .vtt/.srt atau upload file teks yang akan disimpan di Turso.</div></div><button onclick="addSubtitleRow()" class="btn btn-soft">+ Tambah Subtitle</button></div><div id="subtitleList" class="space-y-2 mt-3"></div></div>
          <div class="pt-4 border-t border-slate-100"><div class="text-xs font-bold">Stream Sources <span id="sourceCount" class="text-slate-400">(0)</span></div><div id="sourcesBox" class="space-y-2 mt-3 p-4 bg-slate-50/60 rounded-xl border border-slate-200 text-xs text-slate-400">Belum ada stream source.</div></div>
          <div class="pt-4 border-t border-slate-100 flex justify-between"><button onclick="showView('dashboard')" class="btn btn-soft">Batal</button><button onclick="saveNewVideo()" class="btn btn-dark"><i class="fa-solid fa-floppy-disk"></i> <span id="saveVideoLabel">Simpan Link Video</span></button></div>
        </div>
        <div class="panel p-6 space-y-4 h-fit"><div class="flex items-center gap-2 pb-3 border-b border-slate-100"><i class="fa-solid fa-wand-magic-sparkles"></i><div class="text-sm font-extrabold">Output Code Generator</div></div><p class="text-[11px] text-slate-400">Link diperbarui realtime berdasarkan slug dan kualitas.</p><div><label class="text-[10px] font-bold text-slate-400 uppercase">Quality Direct Link</label><select id="genQuality" onchange="updateGenOutputs()" class="input mt-1.5"><option value="1080">1080p Full HD</option><option value="720" selected>720p HD</option><option value="480">480p SD</option><option value="360">360p Low</option></select></div>${[['Direct Stream Link','genDirectStreamLink'],['Player Link','genPlayerLink'],['Embed iFrame Code','genEmbedCode'],['Direct Download Link','genDownloadLink']].map((x,i)=>`<div><div class="flex justify-between items-center mb-1"><span class="text-[10px] font-bold text-slate-500 uppercase">${i+1}. ${x[0]}</span><button onclick="copyElementText('${x[1]}')" class="text-[11px] font-bold text-slate-600"><i class="fa-regular fa-copy"></i> Salin</button></div><div id="${x[1]}" class="codebox">-</div>${i===3?'<button id="downloadBtn" onclick="openDownload()" class="btn btn-soft mt-2"><i class="fa-solid fa-download"></i> Unduh</button>':''}</div>`).join('')}<div class="p-3 bg-slate-50 rounded-lg border border-slate-200 text-[10px] text-slate-400"><i class="fa-solid fa-circle-info mr-1"></i> Player memancarkan <code>SHINDORA_VIDEO_ENDED</code> ketika playback selesai.</div></div>
      </div>
    </section>

    <section id="viewVastAds" class="hidden space-y-6"><div class="panel p-6 md:p-8 max-w-5xl space-y-6"><div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div><div class="flex items-center gap-2"><i class="fa-solid fa-shield-halved"></i><h1 class="text-base font-bold">Sistem Iklan Video</h1></div><p class="text-xs text-slate-400 mt-1">Multiple waterfall VAST, overlay banner dan popup dengan pengaturan per iklan.</p></div><select id="vastGlobalSelect" onchange="saveVast()" class="input sm:w-56"><option value="1">Aktifkan Iklan (Global)</option><option value="0">Nonaktifkan Iklan</option></select></div><div class="panel p-5 bg-slate-50/40"><div class="flex flex-col md:flex-row gap-2"><input id="vastTestUrl" class="input font-mono" placeholder="https://... VAST / VMAP URL"><button onclick="testVast()" class="btn btn-dark shrink-0"><i class="fa-solid fa-play"></i> Uji Tag VAST Sekarang</button></div><pre id="vastTestResult" class="hidden mt-3 p-4 rounded-xl bg-slate-950 text-slate-100 text-[11px] whitespace-pre-wrap overflow-auto"></pre></div><div class="flex items-center justify-between"><div><div class="text-xs font-bold">Daftar Jadwal Iklan Terkonfigurasi</div><div class="text-[11px] text-slate-400">Preroll, midroll, postroll, overlay banner dan popup.</div></div><button onclick="addVastAd()" class="btn btn-dark">+ Tambah Iklan Baru</button></div><div id="vastList" class="space-y-4"></div><div class="flex justify-end pt-2"><button onclick="saveVast()" class="btn btn-dark"><i class="fa-solid fa-floppy-disk"></i> Simpan Pengaturan Iklan</button></div></div></section>

    <section id="viewSettings" class="hidden space-y-6"><div><h1 class="text-2xl font-black tracking-tight">Pengaturan Sistem ShinDora</h1><p class="text-xs text-slate-400 mt-1">Pusat manajemen JW Player, VAST, Cloudflare CDN, ImageKit dan akun admin.</p></div><div class="flex flex-wrap gap-2 border-b border-slate-200 pb-2"><button id="subtabJw" onclick="showSubSettings('jw')" class="subtab-active px-4 py-2 rounded-xl text-xs font-bold"> <i class="fa-solid fa-play mr-1"></i> JW Player & Test</button><button id="subtabVast" onclick="showSubSettings('vast')" class="subtab px-4 py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-tv mr-1"></i> VAST Ads & Tester</button><button id="subtabCdn" onclick="showSubSettings('cdn')" class="subtab px-4 py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-cloud mr-1"></i> CDN Cloudflare</button><button id="subtabImagekit" onclick="showSubSettings('imagekit')" class="subtab px-4 py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-key mr-1"></i> ImageKit SDK</button><button id="subtabAdmin" onclick="showSubSettings('admin')" class="subtab px-4 py-2 rounded-xl text-xs font-bold"><i class="fa-solid fa-lock mr-1"></i> Akun Admin</button></div>
      <div id="settingsTabJw" class="grid grid-cols-1 lg:grid-cols-2 gap-6"><div class="panel p-6 space-y-5"><div><div class="text-sm font-bold">JW Player Engine (Utama)</div><p class="text-xs text-slate-400 mt-1">JW Player 8 sebagai player utama dengan seek, subtitle, skip opening dan recovery source.</p></div><div class="p-3 bg-slate-50 rounded-xl border flex justify-between items-center"><div class="text-xs font-bold"><i class="fa-solid fa-circle-check text-emerald-500 mr-1"></i> JW Player 8 Premium Cloud Engine</div><span class="text-[10px] bg-slate-900 text-white px-2 py-1 rounded font-black">DEFAULT</span></div><div><label class="text-xs font-bold">Autoplay</label><select id="autoplaySelect" class="input mt-1.5"><option value="1">Aktif (Audio fallback)</option><option value="0">Nonaktif</option></select></div><div><label class="text-xs font-bold">Skip Opening</label><div class="grid grid-cols-2 gap-2 mt-1.5"><label class="flex items-center gap-2 border rounded-lg p-2 text-xs"><input id="skipOpeningEnabled" type="checkbox" checked> Aktif</label><input id="skipOpeningDuration" type="number" min="0" max="600" value="60" class="input" placeholder="Detik"></div></div><label class="flex items-center justify-between p-3 border rounded-xl"><div><div class="text-xs font-bold">Proteksi Anti-AdBlock</div><div class="text-[10px] text-slate-400">Tampilkan overlay peringatan jika mendeteksi AdBlock.</div></div><input id="adblockToggle" type="checkbox" class="h-4 w-4"></label><button onclick="savePlayerSettings()" class="btn btn-dark w-full">Simpan Konfigurasi JW Player</button></div><div class="panel p-6 space-y-4"><div class="flex justify-between items-center"><div class="text-sm font-bold"><i class="fa-solid fa-play text-amber-500 mr-1"></i> Live JW Player Preview & Test</div><span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded border">Live Test</span></div><p class="text-xs text-slate-400">Uji URL video dan subtitle langsung pada dashboard.</p><div id="previewPlayer" class="w-full aspect-video bg-black rounded-xl overflow-hidden"></div><div class="grid grid-cols-1 sm:grid-cols-2 gap-2"><div><label class="text-[10px] font-bold text-slate-400">URL Video Uji Coba</label><input id="previewVideoUrl" class="input mt-1" value="/sample.mp4"></div><div><label class="text-[10px] font-bold text-slate-400">URL Subtitle Uji Coba</label><input id="previewSubUrl" class="input mt-1" value="/sample.vtt"></div></div><div class="flex gap-2"><button onclick="reloadPreview()" class="btn btn-soft flex-1"><i class="fa-solid fa-arrows-rotate"></i> Muat Ulang Preview</button><button onclick="previewSeek(10)" class="btn btn-soft">+10s</button><button onclick="previewSeek(-10)" class="btn btn-soft">-10s</button></div></div></div>
      <div id="settingsTabVast" class="hidden"><div class="panel p-6"><div class="flex gap-2"><input id="settingsVastUrl" class="input font-mono" placeholder="VAST / VMAP URL"><button onclick="testVastFromSettings()" class="btn btn-dark">Uji Tag VAST</button></div><pre id="settingsVastResult" class="hidden mt-3 p-4 bg-slate-950 text-slate-100 rounded-xl text-[11px] whitespace-pre-wrap"></pre></div></div>
      <div id="settingsTabCdn" class="hidden"><div class="panel p-6 max-w-3xl space-y-4"><div><label class="text-xs font-bold">Stream CDN / Cloudflare Worker URL</label><input id="settingCdnUrl" class="input mt-1.5 font-mono"></div><div><label class="text-xs font-bold">VK Service Access Token</label><input id="settingVkToken" type="password" class="input mt-1.5 font-mono" placeholder="Kosongkan untuk mempertahankan token tersimpan"><div class="text-[10px] text-slate-400 mt-1" id="vkTokenState"></div></div><label class="flex items-center justify-between p-3 border rounded-xl"><div><div class="text-xs font-bold">Gunakan Dedicated Download CDN</div><div class="text-[10px] text-slate-400">Pisahkan domain download dari stream.</div></div><input id="settingUseDownload" type="checkbox" class="h-4 w-4"></label><div><label class="text-xs font-bold">Dedicated Download CDN URL</label><input id="settingDownloadCdnUrl" class="input mt-1.5 font-mono"></div><button onclick="saveCdnSettings()" class="btn btn-dark">Simpan Pengaturan CDN</button></div></div>
      <div id="settingsTabImagekit" class="hidden"><div class="panel p-6 max-w-3xl space-y-4"><div class="flex justify-between"><div><div class="text-sm font-bold">ImageKit SDK Settings</div><p class="text-xs text-slate-400 mt-1">Untuk upload thumbnail dan asset teks.</p></div><span id="imagekitState" class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded">Status</span></div><div><label class="text-xs font-bold">Public Key</label><input id="ikPublicKey" class="input mt-1.5"></div><div><label class="text-xs font-bold">Private Key (Terkunci & Disembunyikan)</label><input id="ikPrivateKey" type="password" class="input mt-1.5" placeholder="Kosongkan untuk mempertahankan private key"></div><div><label class="text-xs font-bold">URL Endpoint</label><input id="ikUrlEndpoint" class="input mt-1.5 font-mono"></div><button onclick="saveImageKitSettings()" class="btn btn-dark">Simpan Kredensial ImageKit</button><p class="text-[10px] text-slate-400">Private key hanya dipakai server untuk membuat signature upload dan tidak dikirim dalam response GET.</p></div></div>
      <div id="settingsTabAdmin" class="hidden"><div class="panel p-6 max-w-2xl space-y-4"><div class="text-sm font-bold">Ubah Akun Admin</div><div><label class="text-xs font-bold">Username Admin</label><input id="adminUsername" class="input mt-1.5"></div><div><label class="text-xs font-bold">Kata Sandi Baru</label><input id="adminPassword" type="password" class="input mt-1.5" placeholder="Minimal 8 karakter"></div><div><label class="text-xs font-bold">Konfirmasi Kata Sandi Baru</label><input id="adminPassword2" type="password" class="input mt-1.5"></div><button onclick="saveAdminSettings()" class="btn btn-dark">Perbarui Akun Admin</button></div></div>
    </section>
  </main>

  <div id="modalRoot"></div><div id="toastRoot"></div>
  <script>
    let allLinks=[];let currentSources=[];let currentSubtitles=[];let editingId=null;let page=1;let vastAds=[];let settings={};let previewPlayer=null;
    const initialView=${JSON.stringify(initialView)};
    function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
    function toast(msg){const r=document.getElementById('toastRoot');r.innerHTML='<div class="toast">'+esc(msg)+'</div>';setTimeout(()=>r.innerHTML='',2600)}
    async function api(url,opt={}){const r=await fetch(url,{credentials:'same-origin',...opt});if(r.status===401){window.location='/login';throw new Error('Sesi login berakhir.')}let d={};try{d=await r.json()}catch(e){}if(!r.ok)throw new Error(d.error||d.message||('HTTP '+r.status));return d}
    function setActive(id){['tabVideoLinks','tabVastAds','tabSettings'].forEach(x=>{const e=document.getElementById(x);if(e)e.className='w-full flex items-center gap-3 px-3.5 py-3 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-50'});const e=document.getElementById(id);if(e)e.className='w-full flex items-center gap-3 px-3.5 py-3 rounded-lg text-sm font-semibold sidebar-active'}
    function hideViews(){['viewDashboard','viewNewLink','viewVastAds','viewSettings'].forEach(id=>document.getElementById(id).classList.add('hidden'))}
    function showView(v){hideViews();if(v==='dashboard'){document.getElementById('viewDashboard').classList.remove('hidden');setActive('tabVideoLinks');loadData()}else if(v==='new-link'){document.getElementById('viewNewLink').classList.remove('hidden');setActive('tabVideoLinks')}else if(v==='vast-ads'){document.getElementById('viewVastAds').classList.remove('hidden');setActive('tabVastAds');loadVast()}else{document.getElementById('viewSettings').classList.remove('hidden');setActive('tabSettings');loadSettings();showSubSettings('jw')}}
    function openNewVideo(){editingId=null;resetVideoForm();document.getElementById('newLinkHeading').textContent='Tambah Link Baru';document.getElementById('saveVideoLabel').textContent='Simpan Link Video';showView('new-link')}
    function resetVideoForm(){document.getElementById('newOriginalUrl').value='';document.getElementById('newTitle').value='';document.getElementById('newSlug').value='';document.getElementById('newPoster').value='';document.getElementById('thumbPreview').classList.add('hidden');currentSources=[];currentSubtitles=[];renderSources();renderSubtitles();updateGenOutputs()}
    async function loadMe(){try{const d=await api('/api/auth/me');document.getElementById('loggedUser').textContent=d.username||'-'}catch(e){}}
    async function logoutAdmin(){try{await fetch('/api/auth/logout',{method:'POST'});window.location='/login'}catch(e){window.location='/login'}}
    async function loadData(){try{const [links,stats]=await Promise.all([api('/api/links'),api('/api/stats')]);allLinks=Array.isArray(links)?links:(links.links||[]);document.getElementById('statTotal').textContent=stats.stats?.totalVideos||0;document.getElementById('statVk').textContent=stats.stats?.vkCount||0;document.getElementById('statOk').textContent=stats.stats?.okCount||0;document.getElementById('statSibnet').textContent=stats.stats?.sibnetCount||0;renderTable()}catch(e){toast(e.message)}}
    function hostName(h){return h==='vk'?'VK Video':h==='ok'?'OK.ru':h==='sibnet'?'Sibnet':'Other'}
    function hostBadge(h){const c=h==='vk'?'bg-blue-50 text-blue-600 border-blue-100':h==='ok'?'bg-orange-50 text-orange-600 border-orange-100':h==='sibnet'?'bg-emerald-50 text-emerald-600 border-emerald-100':'bg-slate-50 text-slate-600 border-slate-100';return '<span class="host-badge border '+c+'">'+hostName(h)+'</span>'}
    function selectedIds(){return [...document.querySelectorAll('.row-check:checked')].map(x=>x.value)}
    function toggleAll(el){document.querySelectorAll('.row-check').forEach(c=>c.checked=el.checked);updateBulkBar()}
    function updateBulkBar(){const n=selectedIds().length;document.getElementById('selectedCount').textContent=n;document.getElementById('bulkBar').classList.toggle('hidden',n===0);document.getElementById('bulkBar').classList.toggle('flex',n>0)}
    function renderTable(){const q=(document.getElementById('searchInput')?.value||'').toLowerCase();const f=document.getElementById('hostFilter')?.value||'all';let filtered=allLinks.filter(l=>{const hay=((l.title||'')+' '+(l.slug||'')+' '+(l.originalUrl||'')).toLowerCase();const host=String(l.hostType||'').toLowerCase();return hay.includes(q)&&(f==='all'||host===f)});const size=Number(document.getElementById('pageSize')?.value||25);const pages=Math.max(1,Math.ceil(filtered.length/size));if(page>pages)page=pages;const rows=filtered.slice((page-1)*size,page*size);document.getElementById('selectAll').checked=false;document.getElementById('pageInfo').textContent=(filtered.length?((page-1)*size+1)+'–'+Math.min(page*size,filtered.length):0)+' dari '+filtered.length;const tb=document.getElementById('videoTableBody');if(!rows.length){tb.innerHTML='<tr><td colspan="7" class="p-12 text-center text-slate-400">Tidak ada video yang ditemukan.</td></tr>';return}tb.innerHTML=rows.map(l=>{const updated=l.updatedAt||l.createdAt;const age=updated?Math.floor((Date.now()-new Date(updated).getTime())/3600000):999;const fresh=age<24;const qualities=(l.sources||[]).map(s=>s.label).filter(Boolean);const date=l.createdAt?new Date(l.createdAt).toLocaleDateString('id-ID',{day:'2-digit',month:'short',year:'numeric'}):'-';const p='/v/'+encodeURIComponent(l.slug);return '<tr class="hover:bg-slate-50/60"><td class="py-4 px-2"><input class="row-check" value="'+esc(l.id)+'" type="checkbox" onchange="updateBulkBar()"></td><td class="py-4 px-3"><div class="flex gap-3 items-center"><div class="thumb">'+(l.posterUrl?'<img src="'+esc(l.posterUrl)+'" class="w-full h-full object-cover" onerror="this.style.display=\'none\'">':'<div class="w-full h-full flex items-center justify-center text-slate-300"><i class="fa-solid fa-film"></i></div>')+'</div><div class="min-w-0"><div class="font-bold truncate max-w-[330px]" title="'+esc(l.title)+'">'+esc(l.title||'Tanpa Judul')+'</div><div class="mt-1">'+hostBadge(l.hostType)+' <a href="'+esc(l.originalUrl||'#')+'" target="_blank" class="text-[10px] text-slate-400 ml-1">Buka source</a></div></div></div></td><td class="py-4 px-3"><div class="flex items-center gap-1.5 text-[11px] font-bold '+(fresh?'text-emerald-600':'text-red-500')+'"><span class="status-dot '+(fresh?'bg-emerald-500':'bg-red-500')+'"></span>'+(fresh?'Token Fresh':'Need Refresh')+'</div><div class="text-[10px] text-slate-400 mt-1">'+(age===999?'-':age+' jam lalu')+'</div></td><td class="py-4 px-3"><div class="font-mono text-[11px] font-bold">'+esc((l.slug||'').slice(0,18))+' <button onclick="copyText(location.origin+\'/v/'+encodeURIComponent(l.slug)+'\')" class="text-slate-400 ml-1"><i class="fa-regular fa-copy"></i></button></div><div class="text-[10px] text-slate-400 mt-1 truncate max-w-[220px]">/v/'+esc(l.slug)+'</div></td><td class="py-4 px-3"><div class="flex flex-wrap gap-1">'+(qualities.length?qualities.map(q=>'<span class="text-[10px] font-bold px-2 py-1 bg-slate-100 rounded">'+esc(q)+'</span>').join(''):'<span class="text-slate-400">-</span>')+'</div></td><td class="py-4 px-3 text-slate-500"><i class="fa-regular fa-calendar mr-1"></i>'+date+'</td><td class="py-4 px-3 text-right"><div class="flex justify-end items-center gap-2"><button onclick="refreshSingleToken(\''+encodeURIComponent(l.slug)+'\')" class="text-slate-400 hover:text-slate-900" title="Sync Token"><i class="fa-solid fa-arrows-rotate"></i></button><a href="'+p+'" target="_blank" class="text-slate-400 hover:text-slate-900" title="Buka Player"><i class="fa-solid fa-up-right-from-square"></i></a><button onclick="copyText(\'<iframe src=\\"'+location.origin+p+'\\" width=\\"100%\\" height=\\"100%\\" frameborder=\\"0\\" allowfullscreen></iframe>\')" class="text-slate-400 hover:text-slate-900" title="Copy Embed"><i class="fa-solid fa-code"></i></button><button onclick="editVideo(\''+encodeURIComponent(l.id)+'\')" class="text-slate-400 hover:text-slate-900" title="Edit"><i class="fa-solid fa-pen"></i></button><button onclick="deleteVideo(\''+encodeURIComponent(l.id)+'\')" class="text-red-400 hover:text-red-600" title="Hapus"><i class="fa-solid fa-trash"></i></button></div></td></tr>'}).join('');updateBulkBar()}
    async function refreshSingleToken(slug){try{toast('Memperbarui source…');await api('/api/parse-stream?slug='+slug+'&force=1');toast('Token/source diperbarui');await loadData()}catch(e){toast(e.message)}}
    async function deleteVideo(id){if(!confirm('Hapus video ini dari database?'))return;try{await api('/api/links/'+id,{method:'DELETE'});toast('Video dihapus');await loadData()}catch(e){toast(e.message)}}
    async function deleteSelected(){const ids=selectedIds();if(!ids.length||!confirm('Hapus '+ids.length+' video?'))return;for(const id of ids){try{await api('/api/links/'+encodeURIComponent(id),{method:'DELETE'})}catch(e){}}toast('Video terpilih diproses');await loadData()}
    async function editVideo(id){try{const l=allLinks.find(x=>String(x.id)===decodeURIComponent(id));if(!l)throw new Error('Video tidak ditemukan');editingId=l.id;document.getElementById('newLinkHeading').textContent='Edit Link Video';document.getElementById('saveVideoLabel').textContent='Simpan Perubahan';document.getElementById('newOriginalUrl').value=l.originalUrl||'';document.getElementById('newTitle').value=l.title||'';document.getElementById('newSlug').value=l.slug||'';document.getElementById('newPoster').value=l.posterUrl||'';currentSources=l.sources||[];currentSubtitles=l.subtitles||[];renderSources();renderSubtitles();updateGenOutputs();showView('new-link')}catch(e){toast(e.message)}}
    function renderSources(){document.getElementById('sourceCount').textContent='('+currentSources.length+')';document.getElementById('sourcesBox').innerHTML=currentSources.length?currentSources.map(s=>'<div class="flex items-center justify-between gap-3 bg-white border rounded-lg p-2.5"><div class="min-w-0"><div class="font-bold">'+esc(s.label||'Source')+'</div><div class="text-[10px] text-slate-400 break-all">'+esc(s.file||'')+'</div></div><span class="text-[10px] font-bold text-blue-600 shrink-0">'+esc(s.type||'video/mp4')+'</span></div>').join(''):'<div class="text-center">Belum ada stream source. Klik Parse Video.</div>'}
    function renderSubtitles(){const root=document.getElementById('subtitleList');if(!currentSubtitles.length){root.innerHTML='<div class="text-[11px] text-slate-400 p-3 bg-slate-50 rounded-lg border border-dashed">Belum ada subtitle.</div>';return}root.innerHTML=currentSubtitles.map((s,i)=>'<div class="grid grid-cols-1 md:grid-cols-12 gap-2 items-end border rounded-xl p-3"><div class="md:col-span-3"><label class="text-[10px] font-bold">Label</label><input class="input mt-1 sub-label" data-i="'+i+'" value="'+esc(s.label||'Indonesia')+'"></div><div class="md:col-span-2"><label class="text-[10px] font-bold">Language</label><input class="input mt-1 sub-lang" data-i="'+i+'" value="'+esc(s.language||'id')+'"></div><div class="md:col-span-6"><label class="text-[10px] font-bold">URL / File</label><input class="input mt-1 sub-file" data-i="'+i+'" value="'+esc(s.file||'')+'" placeholder="https://.../subtitle.vtt"><input type="file" accept=".srt,.vtt,text/plain" class="sub-upload hidden" data-i="'+i+'" onchange="handleSubtitleFile(this)"><button onclick="document.querySelector(\'.sub-upload[data-i=\\"'+i+'\\"]\').click()" class="text-[10px] text-slate-500 mt-1">Upload .srt/.vtt</button></div><div class="md:col-span-1"><button onclick="removeSubtitle('+i+')" class="btn btn-danger w-full"><i class="fa-solid fa-trash"></i></button></div></div>').join('')}
    function addSubtitleRow(){currentSubtitles.push({label:'Indonesia',language:'id',file:''});renderSubtitles()}
    function removeSubtitle(i){currentSubtitles.splice(i,1);renderSubtitles()}
    async function handleSubtitleFile(input){const i=Number(input.dataset.i);const file=input.files?.[0];if(!file)return;const text=await file.text();currentSubtitles[i].label=currentSubtitles[i].label||file.name.replace(/\.(srt|vtt)$/i,'');currentSubtitles[i].content=text;currentSubtitles[i].file='';renderSubtitles();toast('Subtitle '+file.name+' dimuat')}
    async function handleImageFile(input){const f=input.files?.[0];if(!f)return;const img=document.getElementById('thumbPreview');img.src=URL.createObjectURL(f);img.classList.remove('hidden');try{const auth=await api('/api/imagekit/auth');const fd=new FormData();fd.append('file',f);fd.append('fileName',f.name.replace(/[^a-zA-Z0-9._-]/g,'_'));fd.append('publicKey',auth.publicKey);fd.append('signature',auth.signature);fd.append('expire',String(auth.expire));fd.append('token',auth.token);fd.append('useUniqueFileName','true');const r=await fetch('https://upload.imagekit.io/api/v1/files/upload',{method:'POST',body:fd});const d=await r.json();if(!r.ok||!d.url)throw new Error(d.message||'Upload ImageKit gagal');document.getElementById('newPoster').value=d.url;img.src=d.url;toast('Thumbnail berhasil di-upload ke ImageKit')}catch(e){toast(e.message||'Upload ImageKit gagal')}}
    function uploadImageKit(kind){document.getElementById('thumbFile').click()}
    async function parseUrl(){const u=document.getElementById('newOriginalUrl').value.trim();if(!u)return toast('Masukkan URL video');const btn=document.getElementById('parseBtn');btn.disabled=true;btn.textContent='Parsing…';try{const d=await api('/api/parse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u})});if(d.title)document.getElementById('newTitle').value=d.title;if(d.title&&!document.getElementById('newSlug').value)document.getElementById('newSlug').value=d.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,90)||crypto.randomUUID().slice(0,8);if(d.posterUrl){document.getElementById('newPoster').value=d.posterUrl;document.getElementById('thumbPreview').src=d.posterUrl;document.getElementById('thumbPreview').classList.remove('hidden')}currentSources=d.sources||[];renderSources();updateGenOutputs();toast('Berhasil mengekstrak '+currentSources.length+' source.')}catch(e){toast(e.message)}finally{btn.disabled=false;btn.textContent='Parse Video'}}
    function updateGenOutputs(){const slug=document.getElementById('newSlug')?.value.trim()||'video-terbaru';const q=document.getElementById('genQuality')?.value||'720';const o=location.origin;document.getElementById('genDirectStreamLink').textContent=o+'/api/stream/'+q+'/'+slug+'.mp4';document.getElementById('genPlayerLink').textContent=o+'/v/'+slug;document.getElementById('genEmbedCode').textContent='<iframe src="'+o+'/v/'+slug+'" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen style="border:0;overflow:hidden;width:100%;height:100%;"></iframe>';document.getElementById('genDownloadLink').textContent=o+'/api/download/'+q+'/'+slug+'.mp4'}
    function openDownload(){window.open(document.getElementById('genDownloadLink').textContent,'_blank')}
    function copyText(s){navigator.clipboard?.writeText(s).then(()=>toast('Tautan disalin')).catch(()=>{const t=document.createElement('textarea');t.value=s;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();toast('Tautan disalin')})}
    function copyElementText(id){const e=document.getElementById(id);if(e)copyText(e.textContent)}
    function collectSubtitleInputs(){document.querySelectorAll('.sub-label').forEach(x=>currentSubtitles[Number(x.dataset.i)].label=x.value);document.querySelectorAll('.sub-lang').forEach(x=>currentSubtitles[Number(x.dataset.i)].language=x.value);document.querySelectorAll('.sub-file').forEach(x=>currentSubtitles[Number(x.dataset.i)].file=x.value)}
    async function saveNewVideo(){collectSubtitleInputs();const body={title:document.getElementById('newTitle').value.trim(),slug:document.getElementById('newSlug').value.trim(),originalUrl:document.getElementById('newOriginalUrl').value.trim(),posterUrl:document.getElementById('newPoster').value.trim(),sources:currentSources,subtitles:currentSubtitles};if(!body.title||!body.originalUrl||!body.sources.length)return toast('Title, URL dan source wajib diisi');try{if(editingId){await api('/api/links/'+encodeURIComponent(editingId),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Video berhasil diperbarui')}else{await api('/api/links',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Video berhasil disimpan')}editingId=null;await loadData();showView('dashboard')}catch(e){toast(e.message)}}

    function showSubSettings(tab){['settingsTabJw','settingsTabVast','settingsTabCdn','settingsTabImagekit','settingsTabAdmin'].forEach(id=>document.getElementById(id).classList.add('hidden'));['subtabJw','subtabVast','subtabCdn','subtabImagekit','subtabAdmin'].forEach(id=>document.getElementById(id).className='subtab px-4 py-2 rounded-xl text-xs font-bold');const map={jw:['settingsTabJw','subtabJw'],vast:['settingsTabVast','subtabVast'],cdn:['settingsTabCdn','subtabCdn'],imagekit:['settingsTabImagekit','subtabImagekit'],admin:['settingsTabAdmin','subtabAdmin']};const m=map[tab]||map.jw;document.getElementById(m[0]).classList.remove('hidden');document.getElementById(m[1]).className='subtab-active px-4 py-2 rounded-xl text-xs font-bold'}
    async function loadSettings(){try{const d=await api('/api/settings');settings=d;document.getElementById('autoplaySelect').value=d.player?.autoplay?'1':'0';document.getElementById('skipOpeningEnabled').checked=d.player?.skipOpeningEnabled!==false;document.getElementById('skipOpeningDuration').value=d.player?.skipOpeningDuration||60;document.getElementById('adblockToggle').checked=!!d.player?.isAdblockEnabled;document.getElementById('settingCdnUrl').value=d.general?.cdnUrl||'';document.getElementById('settingDownloadCdnUrl').value=d.general?.downloadCdnUrl||'';document.getElementById('settingUseDownload').checked=!!d.general?.isCustomDownloadCdnEnabled;document.getElementById('vkTokenState').textContent=d.general?.hasVkServiceToken?'Token VK tersimpan di server.':'';document.getElementById('ikPublicKey').value=d.imagekit?.publicKey||'';document.getElementById('ikUrlEndpoint').value=d.imagekit?.urlEndpoint||'';document.getElementById('imagekitState').textContent=d.imagekit?.hasPrivateKey?'Aktif di server':'Belum dikonfigurasi';document.getElementById('adminUsername').value=d.admin?.username||'';vastAds=d.player?.vastTags||[];renderVastList();}catch(e){toast(e.message)}}
    async function savePlayerSettings(){try{await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settingsType:'player',playerType:'jwplayer',autoplay:document.getElementById('autoplaySelect').value==='1',vastEnabled:document.getElementById('vastGlobalSelect')?.value==='1',vastTags:vastAds,isAdblockEnabled:document.getElementById('adblockToggle').checked,skipOpeningEnabled:document.getElementById('skipOpeningEnabled').checked,skipOpeningDuration:Number(document.getElementById('skipOpeningDuration').value||60)})});toast('Konfigurasi JW Player disimpan')}catch(e){toast(e.message)}}
    async function saveCdnSettings(){try{const payload={settingsType:'general',cdnUrl:document.getElementById('settingCdnUrl').value,downloadCdnUrl:document.getElementById('settingDownloadCdnUrl').value,isCustomDownloadCdnEnabled:document.getElementById('settingUseDownload').checked};const token=document.getElementById('settingVkToken').value.trim();if(token)payload.vkServiceToken=token;await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});document.getElementById('settingVkToken').value='';toast('Pengaturan CDN disimpan')}catch(e){toast(e.message)}}
    async function saveImageKitSettings(){try{await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settingsType:'imagekit',publicKey:document.getElementById('ikPublicKey').value,privateKey:document.getElementById('ikPrivateKey').value,urlEndpoint:document.getElementById('ikUrlEndpoint').value})});document.getElementById('ikPrivateKey').value='';toast('Kredensial ImageKit disimpan');loadSettings()}catch(e){toast(e.message)}}
    async function saveAdminSettings(){const p=document.getElementById('adminPassword').value,p2=document.getElementById('adminPassword2').value,u=document.getElementById('adminUsername').value.trim();if(p&&p.length<8)return toast('Password minimal 8 karakter');if(p!==p2)return toast('Konfirmasi password tidak cocok');try{await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settingsType:'admin',username:u,password:p})});toast('Akun admin diperbarui');document.getElementById('adminPassword').value='';document.getElementById('adminPassword2').value=''}catch(e){toast(e.message)}}
    function addVastAd(){vastAds.push({id:crypto.randomUUID(),name:'Iklan Baru #'+(vastAds.length+1),adType:'vast',status:true,position:'preroll',skipAfter:15,tags:['']});renderVastList()}
    function renderVastList(){const root=document.getElementById('vastList');if(!root)return;if(!vastAds.length){root.innerHTML='<div class="p-8 text-center text-slate-400 border border-dashed rounded-xl">Belum ada iklan. Klik + Tambah Iklan Baru.</div>';return}root.innerHTML=vastAds.map((a,i)=>{if(typeof a==='string')a={id:crypto.randomUUID(),name:'Iklan #'+(i+1),adType:'vast',status:true,position:'preroll',skipAfter:15,tags:[a]};const tags=a.tags||[''];return '<div class="panel p-5 space-y-4"><div class="flex justify-between items-center"><div class="flex items-center gap-2"><span class="bg-slate-100 px-2 py-1 rounded text-xs font-bold">#'+(i+1)+'</span><span class="text-xs font-bold">'+esc(a.name||('Iklan #'+(i+1)))+'</span></div><button onclick="removeVastAd('+i+')" class="btn btn-danger"><i class="fa-solid fa-trash"></i> Hapus</button></div><div class="grid grid-cols-1 md:grid-cols-3 gap-3"><div><label class="text-[10px] font-bold">Nama Iklan</label><input class="input mt-1 vast-name" data-i="'+i+'" value="'+esc(a.name||'')+'"></div><div><label class="text-[10px] font-bold">Tipe Iklan</label><select class="input mt-1 vast-type" data-i="'+i+'"><option value="vast" '+(a.adType==='vast'?'selected':'')+'>VAST Video Ad</option><option value="banner" '+(a.adType==='banner'?'selected':'')+'>Overlay Banner</option><option value="popup" '+(a.adType==='popup'?'selected':'')+'>Popup</option></select></div><div><label class="text-[10px] font-bold">Status</label><select class="input mt-1 vast-status" data-i="'+i+'"><option value="1" '+(a.status!==false?'selected':'')+'>Aktif</option><option value="0" '+(a.status===false?'selected':'')+'>Nonaktif</option></select></div></div><div class="grid grid-cols-1 md:grid-cols-2 gap-3"><div><label class="text-[10px] font-bold">Waktu Kemunculan</label><select class="input mt-1 vast-position" data-i="'+i+'"><option value="preroll" '+(a.position==='preroll'?'selected':'')+'>Awal Video (Preroll)</option><option value="midroll" '+(a.position==='midroll'?'selected':'')+'>Midroll</option><option value="postroll" '+(a.position==='postroll'?'selected':'')+'>Postroll</option></select></div><div><label class="text-[10px] font-bold">Detik Muncul Tombol Skip</label><input type="number" min="5" class="input mt-1 vast-skip" data-i="'+i+'" value="'+Number(a.skipAfter||15)+'"></div></div><div><div class="flex justify-between items-center mb-2"><label class="text-[10px] font-bold">Multiple VAST Tags (Waterfall)</label><button onclick="addFallback('+i+')" class="btn btn-soft">+ Fallback Tag</button></div><div class="space-y-2">'+tags.map((t,j)=>'<div class="flex gap-2"><input class="input vast-tag" data-i="'+i+'" data-j="'+j+'" value="'+esc(t)+'" placeholder="https://..."><button onclick="removeFallback('+i+','+j+')" class="btn btn-soft"><i class="fa-solid fa-xmark"></i></button></div>').join('')+'</div></div></div>'}).join('')}
    function addFallback(i){vastAds[i].tags=vastAds[i].tags||[''];vastAds[i].tags.push('');renderVastList()}
    function removeFallback(i,j){if((vastAds[i].tags||[]).length<=1)return;vastAds[i].tags.splice(j,1);renderVastList()}
    function removeVastAd(i){vastAds.splice(i,1);renderVastList()}
    function collectVastInputs(){document.querySelectorAll('.vast-name').forEach(x=>vastAds[Number(x.dataset.i)].name=x.value);document.querySelectorAll('.vast-type').forEach(x=>vastAds[Number(x.dataset.i)].adType=x.value);document.querySelectorAll('.vast-status').forEach(x=>vastAds[Number(x.dataset.i)].status=x.value==='1');document.querySelectorAll('.vast-position').forEach(x=>vastAds[Number(x.dataset.i)].position=x.value);document.querySelectorAll('.vast-skip').forEach(x=>vastAds[Number(x.dataset.i)].skipAfter=Number(x.value||15));document.querySelectorAll('.vast-tag').forEach(x=>{const i=Number(x.dataset.i),j=Number(x.dataset.j);vastAds[i].tags=vastAds[i].tags||[];vastAds[i].tags[j]=x.value.trim()})}
    async function saveVast(){collectVastInputs();try{const global=document.getElementById('vastGlobalSelect')?.value==='1';await api('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settingsType:'player',playerType:'jwplayer',autoplay:document.getElementById('autoplaySelect')?.value==='1',vastEnabled:global,vastTags:vastAds,isAdblockEnabled:document.getElementById('adblockToggle')?.checked||false,skipOpeningEnabled:document.getElementById('skipOpeningEnabled')?.checked??true,skipOpeningDuration:Number(document.getElementById('skipOpeningDuration')?.value||60)})});toast('Pengaturan VAST disimpan')}catch(e){toast(e.message)}}
    async function loadVast(){try{const d=await api('/api/settings');vastAds=d.player?.vastTags||[];document.getElementById('vastGlobalSelect').value=d.player?.vastEnabled?'1':'0';renderVastList()}catch(e){toast(e.message)}}
    async function testVast(){const u=document.getElementById('vastTestUrl').value.trim();if(!u)return toast('Masukkan URL VAST');try{const d=await api('/api/vast/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u})});const out=document.getElementById('vastTestResult');out.textContent=JSON.stringify(d,null,2);out.classList.remove('hidden')}catch(e){const out=document.getElementById('vastTestResult');out.textContent=e.message;out.classList.remove('hidden')}}
    async function testVastFromSettings(){const u=document.getElementById('settingsVastUrl').value.trim();if(!u)return;try{const d=await api('/api/vast/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u})});const out=document.getElementById('settingsVastResult');out.textContent=JSON.stringify(d,null,2);out.classList.remove('hidden')}catch(e){const out=document.getElementById('settingsVastResult');out.textContent=e.message;out.classList.remove('hidden')}}
    async function reloadPreview(){if(previewPlayer){try{previewPlayer.remove()}catch(e){}}const src=document.getElementById('previewVideoUrl').value.trim();const sub=document.getElementById('previewSubUrl').value.trim();if(!window.jwplayer){return toast('JW Player belum tersedia')}previewPlayer=window.jwplayer('previewPlayer').setup({file:src,image:'',autostart:false,width:'100%',height:'100%',stretching:'uniform',tracks:sub?[{file:sub,label:'Subtitle',kind:'captions',default:true}]:[]})}
    function previewSeek(d){try{const p=previewPlayer.getPosition();previewPlayer.seek(Math.max(0,p+d))}catch(e){}}

    loadMe();loadData();
    if(initialView==='new-link')openNewVideo();else if(initialView==='vast-ads')showView('vast-ads');else if(initialView==='settings')showView('settings');else showView('dashboard');
  </script>
</body>
</html>`;
}



function renderLoginHtml() {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login - ShinDora CDN</title><script src="https://cdn.tailwindcss.com"></script></head><body class="min-h-screen bg-slate-50 flex items-center justify-center p-6"><div class="w-full max-w-sm bg-white border border-slate-200 rounded-2xl p-7 shadow-sm"><div class="text-center"><div class="text-xl font-black text-slate-900">ShinDora CDN</div><div class="text-xs text-slate-400 mt-1">Admin Dashboard</div></div><form id="f" class="space-y-4 mt-7"><div><label class="text-xs font-bold text-slate-700">Username</label><input id="u" autocomplete="username" class="w-full border border-slate-300 rounded-lg px-3 py-2.5 mt-1.5 text-sm"></div><div><label class="text-xs font-bold text-slate-700">Password</label><input id="p" type="password" autocomplete="current-password" class="w-full border border-slate-300 rounded-lg px-3 py-2.5 mt-1.5 text-sm"></div><button class="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-2.5 text-sm font-bold">Masuk</button><div id="e" class="hidden text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-3"></div></form></div><script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const out=document.getElementById('e');out.classList.add('hidden');try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Login gagal');location='/dashboard'}catch(err){out.textContent=err.message;out.classList.remove('hidden')}};</script></body></html>`;
}

let schemaEnsured = false;

async function ensureSchema(env) {
  const stmts=[
    'CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, type TEXT UNIQUE NOT NULL, cdnUrl TEXT, downloadCdnUrl TEXT, isCustomDownloadCdnEnabled TEXT, vkServiceToken TEXT, playerType TEXT, autoplay TEXT, vastEnabled TEXT, vastTags TEXT, isAdblockEnabled TEXT, publicKey TEXT, privateKey TEXT, urlEndpoint TEXT, username TEXT, password TEXT, skipOpeningEnabled TEXT, skipOpeningDuration INTEGER);',
    'CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, title TEXT, slug TEXT UNIQUE, originalUrl TEXT, posterUrl TEXT, sources TEXT, hostType TEXT, createdAt TEXT, updatedAt TEXT, subtitles TEXT);',
    'CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);',
    'CREATE INDEX IF NOT EXISTS idx_links_createdAt ON links(createdAt);',
    'CREATE INDEX IF NOT EXISTS idx_links_hostType ON links(hostType);'
  ];
  for(const sql of stmts){try{await queryTurso(sql,[],env)}catch(e){}}
  for(const sql of [
    'ALTER TABLE settings ADD COLUMN skipOpeningEnabled TEXT;',
    'ALTER TABLE settings ADD COLUMN skipOpeningDuration INTEGER;'
  ]){try{await queryTurso(sql,[],env)}catch(e){}}
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(value) {
  return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(value) {
  const pad = value.length % 4 ? '='.repeat(4 - (value.length % 4)) : '';
  return decodeURIComponent(escape(atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad)));
}
function getSessionSecret(env) { return env?.SESSION_SECRET || env?.TURSO_AUTH_TOKEN || ''; }
async function createSession(username, env) {
  const secret = getSessionSecret(env);
  if (!secret) throw new Error('SESSION_SECRET atau TURSO_AUTH_TOKEN wajib tersedia.');
  const payload = JSON.stringify({ u: username, exp: Date.now() + 7 * 86400000 });
  const encoded = b64urlEncode(payload);
  const sig = await hmacSha256Hex(secret, encoded);
  return `${encoded}.${sig}`;
}
async function verifySession(request, env) {
  try {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/(?:^|;\s*)shindora_session=([^;]+)/);
    if (!m) return null;
    const token = decodeURIComponent(m[1]);
    const [encoded, sig] = token.split('.');
    if (!encoded || !sig) return null;
    const secret = getSessionSecret(env);
    if (!secret) return null;
    const expected = await hmacSha256Hex(secret, encoded);
    if (sig !== expected) return null;
    const data = JSON.parse(b64urlDecode(encoded));
    if (!data?.u || !data?.exp || Number(data.exp) < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}
async function requireAdmin(request, env) { return await verifySession(request, env); }
function json(data, status=200, headers={}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } }); }
async function getSettingsRows(env) { return await queryTurso('SELECT * FROM settings;', [], env); }
async function getPlayerSettings(env) {
  const rows = await getSettingsRows(env);
  const r = rows.rows.find(x => x.type === 'player');
  let tags=[]; try { tags = r?.vastTags ? JSON.parse(r.vastTags) : []; } catch(e) {}
  if (Array.isArray(tags) && tags.some(x => typeof x === 'string')) tags = tags.map((x,i)=>({id:`legacy-${i}`,name:`Iklan #${i+1}`,adType:'vast',status:true,position:'preroll',skipAfter:15,tags:[x]}));
  return { playerType:r?.playerType||'jwplayer', autoplay:r?.autoplay!=='0', vastEnabled:r?.vastEnabled==='1', vastTags:Array.isArray(tags)?tags:[], isAdblockEnabled:r?.isAdblockEnabled==='1', skipOpeningEnabled:r?.skipOpeningEnabled!=='0', skipOpeningDuration:Number(r?.skipOpeningDuration||60) };
}
async function testVastUrl(rawUrl) {
  if (!rawUrl) throw new Error('URL VAST wajib diisi.');
  const u = new URL(rawUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error('URL VAST harus HTTP/HTTPS.');
  const r = await fetch(u.toString(), { headers:{'User-Agent':'ShinDora-VAST-Tester/1.0','Accept':'application/xml,text/xml,*/*'}, cf:{cacheTtl:60,cacheEverything:false} });
  const xml = await r.text();
  const ads=(xml.match(/<Ad\b/gi)||[]).length;
  const media=(xml.match(/<MediaFile\b/gi)||[]).length;
  const impressions=(xml.match(/<Impression\b/gi)||[]).length;
  const errors=(xml.match(/<Error\b/gi)||[]).length;
  const dur=(xml.match(/<Duration>([^<]+)<\/Duration>/i)||[])[1]||'';
  return { ok:r.ok, status:r.status, contentType:r.headers.get('content-type')||'', bytes:xml.length, validRoot:/<\s*(VAST|VMAP)\b/i.test(xml), ads, mediaFiles:media, impressions, errorTrackers:errors, duration:dur || null };
}

// ===========================================================================
// MAIN WORKER DISPATCHER
// ===========================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (!schemaEnsured) { try { await ensureSchema(env); } catch(e) {} schemaEnsured = true; }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, User-Agent, Referer, Origin',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type, ETag, Last-Modified, X-Token-Recovered, X-Bypass-Vercel',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. FRONTEND UI ROUTES
    if (pathname === '/login') {
      const session = await verifySession(request, env);
      if (session) return Response.redirect(new URL('/dashboard', request.url), 302);
      return new Response(renderLoginHtml(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/links/new' || pathname === '/dashboard/vast-ads' || pathname === '/dashboard/settings') {
      const session = await verifySession(request, env);
      if (!session) return Response.redirect(new URL('/login', request.url), 302);
      const view = pathname === '/dashboard/links/new' ? 'new-link' : pathname === '/dashboard/vast-ads' ? 'vast-ads' : pathname === '/dashboard/settings' ? 'settings' : 'dashboard';
      return new Response(renderDashboardAppHtml(view), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
        const playerSettings = await getPlayerSettings(env);
        return new Response(renderPlayerHtml(row.title, row.posterUrl, sources, subtitles, slug, url.host, playerSettings), {
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

    if (pathname === '/api/auth/login' && method === 'POST') {
      try {
        const body = await request.json();
        const rows = await getSettingsRows(env);
        let admin = rows.rows.find(r => r.type === 'admin');
        if (!admin) {
          await queryTurso("INSERT INTO settings (id,type,username,password) VALUES (?, 'admin', ?, ?);", [generateUUID(), 'admin', 'admin'], env);
          admin = { username:'admin', password:'admin' };
        }
        if ((body.username||'').trim() !== (admin.username||'admin') || (body.password||'') !== (admin.password||'')) return json({error:'Username atau password salah.'},401,corsHeaders);
        const token = await createSession(admin.username||'admin', env);
        return new Response(JSON.stringify({success:true,username:admin.username}), {status:200,headers:{...corsHeaders,'Set-Cookie':`shindora_session=${encodeURIComponent(token)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`}});
      } catch(e) { return json({error:e.message},500,corsHeaders); }
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      const session = await verifySession(request, env);
      if (!session) return json({error:'Unauthorized'},401,corsHeaders);
      return json({success:true,username:session.u,expiresAt:session.exp},200,corsHeaders);
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      return new Response(JSON.stringify({success:true}), {status:200,headers:{...corsHeaders,'Set-Cookie':'shindora_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'}});
    }

    if (pathname === '/api/stats' || pathname === '/api/dashboard/stats') {
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
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
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
      if (method === 'GET') {
        const rows = await queryTurso("SELECT * FROM settings;", [], env);
        const adminRow = rows.rows.find(r => r.type === 'admin');
        const ikRow = rows.rows.find(r => r.type === 'imagekit');
        const playerRow = rows.rows.find(r => r.type === 'player');
        const genRow = rows.rows.find(r => r.type === 'general');

        let vastTags = [];
        try { vastTags = playerRow?.vastTags ? JSON.parse(playerRow.vastTags) : []; } catch (e) {}
        if (Array.isArray(vastTags) && vastTags.some(x => typeof x === 'string')) vastTags = vastTags.map((x,i)=>({id:`legacy-${i}`,name:`Iklan #${i+1}`,adType:'vast',status:true,position:'preroll',skipAfter:15,tags:[x]}));

        return json({
          imagekit: { publicKey: ikRow?.publicKey || '', urlEndpoint: ikRow?.urlEndpoint || '', hasPrivateKey: !!ikRow?.privateKey },
          admin: { username: adminRow?.username || 'admin' },
          player: { playerType: playerRow?.playerType || 'jwplayer', autoplay: playerRow?.autoplay !== '0', vastEnabled: playerRow?.vastEnabled === '1', vastTags, isAdblockEnabled: playerRow?.isAdblockEnabled === '1', skipOpeningEnabled: playerRow?.skipOpeningEnabled !== '0', skipOpeningDuration: Number(playerRow?.skipOpeningDuration || 60) },
          general: { cdnUrl: genRow?.cdnUrl || '', downloadCdnUrl: genRow?.downloadCdnUrl || '', isCustomDownloadCdnEnabled: genRow?.isCustomDownloadCdnEnabled === '1', hasVkServiceToken: !!genRow?.vkServiceToken }
        }, 200, corsHeaders);
      }

      if (method === 'POST') {
        const body = await request.json();
        const stype = body.settingsType;
        if (stype === 'general') {
          await queryTurso(
            "INSERT INTO settings (id, type, cdnUrl, downloadCdnUrl, isCustomDownloadCdnEnabled, vkServiceToken) VALUES (?, 'general', ?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET cdnUrl=excluded.cdnUrl, downloadCdnUrl=excluded.downloadCdnUrl, isCustomDownloadCdnEnabled=excluded.isCustomDownloadCdnEnabled, vkServiceToken=CASE WHEN excluded.vkServiceToken != '' THEN excluded.vkServiceToken ELSE settings.vkServiceToken END;",
            [generateUUID(), body.cdnUrl || '', body.downloadCdnUrl || '', body.isCustomDownloadCdnEnabled ? 1 : 0, body.vkServiceToken || body.vkApiKey || ''],
            env
          );
        } else if (stype === 'player') {
          await queryTurso(
            "INSERT INTO settings (id, type, playerType, autoplay, vastEnabled, vastTags, isAdblockEnabled, skipOpeningEnabled, skipOpeningDuration) VALUES (?, 'player', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET playerType=excluded.playerType, autoplay=excluded.autoplay, vastEnabled=excluded.vastEnabled, vastTags=excluded.vastTags, isAdblockEnabled=excluded.isAdblockEnabled, skipOpeningEnabled=excluded.skipOpeningEnabled, skipOpeningDuration=excluded.skipOpeningDuration;",
            [generateUUID(), body.playerType || 'jwplayer', body.autoplay ? '1' : '0', body.vastEnabled ? '1' : '0', JSON.stringify(body.vastTags || []), body.isAdblockEnabled ? '1' : '0', body.skipOpeningEnabled === false ? '0' : '1', Math.max(0, Number(body.skipOpeningDuration || 60))],
            env
          );
        } else if (stype === 'imagekit') {
          await queryTurso(
            "INSERT INTO settings (id, type, publicKey, privateKey, urlEndpoint) VALUES (?, 'imagekit', ?, ?, ?) ON CONFLICT(type) DO UPDATE SET publicKey=excluded.publicKey, privateKey=CASE WHEN excluded.privateKey != '' THEN excluded.privateKey ELSE settings.privateKey END, urlEndpoint=excluded.urlEndpoint;",
            [generateUUID(), body.publicKey || '', body.privateKey || '', body.urlEndpoint || ''],
            env
          );
        } else if (stype === 'admin') {
          const updateArgs = [generateUUID(), body.username || 'admin'];
          if (body.password) {
            await queryTurso(
              "INSERT INTO settings (id, type, username, password) VALUES (?, 'admin', ?, ?) ON CONFLICT(type) DO UPDATE SET username=excluded.username, password=excluded.password;",
              [generateUUID(), body.username || 'admin', body.password],
              env
            );
          }
        }
        return new Response(JSON.stringify({ success: true, message: 'Settings saved' }), { status: 200, headers: corsHeaders });
      }
    }

    if (pathname === '/api/parse' && method === 'POST') {
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
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
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
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


    if (pathname === '/api/vast/test' && method === 'POST') {
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
      try { const body=await request.json(); return json(await testVastUrl(body.url),200,corsHeaders); } catch(e) { return json({error:e.message},422,corsHeaders); }
    }

    if (pathname === '/api/imagekit/auth' && method === 'GET') {
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
      const rows=await getSettingsRows(env); const ik=rows.rows.find(r=>r.type==='imagekit');
      if (!ik?.publicKey || !ik?.privateKey || !ik?.urlEndpoint) return json({error:'Kredensial ImageKit belum lengkap.'},422,corsHeaders);
      const token=generateUUID()+generateUUID().replace(/-/g,''); const expire=Math.floor(Date.now()/1000)+1800;
      const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(ik.privateKey),{name:'HMAC',hash:'SHA-1'},false,['sign']);
      const sigBytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(token+expire)));
      const signature=[...sigBytes].map(b=>b.toString(16).padStart(2,'0')).join('');
      return json({token,expire,signature,publicKey:ik.publicKey,urlEndpoint:ik.urlEndpoint},200,corsHeaders);
    }

    if (pathname === '/api/subtitle') {
      const targetSub = url.searchParams.get('url');
      const slug = url.searchParams.get('slug');
      const index = Number(url.searchParams.get('index') || 0);
      try {
        let raw='';
        if (slug) {
          const res = await queryTurso('SELECT subtitles FROM links WHERE slug = ? LIMIT 1;', [slug], env);
          const row=res.rows[0]; let subs=[]; try{subs=JSON.parse(row?.subtitles||'[]')}catch(e){}
          raw=subs[index]?.content || '';
          if (!raw && subs[index]?.file) {
            const subRes=await fetch(subs[index].file,{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/vtt,text/plain,*/*'},cf:{cacheTtl:86400,cacheEverything:true}}); raw=await subRes.text();
          }
        } else if (targetSub) {
          const subRes=await fetch(decodeURIComponent(targetSub),{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/vtt,text/plain,*/*'},cf:{cacheTtl:86400,cacheEverything:true}}); raw=await subRes.text();
        } else return new Response('Missing subtitle URL or slug', {status:400,headers:corsHeaders});
        if (!raw) return new Response('Subtitle tidak ditemukan',{status:404,headers:corsHeaders});
        const vtt=convertSrtToVtt(raw);
        return new Response(vtt,{status:200,headers:{...corsHeaders,'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'public, max-age=604800, s-maxage=604800'}});
      } catch(e) { return new Response(`Subtitle error: ${e.message}`,{status:500,headers:corsHeaders}); }
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
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
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
        const sources = Array.isArray(body.sources) ? body.sources : [];
        const subtitles = Array.isArray(body.subtitles) ? body.subtitles : [];

        let hostType = 'other';
        const lower = originalUrl.toLowerCase();
        if (lower.includes('vk.com') || lower.includes('vkvideo.ru')) hostType = 'vk';
        else if (lower.includes('ok.ru')) hostType = 'ok';
        else if (lower.includes('sibnet.ru')) hostType = 'sibnet';

        const slugTaken = await queryTurso('SELECT id FROM links WHERE slug = ? LIMIT 1;', [slug], env);
        if (slugTaken.rows.length) return json({error:'Slug sudah digunakan.'},409,corsHeaders);
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
      if (!(await requireAdmin(request, env))) return json({error:'Unauthorized'},401,corsHeaders);
      const linkId = singleLinkMatch[1];

      if (method === 'PUT') {
        const body = await request.json();
        const title=(body.title||'').trim(), originalUrl=(body.originalUrl||'').trim();
        if (!title || !originalUrl) return json({error:'Title dan originalUrl wajib diisi.'},400,corsHeaders);
        let slug=(body.slug||'').trim().toLowerCase().replace(/[^a-z0-9-_]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'') || generateUUID().slice(0,8);
        const original=await queryTurso('SELECT id FROM links WHERE (slug = ? OR id = ?) AND id != ? LIMIT 1;', [slug,slug,linkId], env);
        if (original.rows.length) return json({error:'Slug sudah digunakan.'},409,corsHeaders);
        let hostType='other'; const lower=originalUrl.toLowerCase();
        if(lower.includes('vk.com')||lower.includes('vkvideo.ru')||lower.includes('vk.ru')) hostType='vk'; else if(lower.includes('ok.ru')||lower.includes('odnoklassniki.ru')) hostType='ok'; else if(lower.includes('sibnet.ru')) hostType='sibnet';
        const now=new Date().toISOString();
        await queryTurso('UPDATE links SET title=?,slug=?,originalUrl=?,posterUrl=?,sources=?,hostType=?,updatedAt=?,subtitles=? WHERE id=? OR slug=?;', [title,slug,originalUrl,(body.posterUrl||'').trim(),JSON.stringify(body.sources||[]),hostType,now,JSON.stringify(body.subtitles||[]),linkId,linkId], env);
        return json({success:true,slug},200,corsHeaders);
      }
      if (method === 'DELETE') {
        await queryTurso("DELETE FROM links WHERE id = ? OR slug = ?;", [linkId, linkId], env);
        return new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ message: 'ShinDora Stream Turso Worker Active' }), { status: 200, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    if (!schemaEnsured) { try { await ensureSchema(env); } catch(e) {} schemaEnsured = true; }
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
