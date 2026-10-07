/**
 * SHINDORA STREAM & DOWNLOAD - ALL-IN-ONE STANDALONE CLOUDFLARE WORKER
 * 
 * Kombinasi lengkap Streaming Proxy + Direct Download Proxy + Subtitle Converter + 24h Cron Refresh
 * dalam 1 file Cloudflare Worker mandiri yang siap di-deploy secara instan.
 */

const DEFAULT_ORIGIN_URL = "https://e127797a-9d93-4499-be31-b84492eb6a96.preview.emergentagent.com";

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const originAppUrl = (env?.ORIGIN_APP_URL || env?.VERCEL_APP_URL || env?.NEXT_PUBLIC_BASE_URL || DEFAULT_ORIGIN_URL).replace(/\/+$/, '');

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent, Referer, Origin, Authorization",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type, ETag, Last-Modified, X-Token-Recovered, X-Bypass-Vercel",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. Cron 24h Token Refresh
    if (pathname === "/api/cron/refresh-tokens" || pathname === "/api/cron/token-refresh") {
      try {
        const cronRes = await fetch(`${originAppUrl}/api/cron/refresh-tokens?hours=24&limit=30`, {
          headers: { "Accept": "application/json" }
        });
        const cronData = await cronRes.text();
        return new Response(cronData, {
          status: cronRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 2. Subtitle Proxy (.srt to .vtt)
    if (pathname === "/api/subtitle") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return new Response("Missing subtitle URL", { status: 400, headers: corsHeaders });
      try {
        const decodedUrl = decodeURIComponent(targetUrl);
        const subRes = await fetch(decodedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/vtt,text/plain,*/*"
          },
          cf: { cacheTtl: 86400, cacheEverything: true }
        });
        const raw = await subRes.text();
        const vtt = convertSrtToVtt(raw);
        return new Response(vtt, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "text/vtt; charset=utf-8",
            "Cache-Control": "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
            "X-Bypass-Vercel": "1"
          }
        });
      } catch (e) {
        return new Response(`Worker Subtitle Error: ${e.message}`, { status: 500, headers: corsHeaders });
      }
    }

    // 3. Direct Streaming Proxy: /api/stream or /api/stream/:quality/:slug
    if (pathname === "/api/stream" || pathname.startsWith("/api/stream/")) {
      let targetUrl = url.searchParams.get("url");
      let host = (url.searchParams.get("host") || "vk").toLowerCase();
      let slug = url.searchParams.get("slug") || "";
      let quality = "";

      const match = pathname.match(/^\/api\/stream\/([^\/]+)\/([^\/]+)$/);
      if (match) {
        quality = match[1].replace(/p$/i, '');
        slug = match[2].replace(/\.mp4$/, "");

        try {
          const metaRes = await fetch(`${originAppUrl}/api/parse-stream?slug=${slug}`, {
            headers: { "Accept": "application/json" },
            cf: { cacheTtl: 300 }
          });
          if (metaRes.ok) {
            const data = await metaRes.json();
            let source = data.sources?.find(s => s.label.toLowerCase().includes(quality.toLowerCase()));
            if (!source && data.sources?.length > 0) source = data.sources[0];
            if (source?.file) {
              const parsed = new URL(source.file, "http://localhost");
              targetUrl = parsed.searchParams.get("url") || source.file;
              host = parsed.searchParams.get("host") || "vk";
            }
          }
        } catch (e) {}
      }

      if (!targetUrl) return new Response("Missing target stream URL", { status: 400, headers: corsHeaders });
      return await handleProxyStream(request, decodeURIComponent(targetUrl), host, corsHeaders, originAppUrl, slug, quality, false);
    }

    // 4. Direct Download Proxy: /api/download or /api/download/:quality/:slug
    if (pathname === "/api/download" || pathname.startsWith("/api/download/")) {
      let targetUrl = url.searchParams.get("url");
      let host = (url.searchParams.get("host") || "vk").toLowerCase();
      let slug = url.searchParams.get("slug") || "";
      let quality = url.searchParams.get("quality") || "720";
      let customFilename = url.searchParams.get("filename") || "";

      const match = pathname.match(/^\/api\/download\/([^\/]+)\/([^\/]+)$/);
      if (match) {
        quality = match[1].replace(/p$/i, '');
        slug = match[2].replace(/\.mp4$/, "");
      }

      if (slug) {
        try {
          const metaRes = await fetch(`${originAppUrl}/api/parse-stream?slug=${slug}`, {
            headers: { "Accept": "application/json" }
          });
          if (metaRes.ok) {
            const data = await metaRes.json();
            customFilename = formatDownloadFilename(data.title || slug, quality);
            let source = data.sources?.find(s => s.label.toLowerCase().includes(quality.toLowerCase()));
            if (!source && data.sources?.length > 0) source = data.sources[0];
            if (source?.file) {
              const parsed = new URL(source.file, "http://localhost");
              targetUrl = parsed.searchParams.get("url") || source.file;
              host = parsed.searchParams.get("host") || "vk";
            }
          }
        } catch (e) {}
      }

      if (!targetUrl) return new Response("Missing download URL", { status: 400, headers: corsHeaders });
      if (!customFilename) customFilename = formatDownloadFilename("video", quality);
      return await handleProxyStream(request, decodeURIComponent(targetUrl), host, corsHeaders, originAppUrl, slug, quality, true, customFilename);
    }

    // 5. Origin Fallback
    try {
      const originRequest = new Request(request);
      const originUrl = new URL(request.url);
      const appUrlParsed = new URL(originAppUrl);
      originUrl.hostname = appUrlParsed.hostname;
      originUrl.protocol = appUrlParsed.protocol;
      if (appUrlParsed.port) originUrl.port = appUrlParsed.port;
      return await fetch(originUrl.toString(), originRequest);
    } catch (err) {
      return new Response(`Origin Connection Failed: ${err.message}`, { status: 502 });
    }
  },

  async scheduled(event, env, ctx) {
    const originAppUrl = (env?.ORIGIN_APP_URL || env?.VERCEL_APP_URL || env?.NEXT_PUBLIC_BASE_URL || DEFAULT_ORIGIN_URL).replace(/\/+$/, '');
    try {
      await fetch(`${originAppUrl}/api/cron/refresh-tokens?hours=24&limit=30`, { headers: { "Accept": "application/json" } });
    } catch (e) {}
  }
};

async function handleProxyStream(request, decodedTargetUrl, host, corsHeaders, originAppUrl, slug, quality, isDownload = false, filename = "") {
  const headers = new Headers();
  headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

  if (host === "vk" || host === "vkvideo") {
    headers.set("Referer", "https://vk.com/");
    headers.set("Origin", "https://vk.com");
  } else if (host === "ok" || host === "okru") {
    headers.set("Referer", "https://ok.ru/");
    headers.set("Origin", "https://ok.ru");
  } else if (host === "sibnet") {
    headers.set("Referer", "https://video.sibnet.ru/");
    headers.set("Origin", "https://video.sibnet.ru");
  }

  const range = request.headers.get("range");
  if (range) headers.set("Range", range);

  try {
    let upstreamRes = await fetch(decodedTargetUrl, { method: request.method, headers, redirect: "follow" });

    if ((upstreamRes.status === 401 || upstreamRes.status === 403 || upstreamRes.status === 404 || upstreamRes.status === 410) && originAppUrl && slug) {
      try {
        const refreshRes = await fetch(`${originAppUrl}/api/parse-stream?slug=${slug}&force=1`, { headers: { "Accept": "application/json" } });
        if (refreshRes.ok) {
          const freshData = await refreshRes.json();
          let source = freshData.sources?.find(s => quality && s.label.toLowerCase().includes(quality.toLowerCase())) || freshData.sources?.[0];
          if (source?.file) {
            const parsed = new URL(source.file, "http://localhost");
            const freshUrl = parsed.searchParams.get("url") || source.file;
            upstreamRes = await fetch(decodeURIComponent(freshUrl), { method: request.method, headers, redirect: "follow" });
          }
        }
      } catch (err) {}
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("X-Bypass-Vercel", "1");

    if (isDownload) {
      responseHeaders.set("Content-Type", "application/octet-stream");
      const asciiFname = (filename || "video.mp4").replace(/[^\x20-\x7E]/g, '_');
      responseHeaders.set("Content-Disposition", `attachment; filename="${asciiFname}"; filename*=UTF-8''${encodeURIComponent(filename || 'video.mp4')}`);
    } else {
      const upstreamCt = upstreamRes.headers.get("content-type");
      responseHeaders.set("Content-Type", (upstreamCt && upstreamCt.includes("video")) ? upstreamCt : "video/mp4");
    }

    for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
      if (upstreamRes.headers.get(h)) responseHeaders.set(h, upstreamRes.headers.get(h));
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Worker Proxy Error: ${err.message}`, { status: 500, headers: corsHeaders });
  }
}
