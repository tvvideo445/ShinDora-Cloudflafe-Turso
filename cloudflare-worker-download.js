/**
 * SHINDORA CDN - CLOUDFLARE WORKER FOR DEDICATED DIRECT DOWNLOAD (DOWNLOAD WORKER)
 * 
 * Skrip Worker ini didesain khusus untuk menangani direct download video
 * dari VK Video, OK.ru, dan Sibnet dengan menyematkan header Content-Disposition: attachment
 * secara otomatis guna memaksa unduhan langsung di browser dan menghemat 100% bandwidth Vercel.
 * 
 * FITUR UTAMA:
 * 1. 100% Membypass bandwidth Vercel saat mengunduh video ukuran besar.
 * 2. Format Nama File Otomatis: "<Judul Video> (<Kualitas>).mp4" (Contoh: "doraemon 993 (480p).mp4").
 * 3. Otomatis Token Expired Recovery (VK, OK.ru, Sibnet) saat user mengklik download jika link kadaluarsa.
 * 4. Auto Token Expired Refresh Berkala Tiap 24 Jam (Cron Scheduled Trigger).
 * 5. Endpoint Direct Download: /api/download/:quality/:slug
 */

const DEFAULT_ORIGIN_URL = "https://e127797a-9d93-4499-be31-b84492eb6a96.preview.emergentagent.com";

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
      "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent, Referer, Origin",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type, ETag, Last-Modified, X-Bypass-Vercel",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

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

    if (pathname === "/api/download") {
      const targetUrl = url.searchParams.get("url");
      const host = (url.searchParams.get("host") || "vk").toLowerCase();
      const slug = url.searchParams.get("slug");
      const quality = url.searchParams.get("quality") || "720";
      let customFilename = url.searchParams.get("filename") || "";

      if (slug) {
        try {
          const metadataUrl = `${originAppUrl}/api/parse-stream?slug=${slug}`;
          const metadataRes = await fetch(metadataUrl, {
            headers: { "Accept": "application/json" }
          });

          if (!metadataRes.ok) {
            return new Response(`Failed to resolve video from origin (Status: ${metadataRes.status})`, {
              status: 404,
              headers: corsHeaders
            });
          }

          const data = await metadataRes.json();
          const videoTitle = data.title || slug;
          const formattedFilename = formatDownloadFilename(videoTitle, quality);

          let source = data.sources?.find(s => s.label.toLowerCase().includes(quality.toLowerCase()) || s.label.toLowerCase().includes(`${quality}p`));
          if (!source && data.sources?.length > 0) source = data.sources[0];

          if (!source || !source.file) {
            return new Response("No downloadable stream source found", { status: 404, headers: corsHeaders });
          }

          let extractedTargetUrl = "";
          let extractedHost = "vk";
          if (source.file.startsWith("http")) {
            const parsed = new URL(source.file);
            extractedTargetUrl = parsed.searchParams.get("url") || source.file;
            extractedHost = parsed.searchParams.get("host") || "vk";
          } else {
            const fakeBase = "http://localhost";
            const parsed = new URL(source.file, fakeBase);
            extractedTargetUrl = parsed.searchParams.get("url") || "";
            extractedHost = parsed.searchParams.get("host") || "vk";
          }

          return await streamDownloadWithRecovery(request, extractedTargetUrl, extractedHost, formattedFilename, corsHeaders, originAppUrl, slug, quality);
        } catch (e) {
          return new Response(`Download Resolution Error: ${e.message}`, { status: 500, headers: corsHeaders });
        }
      }

      if (!targetUrl) {
        return new Response("Missing target download URL", { status: 400, headers: corsHeaders });
      }

      if (!customFilename) {
        customFilename = formatDownloadFilename("video", quality);
      }

      return await streamDownloadWithRecovery(request, decodeURIComponent(targetUrl), host, customFilename, corsHeaders, originAppUrl, slug, quality);
    }

    const downloadDirectPattern = /^\/api\/download\/([^\/]+)\/([^\/]+)$/;
    const match = pathname.match(downloadDirectPattern);

    if (match) {
      const quality = match[1].replace(/p$/i, '');
      const slug = match[2].replace(/\.mp4$/, "");

      try {
        const metadataUrl = `${originAppUrl}/api/parse-stream?slug=${slug}`;
        const metadataRes = await fetch(metadataUrl, {
          headers: { "Accept": "application/json" }
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

        const videoTitle = data.title || slug;
        const formattedFilename = formatDownloadFilename(videoTitle, quality);

        let source = data.sources.find(s => s.label.toLowerCase().includes(quality.toLowerCase()) || s.label.toLowerCase().includes(`${quality}p`));
        if (!source && data.sources?.length > 0) {
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

        return await streamDownloadWithRecovery(request, decodeURIComponent(targetStreamUrl), hostType, formattedFilename, corsHeaders, originAppUrl, slug, quality);

      } catch (err) {
        return new Response(`Worker Direct Download Error: ${err.message}`, {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

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
      const cronRes = await fetch(`${originAppUrl}/api/cron/refresh-tokens?hours=24&limit=30`, {
        headers: { "Accept": "application/json" }
      });
      const data = await cronRes.json();
      console.log('[Cloudflare Download Worker Cron 24h] Sukses:', data.message);
    } catch (err) {}
  }
};

async function streamDownloadWithRecovery(request, decodedTargetUrl, hostType, filename, corsHeaders, originAppUrl, slug = "", quality = "") {
  const headers = new Headers();
  headers.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );

  if (hostType === "vk" || hostType === "vkvideo") {
    headers.set("Referer", "https://vk.com/");
    headers.set("Origin", "https://vk.com");
  } else if (hostType === "ok" || hostType === "okru") {
    headers.set("Referer", "https://ok.ru/");
    headers.set("Origin", "https://ok.ru");
  } else if (hostType === "sibnet") {
    headers.set("Referer", "https://video.sibnet.ru/");
    headers.set("Origin", "https://video.sibnet.ru");
  }

  const range = request.headers.get("range");
  if (range) headers.set("Range", range);

  try {
    let upstreamResponse = await fetch(decodedTargetUrl, {
      method: request.method,
      headers: headers,
      redirect: "follow",
    });

    if ((upstreamResponse.status === 401 || upstreamResponse.status === 403 || upstreamResponse.status === 404 || upstreamResponse.status === 410) && originAppUrl) {
      try {
        let freshDownloadUrl = "";
        if (slug) {
          const refreshRes = await fetch(`${originAppUrl}/api/parse-stream?slug=${slug}&force=1`, {
            headers: { "Accept": "application/json" }
          });
          if (refreshRes.ok) {
            const freshData = await refreshRes.json();
            let freshSource = null;
            if (quality) freshSource = freshData.sources?.find(s => s.label.toLowerCase().includes(quality.toLowerCase()));
            if (!freshSource && freshData.sources?.length > 0) freshSource = freshData.sources[0];

            if (freshSource && freshSource.file) {
              const fakeBase = "http://localhost";
              const parsedFresh = new URL(freshSource.file, fakeBase);
              freshDownloadUrl = parsedFresh.searchParams.get("url") || freshSource.file;
            }
          }
        }

        if (freshDownloadUrl) {
          upstreamResponse = await fetch(decodeURIComponent(freshDownloadUrl), {
            method: request.method,
            headers: headers,
            redirect: "follow",
          });
        }
      } catch (err) {}
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("Content-Type", "application/octet-stream");
    responseHeaders.set("X-Bypass-Vercel", "1");
    
    const asciiSafeFilename = filename.replace(/[^\x20-\x7E]/g, '_');
    responseHeaders.set("Content-Disposition", `attachment; filename="${asciiSafeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);

    if (upstreamResponse.headers.get("content-length")) responseHeaders.set("Content-Length", upstreamResponse.headers.get("content-length"));
    if (upstreamResponse.headers.get("content-range")) responseHeaders.set("Content-Range", upstreamResponse.headers.get("content-range"));
    if (upstreamResponse.headers.get("etag")) responseHeaders.set("ETag", upstreamResponse.headers.get("etag"));
    if (upstreamResponse.headers.get("last-modified")) responseHeaders.set("Last-Modified", upstreamResponse.headers.get("last-modified"));

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (e) {
    return new Response(`Worker Direct Download Error: ${e.message}`, { status: 500, headers: corsHeaders });
  }
}
