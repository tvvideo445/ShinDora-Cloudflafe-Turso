/**
 * SHINDORA CDN - CLOUDFLARE WORKER FOR VIDEO STREAMING & EMBED PLAYER (STREAM WORKER)
 * 
 * Skrip ini didesain khusus untuk menangani streaming video proxy (JW Player & Video.js)
 * dari VK, VK Video, OK.ru, dan Sibnet ke browser klien melalui jaringan global Cloudflare (Free Bandwidth)
 * guna membypass 100% Functions Storage & Outbound Bandwidth Vercel supaya hemat maksimal.
 * 
 * FITUR UTAMA:
 * 1. 100% Membypass Functions Execution & Storage Bandwidth Vercel dengan proxy streaming langsung via Cloudflare edge.
 * 2. Dukungan Byte-Range Seeking (HTTP 206 Partial Content) yang mulus dan bebas buffering.
 * 3. Otomatis Token Expired Recovery (VK, OK.ru, Sibnet) saat user mengklik atau menonton jika stream upstream mengembalikan 401/403/404/410.
 * 4. Auto Token Expired Refresh Berkala Tiap 24 Jam (Cron Scheduled Trigger) saat video tidak ditonton.
 * 5. Subtitle Proxy dengan auto-conversion SRT ke WebVTT, Edge Caching, dan bebas CORS.
 * 6. Direct Quality Stream endpoint: /api/stream/:quality/:slug
 * 7. Edge Metadata & Static Asset Caching untuk meminimalisir pemanggilan Serverless Function Vercel.
 */

const DEFAULT_ORIGIN_URL = "https://e127797a-9d93-4499-be31-b84492eb6a96.preview.emergentagent.com";

function convertSrtToVtt(srtText) {
  if (!srtText) return 'WEBVTT\n\n';
  if (srtText.trim().startsWith('WEBVTT')) return srtText;
  let normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  normalized = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${normalized.trim()}\n`;
}

export default {
  // 1. HTTP REQUEST HANDLER
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const originAppUrl = (env?.ORIGIN_APP_URL || env?.VERCEL_APP_URL || env?.NEXT_PUBLIC_BASE_URL || DEFAULT_ORIGIN_URL).replace(/\/+$/, '');

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent, Referer, Origin, Authorization",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, X-Token-Recovered, X-Bypass-Vercel",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // A. ROUTE: /api/cron/refresh-tokens (24 Jam Auto Refresh Berkala Token Expired)
    if (pathname === "/api/cron/refresh-tokens" || pathname === "/api/cron/token-refresh") {
      try {
        const cronRes = await fetch(`${originAppUrl}/api/cron/refresh-tokens?hours=24&limit=30`, {
          headers: { "Accept": "application/json" }
        });
        const cronData = await cronRes.text();
        return new Response(cronData, {
          status: cronRes.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // B. ROUTE: /api/subtitle?url=... (Subtitle proxy with Edge Caching & WebVTT conversion)
    if (pathname === "/api/subtitle") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return new Response("Missing subtitle URL", { status: 400, headers: corsHeaders });
      }
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

    // C. ROUTE: /api/stream?url=...&host=...&slug=... (Proxying direct video stream bypassing Vercel)
    if (pathname === "/api/stream") {
      const targetUrl = url.searchParams.get("url");
      const host = (url.searchParams.get("host") || "").toLowerCase();
      const slug = url.searchParams.get("slug") || "";

      if (!targetUrl) {
        return new Response("Missing target URL", { status: 400, headers: corsHeaders });
      }

      return await handleProxyStreamWithRecovery(request, decodeURIComponent(targetUrl), host, corsHeaders, originAppUrl, slug);
    }

    // D. ROUTE: /api/stream/[quality]/[slug] or /api/stream/[quality]/[slug].mp4 (Direct Stream URL)
    const streamDirectPattern = /^\/api\/stream\/([^\/]+)\/([^\/]+)$/;
    const match = pathname.match(streamDirectPattern);

    if (match) {
      const quality = match[1].replace(/p$/i, '');
      const slug = match[2].replace(/\.mp4$/, "");

      try {
        const metadataUrl = `${originAppUrl}/api/parse-stream?slug=${slug}`;
        const metadataRes = await fetch(metadataUrl, {
          headers: { "Accept": "application/json" },
          cf: { cacheTtl: 300 }
        });

        if (!metadataRes.ok) {
          return new Response(`Failed to resolve video metadata from origin (Status: ${metadataRes.status})`, {
            status: 404,
            headers: corsHeaders
          });
        }

        const data = await metadataRes.json();
        if (!data.sources || data.sources.length === 0) {
          return new Response("No available streams found for this video", {
            status: 404,
            headers: corsHeaders
          });
        }

        let source = data.sources.find(s => s.label.toLowerCase().includes(quality.toLowerCase()) || s.label.toLowerCase().includes(`${quality}p`));
        if (!source && data.sources.length > 0) {
          source = data.sources[0];
        }

        if (!source || !source.file) {
          return new Response("Quality stream source not found", {
            status: 404,
            headers: corsHeaders
          });
        }

        let targetStreamUrl = "";
        let hostType = "vk";

        if (source.file.startsWith("http")) {
          const parsedSourceUrl = new URL(source.file);
          targetStreamUrl = parsedSourceUrl.searchParams.get("url") || source.file;
          hostType = parsedSourceUrl.searchParams.get("host") || "vk";
        } else {
          const fakeBase = "http://localhost";
          const parsedSourceUrl = new URL(source.file, fakeBase);
          targetStreamUrl = parsedSourceUrl.searchParams.get("url") || "";
          hostType = parsedSourceUrl.searchParams.get("host") || "vk";
        }

        if (!targetStreamUrl) {
          return new Response("Invalid internal stream configuration", {
            status: 400,
            headers: corsHeaders
          });
        }

        return await handleProxyStreamWithRecovery(request, decodeURIComponent(targetStreamUrl), hostType, corsHeaders, originAppUrl, slug, quality);

      } catch (err) {
        return new Response(`Worker Direct Stream Error: ${err.message}`, {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    // E. FALLBACK: Full-Site Proxy to Origin with Edge Caching
    try {
      const originRequest = new Request(request);
      const originUrl = new URL(request.url);
      const appUrlParsed = new URL(originAppUrl);
      originUrl.hostname = appUrlParsed.hostname;
      originUrl.protocol = appUrlParsed.protocol;
      if (appUrlParsed.port) {
        originUrl.port = appUrlParsed.port;
      }

      return await fetch(originUrl.toString(), originRequest);
    } catch (err) {
      return new Response(`Origin Connection Failed: ${err.message}`, {
        status: 502
      });
    }
  },

  // 2. CLOUDFLARE SCHEDULED CRON TRIGGER (Auto Refresh Berkala Tiap 24 Jam saat video tidak dibuka)
  async scheduled(event, env, ctx) {
    const originAppUrl = (env?.ORIGIN_APP_URL || env?.VERCEL_APP_URL || env?.NEXT_PUBLIC_BASE_URL || DEFAULT_ORIGIN_URL).replace(/\/+$/, '');
    console.log('[Cloudflare Worker Cron] Memulai auto-refresh token expired berkala tiap 24 jam...');
    try {
      const cronRes = await fetch(`${originAppUrl}/api/cron/refresh-tokens?hours=24&limit=30`, {
        headers: { "Accept": "application/json" }
      });
      const data = await cronRes.json();
      console.log('[Cloudflare Worker Cron 24h] Sukses:', data.message);
    } catch (err) {
      console.warn('[Cloudflare Worker Cron Exception]:', err.message);
    }
  }
};

async function handleProxyStreamWithRecovery(request, decodedTargetUrl, host, corsHeaders, originAppUrl, slug = "", quality = "") {
  const headers = new Headers();
  headers.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

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
  if (range) {
    headers.set("Range", range);
  }

  try {
    let upstreamResponse = await fetch(decodedTargetUrl, {
      method: request.method,
      headers: headers,
      redirect: "follow",
    });

    // Otomatis Token Recovery jika 401/403/404/410
    if ((upstreamResponse.status === 401 || upstreamResponse.status === 403 || upstreamResponse.status === 404 || upstreamResponse.status === 410) && originAppUrl) {
      try {
        let freshSourceUrl = "";
        if (slug) {
          const refreshRes = await fetch(`${originAppUrl}/api/parse-stream?slug=${slug}&force=1`, {
            headers: { "Accept": "application/json" }
          });
          if (refreshRes.ok) {
            const freshData = await refreshRes.json();
            let freshSource = null;
            if (quality) {
              freshSource = freshData.sources?.find(s => s.label.toLowerCase().includes(quality.toLowerCase()));
            }
            if (!freshSource && freshData.sources?.length > 0) {
              freshSource = freshData.sources[0];
            }
            if (freshSource && freshSource.file) {
              const fakeBase = "http://localhost";
              const parsedFresh = new URL(freshSource.file, fakeBase);
              freshSourceUrl = parsedFresh.searchParams.get("url") || freshSource.file;
            }
          }
        }

        if (freshSourceUrl) {
          upstreamResponse = await fetch(decodeURIComponent(freshSourceUrl), {
            method: request.method,
            headers: headers,
            redirect: "follow",
          });
        }
      } catch (recoveryErr) {}
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("X-Bypass-Vercel", "1");

    const upstreamContentType = upstreamResponse.headers.get("content-type");
    const contentType = (upstreamContentType && upstreamContentType.includes("video"))
      ? upstreamContentType
      : "video/mp4";
    responseHeaders.set("Content-Type", contentType);

    if (upstreamResponse.headers.get("content-length")) {
      responseHeaders.set("Content-Length", upstreamResponse.headers.get("content-length"));
    }
    if (upstreamResponse.headers.get("content-range")) {
      responseHeaders.set("Content-Range", upstreamResponse.headers.get("content-range"));
    }
    if (upstreamResponse.headers.get("etag")) {
      responseHeaders.set("ETag", upstreamResponse.headers.get("etag"));
    }
    if (upstreamResponse.headers.get("last-modified")) {
      responseHeaders.set("Last-Modified", upstreamResponse.headers.get("last-modified"));
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });

  } catch (err) {
    return new Response(`Worker Stream Proxy Error: ${err.message}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
}
