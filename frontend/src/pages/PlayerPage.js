import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { 
  ShieldAlert, RefreshCw, X, AlertCircle, CheckCircle2, 
  Volume2, VolumeX, ExternalLink, SkipForward, Play, Pause, Film 
} from 'lucide-react';
import { parseTimeToSeconds } from './VastAdsPage';
import { resolveWaterfallVastAd, fireBeacon } from '../lib/vastParser';

function formatSeconds(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export default function PlayerPage() {
  const { slug } = useParams();
  const [loading, setLoading] = useState(true);
  const [videoData, setVideoData] = useState(null);
  const [playerSettings, setPlayerSettings] = useState({
    playerType: 'jwplayer',
    autoplay: true,
    vastEnabled: false,
    vastTags: [],
    isAdblockEnabled: false,
  });
  const [cdnUrl, setCdnUrl] = useState('');
  const [error, setError] = useState(null);

  // References and Player states
  const jwContainerRef = useRef(null);
  const [jwScriptLoaded, setJwScriptLoaded] = useState(false);
  const jwPlayerInstanceRef = useRef(null);
  const initializedRef = useRef(false);

  const [sources, setSources] = useState([]);
  const [subtitles, setSubtitles] = useState([]);

  // AdBlock Detector State
  const [isAdblockDetected, setIsAdblockDetected] = useState(false);

  // Recovery State
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState(null);
  const [recoverySuccess, setRecoverySuccess] = useState(false);
  const lastPlaybackTimeRef = useRef(0);
  const isRecoveringRef = useRef(false);
  const recoveryAttemptsRef = useRef(0);

  // VAST Ads State
  const [activeVastAd, setActiveVastAd] = useState(null);
  const [currentAdMediaSrc, setCurrentAdMediaSrc] = useState('');
  const [vastAdState, setVastAdState] = useState('idle');
  const [adTimeRemaining, setAdTimeRemaining] = useState(45);
  const [adSkipCountdown, setAdSkipCountdown] = useState(30);
  const [canSkipAd, setCanSkipAd] = useState(false);
  const [adMuted, setAdMuted] = useState(false);
  const vastVideoRef = useRef(null);
  const playedVastAdIdsRef = useRef(new Set());
  const trackedVastEventsRef = useRef(new Set());
  const isAdActiveRef = useRef(false);

  // Skip Opening Anime State
  const [showSkipOpening, setShowSkipOpening] = useState(false);
  const [userDismissedSkip, setUserDismissedSkip] = useState(false);
  const dismissedSkipRef = useRef(false);

  // Load Video Metadata & Settings
  useEffect(() => {
    async function fetchVideo() {
      try {
        const [streamRes, settingsRes] = await Promise.all([
          fetch(`/api/parse-stream?slug=${slug}`),
          fetch('/api/settings')
        ]);

        if (streamRes.ok) {
          const streamData = await streamRes.json();
          setVideoData(streamData);
          setSources(streamData.sources || []);
          setSubtitles(streamData.subtitles || []);
        } else {
          setError('Video tidak ditemukan di database.');
        }

        if (settingsRes.ok) {
          const settData = await settingsRes.json();
          if (settData.player) {
            setPlayerSettings(settData.player);
            if (settData.player.vastEnabled) {
              setVastAdState('loading');
              isAdActiveRef.current = true;
            }
          }
          if (settData.general?.cdnUrl) {
            setCdnUrl(settData.general.cdnUrl.replace(/\/+$/, ''));
          }
        }
      } catch (err) {
        setError('Gagal memuat player video.');
      } finally {
        setLoading(false);
      }
    }
    if (slug) {
      fetchVideo();
    }
  }, [slug]);

  // Load JWPlayer Library
  useEffect(() => {
    if (window.jwplayer) {
      setJwScriptLoaded(true);
      return;
    }
    const script = document.createElement('script');
    script.id = 'jwplayer-script';
    script.src = 'https://content.jwplatform.com/libraries/IDzF9Zmk.js';
    script.async = true;
    script.onload = () => setJwScriptLoaded(true);
    script.onerror = () => {
      console.warn('Backup JWPlayer loader...');
      setJwScriptLoaded(true);
    };
    document.body.appendChild(script);
  }, []);

  // Multi-layer AdBlock Checker
  const runAdblockCheck = useCallback(async () => {
    if (!playerSettings.isAdblockEnabled) {
      setIsAdblockDetected(false);
      return;
    }
    let detected = false;
    try {
      const bait = document.createElement('div');
      bait.className = 'adsbox ad-banner pub_300x250 pub_728x90 text-ad textAd text_ad text-ads';
      bait.style.cssText = 'position:absolute !important;top:-9999px !important;left:-9999px !important;width:1px !important;height:1px !important;pointer-events:none !important;';
      document.body.appendChild(bait);
      await new Promise(r => setTimeout(r, 100));
      const style = window.getComputedStyle(bait);
      if (style.display === 'none' || style.visibility === 'hidden' || bait.offsetHeight === 0) {
        detected = true;
      }
      bait.remove();
    } catch (e) {}

    if (detected) {
      setIsAdblockDetected(true);
      try { jwPlayerInstanceRef.current?.pause(); } catch (e) {}
    } else {
      setIsAdblockDetected(false);
    }
  }, [playerSettings.isAdblockEnabled]);

  useEffect(() => {
    if (playerSettings.isAdblockEnabled) {
      runAdblockCheck();
      const interval = setInterval(runAdblockCheck, 4000);
      return () => clearInterval(interval);
    }
  }, [playerSettings.isAdblockEnabled, runAdblockCheck]);

  const getCdnStreamUrl = useCallback((sourceFile) => {
    if (!sourceFile) return '';
    if (sourceFile.startsWith('http://') || sourceFile.startsWith('https://')) return sourceFile;
    if (cdnUrl) return `${cdnUrl}${sourceFile.startsWith('/') ? '' : '/'}${sourceFile}`;
    if (typeof window !== 'undefined') {
      return `${window.location.origin}${sourceFile.startsWith('/') ? '' : '/'}${sourceFile}`;
    }
    return sourceFile;
  }, [cdnUrl]);

  const formatSubtitleUrl = useCallback((fileUrl) => {
    if (!fileUrl) return '';
    if (fileUrl.startsWith('/api/')) return cdnUrl ? `${cdnUrl}${fileUrl}` : fileUrl;
    const subPath = `/api/subtitle?url=${encodeURIComponent(fileUrl)}`;
    return cdnUrl ? `${cdnUrl}${subPath}` : subPath;
  }, [cdnUrl]);

  // Add seek buttons (+10s / -10s) to JWPlayer
  const attachJwSeekButtons = useCallback((player) => {
    const rewindSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon></svg>`;
    const forwardSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 5 2 19"></polygon></svg>`;

    try {
      player.addButton(rewindSvg, 'Mundur 10 Detik (-10s)', () => {
        const current = player.getPosition();
        player.seek(Math.max(0, current - 10));
      }, 'jw-btn-rewind-10');

      player.addButton(forwardSvg, 'Maju 10 Detik (+10s)', () => {
        const current = player.getPosition();
        const duration = player.getDuration();
        player.seek(Math.min(duration, current + 10));
      }, 'jw-btn-forward-10');
    } catch (e) {}
  }, []);

  // Live Auto Token Recovery
  const recoverExpiredToken = useCallback(async (reason = 'error') => {
    if (isRecoveringRef.current || recoveryAttemptsRef.current >= 4) return;
    isRecoveringRef.current = true;
    setIsRecovering(true);
    setRecoverySuccess(false);
    recoveryAttemptsRef.current += 1;

    let currentPos = 0;
    try {
      if (jwPlayerInstanceRef.current) {
        currentPos = Number(jwPlayerInstanceRef.current.getPosition?.()) || 0;
      }
    } catch (e) {}
    if (currentPos <= 0 && lastPlaybackTimeRef.current > 0) {
      currentPos = lastPlaybackTimeRef.current;
    }
    lastPlaybackTimeRef.current = currentPos;

    setRecoveryMessage('Mendeteksi token expired. Menyegarkan stream otomatis...');

    try {
      const res = await fetch(`/api/parse-stream?slug=${slug}&force=1&t=${Date.now()}`);
      if (!res.ok) throw new Error('Recovery stream failed');
      const freshData = await res.json();

      setVideoData(freshData);
      setSources(freshData.sources || []);
      if (freshData.subtitles) setSubtitles(freshData.subtitles);

      const freshJwSources = (freshData.sources || []).map(s => ({
        file: getCdnStreamUrl(s.file),
        label: s.label || 'Default',
        type: s.type || 'video/mp4'
      }));

      if (window.jwplayer && jwContainerRef.current) {
        if (jwPlayerInstanceRef.current) {
          try { jwPlayerInstanceRef.current.remove(); } catch (e) {}
        }

        const player = window.jwplayer(jwContainerRef.current).setup({
          playlist: [{
            title: freshData.title || videoData?.title,
            image: freshData.posterUrl || videoData?.posterUrl,
            sources: freshJwSources,
            tracks: (freshData.subtitles || subtitles || []).map((sub, idx) => ({
              file: formatSubtitleUrl(sub.file),
              label: sub.label || `Subtitle ${idx + 1}`,
              kind: 'captions',
              default: idx === 0
            }))
          }],
          autostart: true,
          mute: false,
          volume: 100,
          width: '100%',
          height: '100%',
          controls: true,
          displaytitle: true,
          stretching: 'uniform',
        });

        jwPlayerInstanceRef.current = player;
        attachJwSeekButtons(player);

        player.on('ready', () => {
          if (currentPos > 0) {
            try { player.seek(currentPos); } catch (e) {}
          }
          player.play();
          recoveryAttemptsRef.current = 0;
        });

        player.on('complete', () => {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ event: 'SHINDORA_VIDEO_ENDED' }, '*');
          }
        });
      }

      setRecoverySuccess(true);
      setRecoveryMessage('Stream berhasil diperbarui! Melanjutkan pemutaran...');
      setTimeout(() => {
        setIsRecovering(false);
        setRecoveryMessage(null);
        isRecoveringRef.current = false;
      }, 2500);
    } catch (e) {
      setRecoverySuccess(false);
      setRecoveryMessage('Gagal memperbarui stream.');
      setTimeout(() => {
        setIsRecovering(false);
        isRecoveringRef.current = false;
      }, 4000);
    }
  }, [slug, videoData, subtitles, getCdnStreamUrl, formatSubtitleUrl, attachJwSeekButtons]);

  // VAST Ad Trigger
  const triggerVastAd = useCallback(async (tagItem) => {
    if (!tagItem || !tagItem.tagUrl || playedVastAdIdsRef.current.has(tagItem.id)) return;
    playedVastAdIdsRef.current.add(tagItem.id);
    isAdActiveRef.current = true;
    setVastAdState('loading');

    try {
      if (jwPlayerInstanceRef.current) {
        jwPlayerInstanceRef.current.pause();
        jwPlayerInstanceRef.current.setMute(true);
      }
    } catch (e) {}

    try {
      const resolved = await resolveWaterfallVastAd(tagItem.tagUrl, tagItem.fallbackTags, '/api/vast-proxy');
      if (!resolved || !resolved.bestMediaFile?.src) throw new Error('No playable media in VAST XML');

      setActiveVastAd(resolved);
      setCurrentAdMediaSrc(resolved.bestMediaFile.src);
      setVastAdState('playing');

      const dur = resolved.duration > 0 ? resolved.duration : 15;
      const skipSec = Math.min(tagItem.skipOffsetSeconds || resolved.skipOffset || 5, dur);
      setAdTimeRemaining(dur);
      setAdSkipCountdown(skipSec);
      setCanSkipAd(skipSec <= 0);

      (resolved.impressionUrls || []).forEach(u => fireBeacon(u));
    } catch (e) {
      isAdActiveRef.current = false;
      setVastAdState('idle');
      setActiveVastAd(null);
      try {
        jwPlayerInstanceRef.current?.setMute(false);
        jwPlayerInstanceRef.current?.play();
      } catch (err) {}
    }
  }, []);

  const handleSkipVastAd = useCallback(() => {
    isAdActiveRef.current = false;
    if (activeVastAd) {
      (activeVastAd.trackingEvents?.skip || []).forEach(u => fireBeacon(u));
    }
    setActiveVastAd(null);
    setVastAdState('idle');
    try {
      jwPlayerInstanceRef.current?.setMute(false);
      jwPlayerInstanceRef.current?.play();
    } catch (e) {}
  }, [activeVastAd]);

  const handleVastEnded = useCallback(() => {
    isAdActiveRef.current = false;
    if (activeVastAd) {
      (activeVastAd.trackingEvents?.complete || []).forEach(u => fireBeacon(u));
    }
    setActiveVastAd(null);
    setVastAdState('idle');
    try {
      jwPlayerInstanceRef.current?.setMute(false);
      jwPlayerInstanceRef.current?.play();
    } catch (e) {}
  }, [activeVastAd]);

  // VAST Countdown
  useEffect(() => {
    if (vastAdState === 'idle') return;
    const dur = activeVastAd?.duration || 15;
    const skip = Math.min(activeVastAd?.skipOffset || 5, dur);

    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remSkip = Math.max(0, skip - elapsed);
      const remTot = Math.max(0, dur - elapsed);

      setAdSkipCountdown(remSkip);
      setAdTimeRemaining(remTot);
      if (remSkip <= 0) setCanSkipAd(true);
      if (remTot <= 0) handleVastEnded();
    }, 500);

    return () => clearInterval(interval);
  }, [vastAdState, activeVastAd, handleVastEnded]);

  // Setup JW Player Main Instance
  useEffect(() => {
    if (initializedRef.current || !jwScriptLoaded || sources.length === 0) return;

    if (window.jwplayer && jwContainerRef.current) {
      try {
        const jwSources = sources.map(s => ({
          file: getCdnStreamUrl(s.file),
          label: s.label || 'Default',
          type: s.type || 'video/mp4'
        }));

        const player = window.jwplayer(jwContainerRef.current).setup({
          playlist: [{
            title: videoData?.title,
            image: videoData?.posterUrl,
            sources: jwSources,
            tracks: subtitles.map((sub, idx) => ({
              file: formatSubtitleUrl(sub.file),
              label: sub.label || `Subtitle ${idx + 1}`,
              kind: 'captions',
              default: idx === 0
            }))
          }],
          autostart: false,
          mute: false,
          volume: 100,
          width: '100%',
          height: '100%',
          controls: true,
          displaytitle: true,
          stretching: 'uniform',
        });

        jwPlayerInstanceRef.current = player;
        initializedRef.current = true;
        attachJwSeekButtons(player);

        player.on('ready', () => {
          if (playerSettings.autoplay && !isAdActiveRef.current) {
            const playPromise = player.play();
            if (playPromise !== undefined) {
              playPromise.catch(() => {
                player.setMute(true);
                player.play();
              });
            }
          }
        });

        player.on('complete', () => {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ event: 'SHINDORA_VIDEO_ENDED' }, '*');
          }
        });

        player.on('error', () => {
          recoverExpiredToken('jw_error');
        });

        player.on('time', (e) => {
          lastPlaybackTimeRef.current = Math.floor(e.position);
          const currentSec = Math.floor(e.position);

          // Skip Anime Opening Check
          const title = (videoData?.title || '').toLowerCase();
          const isAnime = title.includes('doraemon') || title.includes('shin-chan') || title.includes('shinchan');
          const isOpeningTime = isAnime && currentSec >= 0 && currentSec < 60;
          setShowSkipOpening(isOpeningTime);
        });

      } catch (e) {}
    }
  }, [jwScriptLoaded, sources, subtitles, videoData, playerSettings, getCdnStreamUrl, formatSubtitleUrl, attachJwSeekButtons, recoverExpiredToken]);

  // Preroll VAST trigger on mount
  useEffect(() => {
    if (playerSettings.vastEnabled && playerSettings.vastTags?.length > 0) {
      const preroll = playerSettings.vastTags.find(t => t.enabled && (t.offset === 'pre' || t.timeInSeconds === 0)) || playerSettings.vastTags[0];
      if (preroll) {
        triggerVastAd(preroll);
      }
    }
  }, [playerSettings, triggerVastAd]);

  if (loading) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center text-white">
        <Film className="h-8 w-8 text-primary animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center text-white p-6 text-center">
        <div>
          <h1 className="text-xl font-bold">Video Tidak Ditemukan</h1>
          <p className="text-zinc-400 text-xs mt-2">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="w-screen h-screen relative bg-black overflow-hidden m-0 p-0 flex items-center justify-center select-none"
      data-testid="player-main-container"
    >
      <style dangerouslySetInnerHTML={{__html: `
        #jwplayer-container {
          width: 100vw !important;
          height: 100vh !important;
          position: absolute !important;
          inset: 0 !important;
        }
        .jw-btn-rewind-10, .jw-btn-forward-10 {
          width: 32px !important;
          height: 32px !important;
          border-radius: 50% !important;
          background: rgba(255, 255, 255, 0.2) !important;
          margin: 0 3px !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          cursor: pointer !important;
        }
        .jw-btn-rewind-10 svg, .jw-btn-forward-10 svg {
          width: 18px !important;
          height: 18px !important;
          stroke: #ffffff !important;
        }
      `}} />

      <div className="w-full h-full relative">
        <div ref={jwContainerRef} id="jwplayer-container" data-testid="jwplayer-container" className="w-full h-full" />

        {/* AdBlock Modal Warning */}
        {playerSettings.isAdblockEnabled && isAdblockDetected && (
          <div data-testid="adblock-warning-overlay" className="absolute inset-0 z-[100] bg-black/95 backdrop-blur-xl flex items-center justify-center p-4 text-center">
            <div className="max-w-md w-full bg-zinc-900 border border-red-500/40 rounded-3xl p-6 space-y-4 shadow-2xl">
              <div className="h-14 w-14 mx-auto rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-500">
                <ShieldAlert className="h-8 w-8 animate-pulse" />
              </div>
              <h2 className="text-xl font-bold text-white">AdBlock Terdeteksi!</h2>
              <p className="text-xs text-zinc-300">
                Mohon nonaktifkan pemblokir iklan (AdBlock / uBlock) Anda untuk memutar video ini.
              </p>
              <button
                type="button"
                data-testid="adblock-reload-btn"
                onClick={() => window.location.reload()}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-bold text-xs py-3 rounded-xl flex items-center justify-center gap-2 cursor-pointer"
              >
                <RefreshCw className="h-4 w-4" /> Muat Ulang Halaman
              </button>
            </div>
          </div>
        )}

        {/* VAST Video Overlay */}
        {(vastAdState === 'loading' || vastAdState === 'playing') && (
          <div data-testid="vast-ad-overlay" className="absolute inset-0 z-[80] bg-black flex items-center justify-center select-none">
            <video
              ref={vastVideoRef}
              data-testid="vast-ad-video"
              src={currentAdMediaSrc}
              className="w-full h-full object-contain cursor-pointer"
              playsInline
              autoPlay
              muted={adMuted}
              onClick={() => {
                if (activeVastAd?.clickThroughUrl) {
                  window.open(activeVastAd.clickThroughUrl, '_blank', 'noopener,noreferrer');
                }
              }}
            />

            <div className="absolute top-4 left-4 right-4 z-[90] flex items-center justify-between pointer-events-auto">
              <div className="flex items-center gap-2 bg-black/80 border border-amber-500/50 rounded-full px-3 py-1">
                <span className="bg-amber-400 text-black font-black text-[10px] px-1.5 py-0.5 rounded">IKLAN</span>
                <span className="text-white text-xs font-semibold">{activeVastAd?.title || 'Sponsor Ad'} · {formatSeconds(adTimeRemaining)}</span>
              </div>
            </div>

            <div className="absolute bottom-6 left-4 right-4 z-[90] flex items-center justify-between pointer-events-auto">
              <button
                type="button"
                data-testid="vast-ad-mute-btn"
                onClick={() => setAdMuted(!adMuted)}
                className="flex items-center gap-1.5 bg-black/80 text-white text-xs px-3 py-1.5 rounded-lg border border-white/30 cursor-pointer"
              >
                {adMuted ? <VolumeX className="h-4 w-4 text-red-400" /> : <Volume2 className="h-4 w-4 text-emerald-400" />}
                <span>{adMuted ? 'Buka Suara' : 'Bisukan'}</span>
              </button>

              {canSkipAd ? (
                <button
                  type="button"
                  data-testid="vast-ad-skip-btn"
                  onClick={handleSkipVastAd}
                  className="flex items-center gap-1.5 bg-amber-400 hover:bg-amber-300 text-black font-extrabold text-xs px-4 py-2 rounded-xl shadow-xl cursor-pointer"
                >
                  <span>Lewati Iklan</span>
                  <SkipForward className="h-4 w-4 fill-black" />
                </button>
              ) : (
                <div data-testid="vast-ad-countdown-badge" className="bg-black/80 text-zinc-200 text-xs font-semibold px-3 py-1.5 rounded-xl border border-white/30">
                  <span>Lewati iklan dalam </span>
                  <span className="text-amber-400 font-bold">{adSkipCountdown}s</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Floating Token Recovery Badge */}
        {recoveryMessage && (
          <div data-testid="token-recovery-badge" className="absolute top-4 left-1/2 -translate-x-1/2 z-[70]">
            <div className={`px-4 py-2 rounded-full shadow-2xl backdrop-blur-md flex items-center gap-2 text-xs font-semibold border ${
              recoverySuccess ? 'bg-emerald-950/90 text-emerald-200 border-emerald-500/50' : 'bg-zinc-900/95 text-amber-300 border-amber-500/50'
            }`}>
              {isRecovering ? <RefreshCw className="h-3.5 w-3.5 animate-spin text-amber-400" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
              <span>{recoveryMessage}</span>
            </div>
          </div>
        )}

        {/* Skip Opening Anime Button */}
        {showSkipOpening && !userDismissedSkip && vastAdState === 'idle' && (
          <div className="absolute right-4 bottom-16 z-[60] flex items-center gap-2 p-1.5 bg-black/85 backdrop-blur-md border border-white/30 rounded-2xl shadow-2xl">
            <button
              type="button"
              data-testid="skip-opening-btn"
              onClick={() => {
                jwPlayerInstanceRef.current?.seek(60);
                setShowSkipOpening(false);
              }}
              className="flex items-center gap-1.5 rounded-xl bg-white hover:bg-zinc-100 text-black px-3.5 py-2 text-xs font-extrabold cursor-pointer"
            >
              <span>⏭ Skip Opening (01:00)</span>
            </button>
            <button
              type="button"
              data-testid="no-skip-opening-btn"
              onClick={() => {
                setUserDismissedSkip(true);
                setShowSkipOpening(false);
              }}
              className="flex items-center gap-1 rounded-xl bg-white/15 hover:bg-white/25 text-white px-2.5 py-2 text-xs font-semibold cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
              <span>Tidak Skip</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
