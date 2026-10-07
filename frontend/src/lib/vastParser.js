/**
 * SHINDORA VAST / VMAP ENGINE & PARSER
 * Full support for VAST 2.0, 3.0, 4.0, 4.1, 4.2 & VMAP feeds
 */

export function parseDurationToSeconds(durationStr) {
  if (!durationStr) return 0;
  const str = String(durationStr).trim();
  if (/^\d+(\.\d+)?$/.test(str)) {
    return Math.floor(parseFloat(str));
  }
  const parts = str.split(':').map(p => parseFloat(p) || 0);
  if (parts.length === 3) {
    return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  } else if (parts.length === 2) {
    return Math.floor(parts[0] * 60 + parts[1]);
  }
  return 0;
}

export function parseSkipOffsetToSeconds(skipOffsetStr, adDurationSec = 0) {
  if (!skipOffsetStr) return 30;
  const str = String(skipOffsetStr).trim();
  if (str.endsWith('%')) {
    const pct = parseFloat(str.replace('%', '')) || 0;
    return Math.max(0, Math.floor((pct / 100) * (adDurationSec || 45)));
  }
  const parsed = parseDurationToSeconds(str);
  return parsed > 0 ? parsed : 30;
}

export function replaceVastMacros(url, { errorCode = 0, contentPlayhead = '00:00:00' } = {}) {
  if (!url) return '';
  const timestamp = Date.now().toString();
  const randomNum = Math.floor(Math.random() * 1000000000).toString();
  
  return url
    .replace(/\[TIMESTAMP\]/gi, timestamp)
    .replace(/\[CACHEBUSTING\]/gi, randomNum)
    .replace(/\[RANDOM\]/gi, randomNum)
    .replace(/\[ERRORCODE\]/gi, String(errorCode))
    .replace(/%%CACHEBUSTER%%/gi, randomNum)
    .replace(/\[CONTENTPLAYHEAD\]/gi, contentPlayhead);
}

export function fireBeacon(url, options = {}) {
  if (!url) return;
  const finalUrl = replaceVastMacros(url, options);
  
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon(finalUrl);
      if (sent) return;
    }
  } catch (e) {}

  try {
    if (typeof window !== 'undefined') {
      const img = new Image();
      img.src = finalUrl;
      return;
    }
  } catch (e) {}

  try {
    fetch(finalUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store' }).catch(() => {});
  } catch (e) {}
}

export function parseVastXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    return { success: false, error: 'Empty XML string', ads: [] };
  }

  const cleanXml = xmlString.replace(/xmlns(:\w+)?="[^"]+"/g, '');
  let ads = [];

  const isVmap = /<vmap:VMAP|<VMAP/i.test(xmlString);
  if (isVmap) {
    const vmapTags = cleanXml.match(/<VASTAdTagURI[^>]*>([\s\S]*?)<\/VASTAdTagURI>/gi) || [];
    for (const vTag of vmapTags) {
      const cdata = vTag.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
      const raw = vTag.replace(/<[^>]+>/g, '').trim();
      const uri = (cdata ? cdata[1] : raw).trim();
      if (uri) {
        ads.push({
          id: `vmap_${Math.random().toString(36).substring(2, 8)}`,
          title: 'VMAP Ad Break',
          isWrapper: true,
          wrapperUrl: uri,
          duration: 15,
          durationFormatted: '00:00:15',
          skipOffset: 30,
          clickThroughUrl: '',
          clickTrackingUrls: [],
          impressionUrls: [],
          errorUrls: [],
          trackingEvents: {},
          mediaFiles: [],
          bestMediaFile: null,
        });
      }
    }
  }

  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(cleanXml, 'text/xml');
      const adElements = doc.querySelectorAll('Ad');

      adElements.forEach((adNode) => {
        const adId = adNode.getAttribute('id') || `ad_${Math.random().toString(36).substring(2, 8)}`;
        const titleNode = adNode.querySelector('AdTitle');
        const title = titleNode?.textContent?.trim() || 'Video Ad';

        const wrapperTagNode = adNode.querySelector('VASTAdTagURI');
        const wrapperUrl = wrapperTagNode?.textContent?.trim() || '';

        const impressions = Array.from(adNode.querySelectorAll('Impression'))
          .map(i => i.textContent?.trim())
          .filter(Boolean);

        const errors = Array.from(adNode.querySelectorAll('Error'))
          .map(e => e.textContent?.trim())
          .filter(Boolean);

        const linearNode = adNode.querySelector('Linear');
        if (linearNode || wrapperUrl) {
          const durationNode = linearNode?.querySelector('Duration');
          const durationStr = durationNode?.textContent?.trim() || '00:00:15';
          const durationSec = parseDurationToSeconds(durationStr);

          const skipOffsetAttr = linearNode?.getAttribute('skipoffset') || linearNode?.querySelector('skipoffset')?.textContent?.trim();
          const skipOffsetSec = parseSkipOffsetToSeconds(skipOffsetAttr, durationSec);

          const clickThroughNode = linearNode?.querySelector('ClickThrough');
          const clickThroughUrl = clickThroughNode?.textContent?.trim() || '';

          const clickTrackingUrls = Array.from(linearNode?.querySelectorAll('ClickTracking') || [])
            .map(c => c.textContent?.trim())
            .filter(Boolean);

          const trackingEvents = {};
          (linearNode?.querySelectorAll('Tracking') || []).forEach(tr => {
            const eventType = tr.getAttribute('event');
            const trUrl = tr.textContent?.trim();
            if (eventType && trUrl) {
              if (!trackingEvents[eventType]) trackingEvents[eventType] = [];
              trackingEvents[eventType].push(trUrl);
            }
          });

          const mediaFiles = Array.from(linearNode?.querySelectorAll('MediaFile') || [])
            .map(mf => ({
              src: mf.textContent?.trim() || '',
              type: (mf.getAttribute('type') || 'video/mp4').toLowerCase(),
              delivery: mf.getAttribute('delivery') || 'progressive',
              width: parseInt(mf.getAttribute('width'), 10) || 640,
              height: parseInt(mf.getAttribute('height'), 10) || 360,
              bitrate: parseInt(mf.getAttribute('bitrate'), 10) || 0,
            }))
            .filter(mf => mf.src && (mf.src.startsWith('http://') || mf.src.startsWith('https://') || mf.src.startsWith('//')));

          mediaFiles.sort((a, b) => {
            const aIsMp4 = a.type.includes('mp4') ? 1 : 0;
            const bIsMp4 = b.type.includes('mp4') ? 1 : 0;
            if (aIsMp4 !== bIsMp4) return bIsMp4 - aIsMp4;
            return (b.height * b.width) - (a.height * a.width);
          });

          ads.push({
            id: adId,
            title,
            isWrapper: !!wrapperUrl,
            wrapperUrl,
            duration: durationSec > 0 ? durationSec : 15,
            durationFormatted: durationStr,
            skipOffset: skipOffsetSec,
            clickThroughUrl,
            clickTrackingUrls,
            impressionUrls: impressions,
            errorUrls: errors,
            trackingEvents,
            mediaFiles,
            bestMediaFile: mediaFiles[0] || null,
          });
        }
      });

      if (ads.length > 0) {
        return { success: true, ads };
      }
    } catch (domErr) {}
  }

  // Regex Fallback
  try {
    const adMatches = cleanXml.match(/<Ad[\s\S]*?<\/Ad>/gi) || [];

    for (const adChunk of adMatches) {
      const idMatch = adChunk.match(/<Ad[^>]*id=["']([^"']+)["']/i);
      const adId = idMatch ? idMatch[1] : `ad_${Math.random().toString(36).substring(2, 8)}`;

      const titleMatch = adChunk.match(/<AdTitle>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/AdTitle>/i) || adChunk.match(/<AdTitle>([\s\S]*?)<\/AdTitle>/i);
      const title = (titleMatch ? titleMatch[1] : 'Video Ad').trim();

      const wrapperMatch = adChunk.match(/<VASTAdTagURI>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/VASTAdTagURI>/i) || adChunk.match(/<VASTAdTagURI>([\s\S]*?)<\/VASTAdTagURI>/i);
      const wrapperUrl = (wrapperMatch ? wrapperMatch[1] : '').trim();

      const durationMatch = adChunk.match(/<Duration>([\s\S]*?)<\/Duration>/i);
      const durationStr = (durationMatch ? durationMatch[1] : '00:00:15').trim();
      const durationSec = parseDurationToSeconds(durationStr);

      const skipMatch = adChunk.match(/skipoffset=["']([^"']+)["']/i) || adChunk.match(/<skipoffset>([\s\S]*?)<\/skipoffset>/i);
      const skipOffsetStr = skipMatch ? skipMatch[1].trim() : '00:00:30';
      const skipOffsetSec = parseSkipOffsetToSeconds(skipOffsetStr, durationSec);

      const clickMatch = adChunk.match(/<ClickThrough[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/ClickThrough>/i) || adChunk.match(/<ClickThrough>([\s\S]*?)<\/ClickThrough>/i);
      const clickThroughUrl = (clickMatch ? clickMatch[1] : '').trim();

      const mediaFiles = [];
      const mfMatches = adChunk.match(/<MediaFile[\s\S]*?<\/MediaFile>/gi) || [];
      mfMatches.forEach(mf => {
        const cdata = mf.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
        const raw = mf.replace(/<[^>]+>/g, '').trim();
        const src = (cdata ? cdata[1] : raw).trim();

        if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))) {
          mediaFiles.push({
            src: src.startsWith('//') ? `https:${src}` : src,
            type: 'video/mp4',
            delivery: 'progressive',
            width: 640,
            height: 360,
            bitrate: 0,
          });
        }
      });

      ads.push({
        id: adId,
        title,
        isWrapper: !!wrapperUrl,
        wrapperUrl,
        duration: durationSec > 0 ? durationSec : 15,
        durationFormatted: durationStr,
        skipOffset: skipOffsetSec,
        clickThroughUrl,
        clickTrackingUrls: [],
        impressionUrls: [],
        errorUrls: [],
        trackingEvents: {},
        mediaFiles,
        bestMediaFile: mediaFiles[0] || null,
      });
    }

    return { success: ads.length > 0, ads };
  } catch (err) {
    return { success: false, error: err.message, ads: [] };
  }
}

export async function fetchAndResolveVastTag(tagUrl, maxDepth = 4, proxyBaseUrl = '/api/vast-proxy') {
  if (!tagUrl || !tagUrl.trim()) {
    throw new Error('VAST Tag URL is empty');
  }

  const cleanUrl = tagUrl.trim();
  let currentUrl = cleanUrl;
  let wrapperHistory = [];
  let accumulatedImpressions = [];
  let accumulatedErrors = [];
  let accumulatedTrackingEvents = {};

  for (let depth = 0; depth < maxDepth; depth++) {
    let xmlText = '';

    try {
      const proxyUrl = `${proxyBaseUrl}?url=${encodeURIComponent(currentUrl)}`;
      const res = await fetch(proxyUrl, {
        headers: { 'Accept': 'application/xml, text/xml, */*' },
        cache: 'no-store'
      });
      if (res.ok) {
        xmlText = await res.text();
      }
    } catch (proxyErr) {}

    if (!xmlText || (!xmlText.includes('<VAST') && !xmlText.includes('<vmap:VMAP') && !xmlText.includes('<VMAP'))) {
      try {
        const res = await fetch(currentUrl, {
          headers: { 'Accept': 'application/xml, text/xml, */*' },
          cache: 'no-store'
        });
        if (res.ok) {
          xmlText = await res.text();
        }
      } catch (fetchErr) {}
    }

    if (!xmlText || (!xmlText.includes('<VAST') && !xmlText.includes('<vmap:VMAP') && !xmlText.includes('<VMAP'))) {
      throw new Error('Response is not a valid VAST/VMAP XML document');
    }

    const parsed = parseVastXml(xmlText);
    if (!parsed.success || parsed.ads.length === 0) {
      throw new Error('No valid ads found in VAST XML feed');
    }

    const firstAd = parsed.ads[0];

    accumulatedImpressions.push(...(firstAd.impressionUrls || []));
    accumulatedErrors.push(...(firstAd.errorUrls || []));

    Object.keys(firstAd.trackingEvents || {}).forEach(ev => {
      if (!accumulatedTrackingEvents[ev]) accumulatedTrackingEvents[ev] = [];
      accumulatedTrackingEvents[ev].push(...firstAd.trackingEvents[ev]);
    });

    if (firstAd.isWrapper && firstAd.wrapperUrl) {
      wrapperHistory.push(currentUrl);
      currentUrl = firstAd.wrapperUrl;
      continue;
    }

    if (firstAd.bestMediaFile) {
      return {
        ...firstAd,
        sourceTagUrl: cleanUrl,
        impressionUrls: Array.from(new Set(accumulatedImpressions)),
        errorUrls: Array.from(new Set(accumulatedErrors)),
        trackingEvents: accumulatedTrackingEvents,
        wrapperHistory,
      };
    }
  }

  throw new Error('VAST resolution exceeded maximum wrapper depth without finding media file');
}

export async function resolveWaterfallVastAd(primaryTagUrl, fallbackTags = [], proxyBaseUrl = '/api/vast-proxy') {
  const allTags = [primaryTagUrl, ...(Array.isArray(fallbackTags) ? fallbackTags : [])]
    .map(t => (t || '').trim())
    .filter(Boolean);

  if (allTags.length === 0) {
    throw new Error('No VAST tags configured for Waterfall resolution');
  }

  let lastError = null;

  for (let i = 0; i < allTags.length; i++) {
    const tag = allTags[i];
    try {
      const ad = await fetchAndResolveVastTag(tag, 4, proxyBaseUrl);
      if (ad && ad.bestMediaFile && ad.bestMediaFile.src) {
        return {
          ...ad,
          waterfallIndex: i,
          isFallback: i > 0,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('All VAST waterfall tags failed to return playable media');
}
