/**
 * SHINDORA STREAM - 100% STANDALONE CLOUDFLARE WORKER DENGAN CLOUDFLARE D1 SQL DATABASE
 * 
 * Worker ini 100% MANDIRI tanpa memerlukan server backend terpisah (Vercel/Node/Python).
 * Semua database tersimpan di Cloudflare D1 SQL di edge, stream diproxy langsung lewat Cloudflare,
 * dan seluruh REST API serta embed player ditangani dalam 1 Worker.
 * 
 * BINDING D1:
 * env.DB -> Cloudflare D1 Database binding ("shindora-stream" / ID: 330e80a6-665d-4ae9-b204-f7ce1c91a6e8)
 */

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

async function hmacSha1Hex(key, message) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const msgData = encoder.encode(message);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
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

  // --- A. VK VIDEO ---
  if (isVk) {
    let vkToken = customVkToken ? customVkToken.trim() : '';

    const match = url.match(/video(-?\d+)_(\d+)/) || url.match(/video(-?\d+_\d+)/) || url.match(/clip(-?\d+)_(\d+)/);
    let oid = '', vid = '';
    if (match) {
      if (match[2]) {
        oid = match[1]; vid = match[2];
      } else {
        const parts = match[1].split('_');
        if (parts.length >= 2) { oid = parts[0]; vid = parts[1]; }
      }
    }

    let accessKey = '';
    const listMatch = url.match(/list=([a-zA-Z0-9_\-]+)/);
    if (listMatch) accessKey = listMatch[1];
    const accMatch = url.match(/access_key=([a-zA-Z0-9_\-]+)/);
    if (accMatch) accessKey = accMatch[1];

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
        const embedRes = await fetch(embedTarget, {
          headers: { 'User-Agent': userAgent, 'Referer': 'https://vk.com/' }
        });
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
  }

  // --- B. OK.RU ---
  else if (isOk) {
    const okMatch = url.match(/video(?:embed)?\/(\d+)/);
    const videoId = okMatch ? okMatch[1] : '';
    if (!videoId) throw new Error('Format ID OK.ru tidak valid');

    const embedRes = await fetch(`https://ok.ru/videoembed/${videoId}`, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://ok.ru/' }
    });
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
  }

  // --- C. SIBNET ---
  else if (isSibnet) {
    const sibMatch = url.match(/video(\d+)/) || url.match(/videoid=(\d+)/) || url.match(/sibnet\.ru\/(?:video\/|v\/)?(\d+)/);
    const videoId = sibMatch ? sibMatch[1] : '';
    if (!videoId) throw new Error('Format ID Sibnet tidak valid');

    title = `Sibnet Video #${videoId}`;
    const shellRes = await fetch(`https://video.sibnet.ru/shell.php?videoid=${videoId}`, {
      headers: { 'User-Agent': userAgent, 'Referer': 'https://video.sibnet.ru/' }
    });
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

  if (sources.length === 0) {
    throw new Error('Gagal mengekstrak video stream.');
  }

  return { title, posterUrl, hostType, sources };
}

// ===========================================================================
// MAIN WORKER HANDLER
// ===========================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    const DB = env.DB;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, User-Agent, Referer, Origin',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type, ETag, Last-Modified, X-Token-Recovered, X-Bypass-Vercel',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!DB) {
      return new Response(JSON.stringify({ error: 'Cloudflare D1 binding (env.DB) is not attached.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // -----------------------------------------------------------------------
    // A. AUTHENTICATION ENDPOINTS
    // -----------------------------------------------------------------------
    if (pathname === '/api/auth/login' && method === 'POST') {
      try {
        const body = await request.json();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();
        const remember = body.remember !== false;

        const adminRow = await DB.prepare("SELECT username, password FROM settings WHERE type = 'admin'").first();
        const adminUser = adminRow?.username || 'admin';
        const adminPass = adminRow?.password || 'admin123';

        if (username === adminUser && password === adminPass) {
          const token = generateUUID();
          const refreshToken = generateUUID();
          const now = new Date();
          const expiresAt = new Date(now.getTime() + 3600 * 1000).toISOString();
          const refreshExpiresAt = new Date(now.getTime() + (remember ? 30 * 86400 * 1000 : 7 * 86400 * 1000)).toISOString();

          await DB.prepare("INSERT INTO sessions (id, token, username, expiresAt, refreshToken, refreshExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(generateUUID(), token, username, expiresAt, refreshToken, refreshExpiresAt, now.toISOString(), now.toISOString())
            .run();

          const res = new Response(JSON.stringify({ success: true, user: username, token }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
          res.headers.append('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
          res.headers.append('Set-Cookie', `refresh_token=${refreshToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${remember ? 2592000 : 604800}`);
          return res;
        }

        return new Response(JSON.stringify({ detail: 'Invalid username or password' }), { status: 401, headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ detail: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const cookie = request.headers.get('Cookie') || '';
      const tokenMatch = cookie.match(/session_token=([^;]+)/);
      if (tokenMatch) {
        await DB.prepare("DELETE FROM sessions WHERE token = ?").bind(tokenMatch[1]).run();
      }
      const res = new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
      res.headers.append('Set-Cookie', 'session_token=; Path=/; HttpOnly; Max-Age=0');
      res.headers.append('Set-Cookie', 'refresh_token=; Path=/; HttpOnly; Max-Age=0');
      return res;
    }

    if ((pathname === '/api/auth/session' || pathname === '/api/auth/me') && method === 'GET') {
      const cookie = request.headers.get('Cookie') || '';
      let token = (cookie.match(/session_token=([^;]+)/) || [])[1];
      const authHdr = request.headers.get('Authorization') || '';
      if (!token && authHdr.startsWith('Bearer ')) token = authHdr.replace('Bearer ', '').trim();

      if (token) {
        const sess = await DB.prepare("SELECT username, expiresAt FROM sessions WHERE token = ?").bind(token).first();
        if (sess && new Date(sess.expiresAt) > new Date()) {
          return new Response(JSON.stringify({ authenticated: true, user: sess.username, token }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response(JSON.stringify({ authenticated: false }), { status: 401, headers: corsHeaders });
    }

    // -----------------------------------------------------------------------
    // B. STATS & SETTINGS ENDPOINTS
    // -----------------------------------------------------------------------
    if (pathname === '/api/stats' || pathname === '/api/dashboard/stats') {
      const totalRow = await DB.prepare("SELECT COUNT(*) as count FROM links").first();
      const vkRow = await DB.prepare("SELECT COUNT(*) as count FROM links WHERE hostType = 'vk' OR originalUrl LIKE '%vk.com%' OR originalUrl LIKE '%vkvideo.ru%'").first();
      const okRow = await DB.prepare("SELECT COUNT(*) as count FROM links WHERE hostType = 'ok' OR hostType = 'okru' OR originalUrl LIKE '%ok.ru%'").first();
      const sibnetRow = await DB.prepare("SELECT COUNT(*) as count FROM links WHERE hostType = 'sibnet' OR originalUrl LIKE '%sibnet.ru%'").first();

      return new Response(JSON.stringify({
        success: true,
        stats: {
          totalVideos: totalRow?.count || 0,
          vkCount: vkRow?.count || 0,
          okCount: okRow?.count || 0,
          sibnetCount: sibnetRow?.count || 0,
        }
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (pathname === '/api/settings') {
      if (method === 'GET') {
        const adminRow = await DB.prepare("SELECT username FROM settings WHERE type = 'admin'").first();
        const ikRow = await DB.prepare("SELECT publicKey, urlEndpoint, privateKey FROM settings WHERE type = 'imagekit'").first();
        const playerRow = await DB.prepare("SELECT playerType, autoplay, vastEnabled, vastTags, isAdblockEnabled FROM settings WHERE type = 'player'").first();
        const genRow = await DB.prepare("SELECT cdnUrl, downloadCdnUrl, isCustomDownloadCdnEnabled, vkServiceToken FROM settings WHERE type = 'general'").first();

        let vastTags = [];
        try { vastTags = playerRow?.vastTags ? JSON.parse(playerRow.vastTags) : []; } catch (e) {}

        return new Response(JSON.stringify({
          imagekit: {
            publicKey: ikRow?.publicKey || '',
            urlEndpoint: ikRow?.urlEndpoint || '',
            hasPrivateKey: !!ikRow?.privateKey
          },
          admin: { username: adminRow?.username || 'admin' },
          player: {
            playerType: playerRow?.playerType || 'jwplayer',
            autoplay: playerRow?.autoplay !== 0,
            vastEnabled: playerRow?.vastEnabled === 1,
            vastTags,
            isAdblockEnabled: playerRow?.isAdblockEnabled === 1
          },
          general: {
            cdnUrl: genRow?.cdnUrl || '',
            downloadCdnUrl: genRow?.downloadCdnUrl || '',
            isCustomDownloadCdnEnabled: genRow?.isCustomDownloadCdnEnabled === 1,
            vkServiceToken: genRow?.vkServiceToken || ''
          }
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (method === 'POST') {
        const body = await request.json();
        const stype = body.settingsType;
        if (!stype) return new Response(JSON.stringify({ error: 'settingsType required' }), { status: 400, headers: corsHeaders });

        if (stype === 'player') {
          await DB.prepare("INSERT INTO settings (id, type, playerType, autoplay, vastEnabled, vastTags, isAdblockEnabled) VALUES (?, 'player', ?, ?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET playerType=excluded.playerType, autoplay=excluded.autoplay, vastEnabled=excluded.vastEnabled, vastTags=excluded.vastTags, isAdblockEnabled=excluded.isAdblockEnabled")
            .bind(generateUUID(), body.playerType || 'jwplayer', body.autoplay ? 1 : 0, body.vastEnabled ? 1 : 0, JSON.stringify(body.vastTags || []), body.isAdblockEnabled ? 1 : 0)
            .run();
        } else if (stype === 'general') {
          await DB.prepare("INSERT INTO settings (id, type, cdnUrl, downloadCdnUrl, isCustomDownloadCdnEnabled, vkServiceToken) VALUES (?, 'general', ?, ?, ?, ?) ON CONFLICT(type) DO UPDATE SET cdnUrl=excluded.cdnUrl, downloadCdnUrl=excluded.downloadCdnUrl, isCustomDownloadCdnEnabled=excluded.isCustomDownloadCdnEnabled, vkServiceToken=excluded.vkServiceToken")
            .bind(generateUUID(), body.cdnUrl || '', body.downloadCdnUrl || '', body.isCustomDownloadCdnEnabled ? 1 : 0, body.vkServiceToken || body.vkApiKey || '')
            .run();
        } else if (stype === 'imagekit') {
          const old = await DB.prepare("SELECT privateKey FROM settings WHERE type = 'imagekit'").first();
          const pKey = (body.privateKey && body.privateKey !== '●●●●●') ? body.privateKey : (old?.privateKey || '');
          await DB.prepare("INSERT INTO settings (id, type, publicKey, privateKey, urlEndpoint) VALUES (?, 'imagekit', ?, ?, ?) ON CONFLICT(type) DO UPDATE SET publicKey=excluded.publicKey, privateKey=excluded.privateKey, urlEndpoint=excluded.urlEndpoint")
            .bind(generateUUID(), body.publicKey || '', pKey, body.urlEndpoint || '')
            .run();
        } else if (stype === 'admin') {
          if (!body.username || !body.password) return new Response(JSON.stringify({ error: 'Username and password required' }), { status: 400, headers: corsHeaders });
          await DB.prepare("INSERT INTO settings (id, type, username, password) VALUES (?, 'admin', ?, ?) ON CONFLICT(type) DO UPDATE SET username=excluded.username, password=excluded.password")
            .bind(generateUUID(), body.username, body.password)
            .run();
        }

        return new Response(JSON.stringify({ success: true, message: 'Settings saved' }), { status: 200, headers: corsHeaders });
      }
    }

    if (pathname === '/api/imagekit-auth' && method === 'GET') {
      const ikRow = await DB.prepare("SELECT publicKey, privateKey, urlEndpoint FROM settings WHERE type = 'imagekit'").first();
      const token = generateUUID();
      const expire = Math.floor(Date.now() / 1000) + 2400;
      const signature = await hmacSha1Hex(ikRow?.privateKey || '', `${token}${expire}`);
      return new Response(JSON.stringify({
        token, expire, signature, publicKey: ikRow?.publicKey || '', urlEndpoint: ikRow?.urlEndpoint || ''
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // -----------------------------------------------------------------------
    // C. VIDEO PARSE & LIVE STREAM ENDPOINTS
    // -----------------------------------------------------------------------
    if (pathname === '/api/parse' && method === 'POST') {
      try {
        const body = await request.json();
        const genRow = await DB.prepare("SELECT vkServiceToken FROM settings WHERE type = 'general'").first();
        const extracted = await extractVideoStreams(body.url, genRow?.vkServiceToken || '');
        return new Response(JSON.stringify(extracted), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 422, headers: corsHeaders });
      }
    }

    if (pathname === '/api/parse-stream' && method === 'GET') {
      const slug = url.searchParams.get('slug');
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

      const row = await DB.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first();
      if (!row) return new Response(JSON.stringify({ error: 'Video not found' }), { status: 404, headers: corsHeaders });

      const genRow = await DB.prepare("SELECT cdnUrl, vkServiceToken FROM settings WHERE type = 'general'").first();
      const cdnUrlVal = (genRow?.cdnUrl || '').replace(/\/+$/, '');

      let sources = [];
      let subtitles = [];
      try { sources = JSON.parse(row.sources || '[]'); } catch (e) {}
      try { subtitles = JSON.parse(row.subtitles || '[]'); } catch (e) {}

      if (force) {
        try {
          const fresh = await extractVideoStreams(row.originalUrl, genRow?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            sources = fresh.sources;
            const now = new Date().toISOString();
            await DB.prepare("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?")
              .bind(JSON.stringify(fresh.sources), now, slug)
              .run();
          }
        } catch (e) {}
      }

      const formattedSources = sources.map(s => {
        let f = s.file || '';
        if (f.startsWith('/api/stream') && !f.includes('slug=') && slug) {
          f += (f.includes('?') ? '&' : '?') + `slug=${encodeURIComponent(slug)}`;
        }
        if (cdnUrlVal && f.startsWith('/api/')) f = `${cdnUrlVal}${f}`;
        return { ...s, file: f };
      });

      return new Response(JSON.stringify({
        success: true,
        title: row.title,
        slug: row.slug,
        posterUrl: row.posterUrl,
        sources: formattedSources,
        subtitles,
        hostType: row.hostType
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // -----------------------------------------------------------------------
    // D. CRON 24H REFRESH TOKENS (D1 SQL)
    // -----------------------------------------------------------------------
    if (pathname === '/api/cron/refresh-tokens' || pathname === '/api/cron/token-refresh') {
      const genRow = await DB.prepare("SELECT vkServiceToken FROM settings WHERE type = 'general'").first();
      const links = await DB.prepare("SELECT slug, originalUrl, title FROM links ORDER BY updatedAt ASC LIMIT 30").all();
      let refreshedCount = 0;

      for (const l of links?.results || []) {
        try {
          const fresh = await extractVideoStreams(l.originalUrl, genRow?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            const now = new Date().toISOString();
            await DB.prepare("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?")
              .bind(JSON.stringify(fresh.sources), now, l.slug)
              .run();
            refreshedCount++;
          }
        } catch (e) {}
      }

      return new Response(JSON.stringify({
        success: true,
        message: `Cron D1: Berhasil menyegarkan ${refreshedCount} video.`,
        refreshedCount
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // -----------------------------------------------------------------------
    // E. SUBTITLE PROXY (.srt to .vtt)
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // F. STREAMING & DOWNLOAD PROXY
    // -----------------------------------------------------------------------
    if (pathname === '/api/stream' || pathname.startsWith('/api/stream/')) {
      let targetUrl = url.searchParams.get('url');
      let host = (url.searchParams.get('host') || 'vk').toLowerCase();
      let slug = url.searchParams.get('slug') || '';
      let quality = '';

      const match = pathname.match(/^\/api\/stream\/([^\/]+)\/([^\/]+)$/);
      if (match) {
        quality = match[1].replace(/p$/i, '');
        slug = match[2].replace(/\.mp4$/, '');

        const linkRow = await DB.prepare("SELECT sources FROM links WHERE slug = ?").bind(slug).first();
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
      return await handleProxyStreamD1(request, decodeURIComponent(targetUrl), host, corsHeaders, DB, slug, quality, false);
    }

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
        const linkRow = await DB.prepare("SELECT title, sources FROM links WHERE slug = ?").bind(slug).first();
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
      return await handleProxyStreamD1(request, decodeURIComponent(targetUrl), host, corsHeaders, DB, slug, quality, true, customFilename);
    }

    // -----------------------------------------------------------------------
    // G. LINKS CRUD (D1 SQL)
    // -----------------------------------------------------------------------
    if (pathname === '/api/links') {
      if (method === 'GET') {
        const rows = await DB.prepare("SELECT * FROM links ORDER BY createdAt DESC").all();
        const results = (rows?.results || []).map(r => {
          let sources = [], subtitles = [];
          try { sources = JSON.parse(r.sources || '[]'); } catch (e) {}
          try { subtitles = JSON.parse(r.subtitles || '[]'); } catch (e) {}
          return {
            id: r.id,
            title: r.title,
            slug: r.slug,
            originalUrl: r.originalUrl,
            posterUrl: r.posterUrl,
            sources,
            subtitles,
            hostType: r.hostType,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt
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

        if (!title || !originalUrl || sources.length === 0) {
          return new Response(JSON.stringify({ error: 'Title, originalUrl, and sources are required' }), { status: 400, headers: corsHeaders });
        }

        let hostType = 'other';
        const lower = originalUrl.toLowerCase();
        if (lower.includes('vk.com') || lower.includes('vkvideo.ru')) hostType = 'vk';
        else if (lower.includes('ok.ru')) hostType = 'ok';
        else if (lower.includes('sibnet.ru')) hostType = 'sibnet';

        const id = generateUUID();
        const now = new Date().toISOString();

        await DB.prepare("INSERT INTO links (id, title, slug, originalUrl, posterUrl, sources, hostType, createdAt, updatedAt, subtitles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, title, slug, originalUrl, posterUrl, JSON.stringify(sources), hostType, now, now, JSON.stringify(subtitles))
          .run();

        return new Response(JSON.stringify({ id, title, slug, originalUrl, posterUrl, sources, subtitles, hostType, createdAt: now, updatedAt: now }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const singleLinkMatch = pathname.match(/^\/api\/links\/([^\/]+)$/);
    if (singleLinkMatch) {
      const linkId = singleLinkMatch[1];

      if (method === 'GET') {
        const r = await DB.prepare("SELECT * FROM links WHERE id = ? OR slug = ?").bind(linkId, linkId).first();
        if (!r) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
        let sources = [], subtitles = [];
        try { sources = JSON.parse(r.sources || '[]'); } catch (e) {}
        try { subtitles = JSON.parse(r.subtitles || '[]'); } catch (e) {}
        return new Response(JSON.stringify({
          id: r.id, title: r.title, slug: r.slug, originalUrl: r.originalUrl, posterUrl: r.posterUrl,
          sources, subtitles, hostType: r.hostType, createdAt: r.createdAt, updatedAt: r.updatedAt
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (method === 'PUT') {
        const body = await request.json();
        const now = new Date().toISOString();
        await DB.prepare("UPDATE links SET title = ?, originalUrl = ?, posterUrl = ?, sources = ?, subtitles = ?, updatedAt = ? WHERE id = ? OR slug = ?")
          .bind(body.title, body.originalUrl, body.posterUrl || '', JSON.stringify(body.sources || []), JSON.stringify(body.subtitles || []), now, linkId, linkId)
          .run();
        return new Response(JSON.stringify({ success: true, message: 'Updated' }), { status: 200, headers: corsHeaders });
      }

      if (method === 'DELETE') {
        await DB.prepare("DELETE FROM links WHERE id = ? OR slug = ?").bind(linkId, linkId).run();
        return new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ message: 'ShinDora Stream D1 Worker Active' }), { status: 200, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    const DB = env.DB;
    if (!DB) return;
    try {
      const genRow = await DB.prepare("SELECT vkServiceToken FROM settings WHERE type = 'general'").first();
      const links = await DB.prepare("SELECT slug, originalUrl FROM links ORDER BY updatedAt ASC LIMIT 30").all();

      for (const l of links?.results || []) {
        try {
          const fresh = await extractVideoStreams(l.originalUrl, genRow?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            const now = new Date().toISOString();
            await DB.prepare("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?")
              .bind(JSON.stringify(fresh.sources), now, l.slug)
              .run();
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
};

async function handleProxyStreamD1(request, decodedTargetUrl, host, corsHeaders, DB, slug, quality, isDownload = false, filename = '') {
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

    if ((upstreamRes.status === 401 || upstreamRes.status === 403 || upstreamRes.status === 404 || upstreamRes.status === 410) && DB && slug) {
      try {
        const linkRow = await DB.prepare("SELECT originalUrl FROM links WHERE slug = ?").bind(slug).first();
        if (linkRow?.originalUrl) {
          const genRow = await DB.prepare("SELECT vkServiceToken FROM settings WHERE type = 'general'").first();
          const fresh = await extractVideoStreams(linkRow.originalUrl, genRow?.vkServiceToken || '');
          if (fresh.sources?.length > 0) {
            const now = new Date().toISOString();
            await DB.prepare("UPDATE links SET sources = ?, updatedAt = ? WHERE slug = ?")
              .bind(JSON.stringify(fresh.sources), now, slug)
              .run();

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
    return new Response(`Worker D1 Stream Error: ${err.message}`, { status: 500, headers: corsHeaders });
  }
}
