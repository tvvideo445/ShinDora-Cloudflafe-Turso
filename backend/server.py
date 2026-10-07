import os
import re
import json
import uuid
import hmac
import hashlib
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from urllib.parse import quote, unquote, urlparse, parse_qs

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Request, Response, HTTPException, Query, Path as FPath, Body, Depends
from fastapi.responses import JSONResponse, Response as RawResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import httpx
from bs4 import BeautifulSoup
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------------------
# MongoDB Database Setup
# ---------------------------------------------------------------------------
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="ShinDora Stream API")

# Add CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition", "Content-Type", "X-Token-Recovered", "X-Bypass-Vercel"],
)

# ---------------------------------------------------------------------------
# Helper Utilities
# ---------------------------------------------------------------------------
def generate_uuid() -> str:
    return str(uuid.uuid4())

def clean_vk_url(url_str: str) -> str:
    if not url_str:
        return ""
    return (
        url_str.replace("\\/_", "_")
        .replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("\\x26", "&")
    )

def clean_ok_url(url_str: str) -> str:
    if not url_str:
        return ""
    return unquote(url_str).replace("\\/", "/")

def convert_srt_to_vtt(srt_text: str) -> str:
    if not srt_text:
        return "WEBVTT\n\n"
    if srt_text.strip().startswith("WEBVTT"):
        return srt_text
    normalized = srt_text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", normalized)
    return f"WEBVTT\n\n{normalized.strip()}\n"

def format_download_filename(title: str, quality: str) -> str:
    clean_quality = str(quality or "720").lower().rstrip("p") + "p"
    clean_title = (title or "video").strip()
    clean_title = re.sub(r"\.mp4$", "", clean_title, flags=re.IGNORECASE).strip()
    clean_title = re.sub(r'[\\/:*?"<>|]', " ", clean_title)
    clean_title = re.sub(r"\s+", " ", clean_title).strip()
    if not clean_title:
        clean_title = "video"
    return f"{clean_title} ({clean_quality}).mp4"

# ---------------------------------------------------------------------------
# Startup Seeding & Schema Setup
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_db_init():
    # Seed default admin account if not existing
    admin_setting = await db.settings.find_one({"type": "admin"})
    if not admin_setting:
        await db.settings.insert_one({
            "id": generate_uuid(),
            "type": "admin",
            "username": os.environ.get("ADMIN_USERNAME", "admin"),
            "password": os.environ.get("ADMIN_PASSWORD", "admin123"),
            "createdAt": datetime.now(timezone.utc).isoformat()
        })
    
    # Seed default general settings if not existing
    general_setting = await db.settings.find_one({"type": "general"})
    if not general_setting:
        await db.settings.insert_one({
            "id": generate_uuid(),
            "type": "general",
            "cdnUrl": "",
            "downloadCdnUrl": "",
            "isCustomDownloadCdnEnabled": False,
            "vkServiceToken": os.environ.get("VK_SERVICE_TOKEN", ""),
            "createdAt": datetime.now(timezone.utc).isoformat()
        })

    # Seed default player settings if not existing
    player_setting = await db.settings.find_one({"type": "player"})
    if not player_setting:
        await db.settings.insert_one({
            "id": generate_uuid(),
            "type": "player",
            "playerType": "jwplayer",
            "autoplay": True,
            "vastEnabled": False,
            "vastTags": [],
            "isAdblockEnabled": False,
            "createdAt": datetime.now(timezone.utc).isoformat()
        })

# ---------------------------------------------------------------------------
# Video Parsers (VK Video, OK.ru, Sibnet)
# ---------------------------------------------------------------------------
async def extract_video_streams(url: str, custom_vk_token: str = "") -> dict:
    if not url:
        raise ValueError("URL is required")

    is_vk = "vk.com" in url or "vk.ru" in url or "vkvideo.ru" in url
    is_ok = "ok.ru" in url or "odnoklassniki.ru" in url
    is_sibnet = "sibnet.ru" in url

    if not (is_vk or is_ok or is_sibnet):
        raise ValueError("Unsupported URL host. Hanya VK Video, OK.ru, dan Sibnet yang didukung.")

    title = "Parsed Video"
    poster_url = ""
    host_type = "vk" if is_vk else ("ok" if is_ok else "sibnet")
    sources = []

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client_http:
        # ==========================================================
        # 1. VK VIDEO EXTRACTION
        # ==========================================================
        if is_vk:
            vk_token = (custom_vk_token or os.environ.get("VK_SERVICE_TOKEN", "")).strip()
            if not vk_token:
                gen_settings = await db.settings.find_one({"type": "general"})
                if gen_settings and (gen_settings.get("vkServiceToken") or gen_settings.get("vkApiKey")):
                    vk_token = (gen_settings.get("vkServiceToken") or gen_settings.get("vkApiKey", "")).strip()

            match = re.search(r"video(-?\d+)_(\d+)", url) or re.search(r"video(-?\d+_\d+)", url) or re.search(r"clip(-?\d+)_(\d+)", url)
            oid, vid = "", ""
            if match:
                if match.group(2):
                    oid, vid = match.group(1), match.group(2)
                else:
                    parts = match.group(1).split("_")
                    if len(parts) >= 2:
                        oid, vid = parts[0], parts[1]

            access_key = ""
            list_match = re.search(r"list=([a-zA-Z0-9_\-]+)", url)
            if list_match:
                access_key = list_match.group(1)
            access_param = re.search(r"access_key=([a-zA-Z0-9_\-]+)", url)
            if access_param:
                access_key = access_param.group(1)

            player_url = ""

            # Official VK API
            if vk_token and oid and vid:
                try:
                    queries = [f"{oid}_{vid}_{access_key}", f"{oid}_{vid}"] if access_key else [f"{oid}_{vid}"]
                    for vq in queries:
                        api_url = f"https://api.vk.com/method/video.get?videos={quote(vq)}&access_token={quote(vk_token)}&v=5.199"
                        resp = await client_http.get(api_url, headers={
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                            "Accept": "application/json"
                        })
                        if resp.status_code == 200:
                            data = resp.json()
                            items = data.get("response", {}).get("items", [])
                            if items:
                                item = items[0]
                                if item.get("title"):
                                    title = item["title"]
                                if item.get("player"):
                                    player_url = item["player"]
                                
                                if item.get("image"):
                                    sorted_img = sorted(item["image"], key=lambda x: x.get("width", 0), reverse=True)
                                    poster_url = sorted_img[0].get("url", "")
                                elif item.get("first_frame"):
                                    sorted_f = sorted(item["first_frame"], key=lambda x: x.get("width", 0), reverse=True)
                                    poster_url = sorted_f[0].get("url", "")
                                elif item.get("photo_1280") or item.get("photo_800") or item.get("photo_320"):
                                    poster_url = item.get("photo_1280") or item.get("photo_800") or item.get("photo_320")

                                files = item.get("files", {})
                                q_map = [
                                    ("mp4_1080", "1080p"),
                                    ("mp4_720", "720p"),
                                    ("mp4_480", "480p"),
                                    ("mp4_360", "360p"),
                                    ("mp4_240", "240p")
                                ]
                                for k, lbl in q_map:
                                    if files.get(k):
                                        clean_u = clean_vk_url(files[k])
                                        if not any(s["label"] == lbl for s in sources):
                                            sources.append({
                                                "file": f"/api/stream?url={quote(clean_u)}&host=vk",
                                                "label": lbl,
                                                "type": "video/mp4"
                                            })
                                if files.get("hls") and not any("HLS" in s["label"] for s in sources):
                                    sources.append({
                                        "file": f"/api/stream?url={quote(clean_vk_url(files['hls']))}&host=vk",
                                        "label": "HLS Auto",
                                        "type": "application/x-mpegURL"
                                    })
                                if sources or player_url:
                                    break
                except Exception as e:
                    pass

            # Fallback VK Embed Scraper
            if not sources and oid and vid:
                try:
                    embed_target = player_url.replace("vkvideo.ru", "vk.com") if player_url else f"https://vk.com/video_ext.php?oid={oid}&id={vid}{'&access_key=' + access_key if access_key else ''}"
                    embed_resp = await client_http.get(embed_target, headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Referer": "https://vk.com/"
                    })
                    if embed_resp.status_code == 200:
                        html_text = embed_resp.text
                        if title == "Parsed Video":
                            og_title = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html_text) or re.search(r'<meta\s+name="title"\s+content="([^"]+)"', html_text)
                            if og_title:
                                title = re.sub(r"\s*\|\s*VK\s*Video", "", og_title.group(1), flags=re.IGNORECASE)
                                title = re.sub(r"\s*\|\s*VK", "", title, flags=re.IGNORECASE).strip()
                        if not poster_url:
                            og_img = re.search(r'<meta property="og:image" content="(.*?)"', html_text)
                            if og_img:
                                poster_url = og_img.group(1)

                        idx = html_text.find("apiPrefetchCache")
                        if idx != -1:
                            b_start = html_text.find("[", idx)
                            count, b_end = 0, -1
                            for i in range(b_start, len(html_text)):
                                if html_text[i] == "[":
                                    count += 1
                                elif html_text[i] == "]":
                                    count -= 1
                                    if count == 0:
                                        b_end = i
                                        break
                            if b_end != -1:
                                try:
                                    cache_data = json.loads(html_text[b_start:b_end+1])
                                    for entry in cache_data:
                                        c_files = entry.get("response", {}).get("items", [{}])[0].get("files", {})
                                        for q in ["1080", "720", "480", "360", "240"]:
                                            direct_u = c_files.get(f"mp4_{q}") or c_files.get(f"url{q}")
                                            if direct_u and not any(s["label"] == f"{q}p" for s in sources):
                                                sources.append({
                                                    "file": f"/api/stream?url={quote(clean_vk_url(direct_u))}&host=vk",
                                                    "label": f"{q}p",
                                                    "type": "video/mp4"
                                                })
                                        hls_u = c_files.get("hls_ondemand") or c_files.get("hls")
                                        if hls_u and not any("HLS" in s["label"] for s in sources):
                                            sources.append({
                                                "file": f"/api/stream?url={quote(clean_vk_url(hls_u))}&host=vk",
                                                "label": "HLS Auto",
                                                "type": "application/x-mpegURL"
                                            })
                                except Exception:
                                    pass
                except Exception:
                    pass

            if not sources:
                raise ValueError("Gagal mengekstrak video VK Video. Pastikan video publik dan valid.")

        # ==========================================================
        # 2. OK.RU EXTRACTION
        # ==========================================================
        elif is_ok:
            ok_match = re.search(r"video(?:embed)?/(\d+)", url)
            video_id = ok_match.group(1) if ok_match else ""
            if not video_id:
                raise ValueError("Format ID OK.ru tidak valid.")

            embed_url = f"https://ok.ru/videoembed/{video_id}"
            resp = await client_http.get(embed_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                "Referer": "https://ok.ru/",
                "Origin": "https://ok.ru"
            })
            if resp.status_code == 200:
                html_text = resp.text
                t_match = re.search(r"<title>(.*?)</title>", html_text)
                if t_match:
                    title = t_match.group(1).strip()
                
                opt_match = re.search(r'data-options="([^"]+)"', html_text)
                if opt_match:
                    try:
                        decoded_opt = unquote(opt_match.group(1)).replace("&quot;", '"')
                        options = json.loads(decoded_opt)
                        flashvars = options.get("flashvars", {})
                        metadata = flashvars.get("metadata", {})
                        if isinstance(metadata, str):
                            metadata = json.loads(metadata)
                        
                        if metadata:
                            if metadata.get("movie", {}).get("title"):
                                title = metadata["movie"]["title"]
                            if metadata.get("movie", {}).get("poster"):
                                poster_url = clean_ok_url(metadata["movie"]["poster"])
                            
                            q_map = {
                                "lowest": "144p",
                                "mobile": "240p",
                                "low": "360p",
                                "sd": "480p",
                                "hd": "720p",
                                "full": "1080p",
                                "quad": "1440p",
                                "ultra": "2160p"
                            }
                            for v in metadata.get("videos", []):
                                if v.get("url"):
                                    lbl = q_map.get(v.get("name"), v.get("name"))
                                    sources.append({
                                        "file": f"/api/stream?url={quote(clean_ok_url(v['url']))}&host=ok",
                                        "label": lbl,
                                        "type": "video/mp4"
                                    })
                    except Exception:
                        pass

            if not sources:
                raise ValueError("Gagal mengekstrak video OK.ru. Pastikan video publik dan valid.")

        # ==========================================================
        # 3. SIBNET EXTRACTION
        # ==========================================================
        elif is_sibnet:
            sib_match = re.search(r"video(\d+)", url) or re.search(r"videoid=(\d+)", url) or re.search(r"sibnet\.ru/(?:video/|v/)?(\d+)", url)
            video_id = sib_match.group(1) if sib_match else ""
            if not video_id:
                raise ValueError("Format ID Video Sibnet tidak valid.")

            title = f"Sibnet Video #{video_id}"
            shell_url = f"https://video.sibnet.ru/shell.php?videoid={video_id}"
            resp = await client_http.get(shell_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                "Referer": "https://video.sibnet.ru/"
            })
            if resp.status_code == 200:
                html_text = resp.text
                t_match = re.search(r"<title>(.*?)</title>", html_text)
                if t_match:
                    title = t_match.group(1).strip()
                p_match = re.search(r'poster\s*:\s*["\']([^"\']+)["\']', html_text) or re.search(r'poster=["\']([^"\']+)["\']', html_text)
                if p_match:
                    p_val = p_match.group(1)
                    poster_url = p_val if p_val.startswith("http") else f"https://video.sibnet.ru{p_val}"
                
                src_match = re.search(r'src\s*:\s*["\'](/v/[^"\']+)["\']', html_text, re.IGNORECASE) or re.search(r'["\'](/v/[a-zA-Z0-9_\-.\?\=\&]+)["\']', html_text)
                if src_match:
                    raw_p = src_match.group(1)
                    direct_v = raw_p if raw_p.startswith("http") else f"https://video.sibnet.ru{raw_p}"
                    sources.append({
                        "file": f"/api/stream?url={quote(direct_v)}&host=sibnet",
                        "label": "720p HD",
                        "type": "video/mp4"
                    })

            if not sources:
                fallback_stream = f"https://video.sibnet.ru/shell.php?videoid={video_id}"
                sources.append({
                    "file": f"/api/stream?url={quote(fallback_stream)}&host=sibnet",
                    "label": "720p",
                    "type": "video/mp4"
                })

    return {
        "title": title,
        "posterUrl": poster_url,
        "hostType": host_type,
        "sources": sources
    }

# ---------------------------------------------------------------------------
# VAST XML Parser & Resolver
# ---------------------------------------------------------------------------
def parse_duration_to_seconds(dur_str: str) -> int:
    if not dur_str:
        return 15
    dur_str = dur_str.strip()
    if re.match(r"^\d+(\.\d+)?$", dur_str):
        return int(float(dur_str))
    parts = dur_str.split(":")
    try:
        if len(parts) == 3:
            return int(float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2]))
        elif len(parts) == 2:
            return int(float(parts[0]) * 60 + float(parts[1]))
    except Exception:
        pass
    return 15

def parse_vast_xml(xml_content: str) -> dict:
    if not xml_content:
        return {"success": False, "error": "Empty XML", "ads": []}
    
    clean_xml = re.sub(r'xmlns(:\w+)?="[^"]+"', "", xml_content)
    ads = []

    try:
        root = ET.fromstring(clean_xml)
        for ad_node in root.findall(".//Ad"):
            ad_id = ad_node.get("id") or f"ad_{generate_uuid()[:8]}"
            title_node = ad_node.find(".//AdTitle")
            title = (title_node.text or "Video Ad").strip() if title_node is not None else "Video Ad"

            wrapper_node = ad_node.find(".//VASTAdTagURI")
            wrapper_url = (wrapper_node.text or "").strip() if wrapper_node is not None else ""

            impressions = [i.text.strip() for i in ad_node.findall(".//Impression") if i.text]
            errors = [e.text.strip() for e in ad_node.findall(".//Error") if e.text]

            linear_node = ad_node.find(".//Linear")
            duration_sec = 15
            duration_formatted = "00:00:15"
            skip_offset_sec = 30
            click_through = ""
            click_trackings = []
            tracking_events = {}
            media_files = []

            if linear_node is not None:
                dur_node = linear_node.find("Duration")
                if dur_node is not None and dur_node.text:
                    duration_formatted = dur_node.text.strip()
                    duration_sec = parse_duration_to_seconds(duration_formatted)
                
                skip_attr = linear_node.get("skipoffset")
                if skip_attr:
                    skip_offset_sec = parse_duration_to_seconds(skip_attr)

                ct_node = linear_node.find(".//ClickThrough")
                if ct_node is not None and ct_node.text:
                    click_through = ct_node.text.strip()

                for ct in linear_node.findall(".//ClickTracking"):
                    if ct.text:
                        click_trackings.append(ct.text.strip())

                for tr in linear_node.findall(".//Tracking"):
                    ev = tr.get("event")
                    if ev and tr.text:
                        tracking_events.setdefault(ev, []).append(tr.text.strip())

                for mf in linear_node.findall(".//MediaFile"):
                    if mf.text and ("http" in mf.text or "//" in mf.text):
                        src = mf.text.strip()
                        if src.startswith("//"):
                            src = f"https:{src}"
                        media_files.append({
                            "src": src,
                            "type": mf.get("type", "video/mp4").lower(),
                            "delivery": mf.get("delivery", "progressive"),
                            "width": int(mf.get("width", 640) or 640),
                            "height": int(mf.get("height", 360) or 360),
                            "bitrate": int(mf.get("bitrate", 0) or 0)
                        })

                media_files.sort(key=lambda x: (1 if "mp4" in x["type"] else 0, x["height"] * x["width"]), reverse=True)

            ads.append({
                "id": ad_id,
                "title": title,
                "isWrapper": bool(wrapper_url),
                "wrapperUrl": wrapper_url,
                "duration": duration_sec,
                "durationFormatted": duration_formatted,
                "skipOffset": skip_offset_sec,
                "clickThroughUrl": click_through,
                "clickTrackingUrls": click_trackings,
                "impressionUrls": impressions,
                "errorUrls": errors,
                "trackingEvents": tracking_events,
                "mediaFiles": media_files,
                "bestMediaFile": media_files[0] if media_files else None
            })

        if ads:
            return {"success": True, "ads": ads}
    except Exception as e:
        pass

    # Regex Fallback
    try:
        ad_matches = re.findall(r"<Ad[\s\S]*?</Ad>", clean_xml, re.IGNORECASE)
        for chunk in ad_matches:
            id_m = re.search(r'<Ad[^>]*id=["\']([^"\']+)["\']', chunk, re.IGNORECASE)
            ad_id = id_m.group(1) if id_m else f"ad_{generate_uuid()[:8]}"

            t_m = re.search(r"<AdTitle>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</AdTitle>", chunk, re.IGNORECASE)
            title = t_m.group(1).strip() if t_m else "Video Ad"

            w_m = re.search(r"<VASTAdTagURI>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</VASTAdTagURI>", chunk, re.IGNORECASE)
            wrapper_url = w_m.group(1).strip() if w_m else ""

            dur_m = re.search(r"<Duration>([\s\S]*?)</Duration>", chunk, re.IGNORECASE)
            duration_formatted = dur_m.group(1).strip() if dur_m else "00:00:15"
            duration_sec = parse_duration_to_seconds(duration_formatted)

            skip_m = re.search(r'skipoffset=["\']([^"\']+)["\']', chunk, re.IGNORECASE)
            skip_offset_sec = parse_duration_to_seconds(skip_m.group(1)) if skip_m else 30

            ct_m = re.search(r"<ClickThrough>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</ClickThrough>", chunk, re.IGNORECASE)
            click_through = ct_m.group(1).strip() if ct_m else ""

            media_files = []
            mf_matches = re.findall(r"<MediaFile[\s\S]*?>([\s\S]*?)</MediaFile>", chunk, re.IGNORECASE)
            for mf_raw in mf_matches:
                clean_src = re.sub(r"<!\[CDATA\[|\]\]>", "", mf_raw).strip()
                if "http" in clean_src or clean_src.startswith("//"):
                    if clean_src.startswith("//"):
                        clean_src = f"https:{clean_src}"
                    media_files.append({
                        "src": clean_src,
                        "type": "video/mp4",
                        "delivery": "progressive",
                        "width": 640,
                        "height": 360,
                        "bitrate": 0
                    })

            ads.append({
                "id": ad_id,
                "title": title,
                "isWrapper": bool(wrapper_url),
                "wrapperUrl": wrapper_url,
                "duration": duration_sec,
                "durationFormatted": duration_formatted,
                "skipOffset": skip_offset_sec,
                "clickThroughUrl": click_through,
                "clickTrackingUrls": [],
                "impressionUrls": [],
                "errorUrls": [],
                "trackingEvents": {},
                "mediaFiles": media_files,
                "bestMediaFile": media_files[0] if media_files else None
            })

        return {"success": len(ads) > 0, "ads": ads}
    except Exception as e:
        return {"success": False, "error": str(e), "ads": []}

async def fetch_and_resolve_vast_tag(tag_url: str, max_depth: int = 4) -> dict:
    if not tag_url or not tag_url.strip():
        raise ValueError("VAST Tag URL is empty")

    current_url = tag_url.strip()
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client_http:
        for _ in range(max_depth):
            resp = await client_http.get(current_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                "Accept": "application/xml, text/xml, */*"
            })
            if resp.status_code != 200:
                raise ValueError(f"Upstream returned HTTP {resp.status_code}")
            
            parsed = parse_vast_xml(resp.text)
            if not parsed.get("success") or not parsed.get("ads"):
                raise ValueError("No valid ads in VAST XML response")
            
            first_ad = parsed["ads"][0]
            if first_ad.get("isWrapper") and first_ad.get("wrapperUrl"):
                current_url = first_ad["wrapperUrl"]
                continue
            
            if first_ad.get("bestMediaFile"):
                return first_ad

    raise ValueError("Exceeded maximum wrapper depth without playable media file")

# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.get("/api")
@app.get("/api/")
@app.get("/api/root")
async def root():
    return {"message": "ShinDora Stream API"}

@app.get("/api/status")
async def get_status():
    items = await db.status_checks.find({}, {"_id": 0}).to_list(100)
    return items

@app.post("/api/status")
async def create_status(body: dict = Body(...)):
    name = body.get("client_name")
    if not name:
        raise HTTPException(status_code=400, detail="client_name is required")
    obj = {
        "id": generate_uuid(),
        "client_name": name,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }
    await db.status_checks.insert_one(obj)
    obj.pop("_id", None)
    return obj

# ---------------------------------------------------------------------------
# Dashboard Stats
# ---------------------------------------------------------------------------
@app.get("/api/stats")
@app.get("/api/dashboard/stats")
async def get_stats():
    total = await db.links.count_documents({})
    vk_count = await db.links.count_documents({
        "$or": [{"hostType": "vk"}, {"originalUrl": {"$regex": r"vk\.com|vk\.ru|vkvideo\.ru", "$options": "i"}}]
    })
    ok_count = await db.links.count_documents({
        "$or": [{"hostType": "ok"}, {"hostType": "okru"}, {"originalUrl": {"$regex": r"ok\.ru|odnoklassniki\.ru", "$options": "i"}}]
    })
    sibnet_count = await db.links.count_documents({
        "$or": [{"hostType": "sibnet"}, {"originalUrl": {"$regex": r"sibnet\.ru", "$options": "i"}}]
    })
    return {
        "success": True,
        "stats": {
            "totalVideos": total,
            "vkCount": vk_count,
            "okCount": ok_count,
            "sibnetCount": sibnet_count
        }
    }

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
@app.post("/api/auth/login")
async def login(body: dict = Body(...), response: Response = None):
    username = (body.get("username") or "").strip()
    password = (body.get("password") or "").strip()
    remember = body.get("remember", True)

    admin = await db.settings.find_one({"type": "admin"})
    if not admin:
        admin_user = os.environ.get("ADMIN_USERNAME", "admin")
        admin_pass = os.environ.get("ADMIN_PASSWORD", "admin123")
        admin = {"username": admin_user, "password": admin_pass}
        await db.settings.insert_one({"id": generate_uuid(), "type": "admin", "username": admin_user, "password": admin_pass})

    if username == admin.get("username") and password == admin.get("password"):
        access_token = generate_uuid()
        refresh_token = generate_uuid()
        now = datetime.now(timezone.utc)
        access_exp = now + timedelta(hours=1)
        refresh_exp = now + (timedelta(days=30) if remember else timedelta(days=7))

        await db.sessions.insert_one({
            "id": generate_uuid(),
            "token": access_token,
            "refreshToken": refresh_token,
            "username": username,
            "expiresAt": access_exp.isoformat(),
            "refreshExpiresAt": refresh_exp.isoformat(),
            "createdAt": now.isoformat(),
            "updatedAt": now.isoformat()
        })

        res = JSONResponse({"success": True, "user": username, "token": access_token})
        res.set_cookie("session_token", access_token, max_age=3600, path="/", httponly=True, samesite="lax")
        res.set_cookie("refresh_token", refresh_token, max_age=2592000 if remember else 604800, path="/", httponly=True, samesite="lax")
        return res
    
    raise HTTPException(status_code=401, detail="Invalid username or password")

@app.post("/api/auth/logout")
async def logout(request: Request):
    token = request.cookies.get("session_token")
    if token:
        await db.sessions.delete_one({"token": token})
    res = JSONResponse({"success": True})
    res.delete_cookie("session_token")
    res.delete_cookie("refresh_token")
    return res

@app.get("/api/auth/session")
@app.get("/api/auth/me")
async def get_session(request: Request):
    token = request.cookies.get("session_token")
    auth_header = request.headers.get("Authorization") or ""
    if not token and auth_header.startswith("Bearer "):
        token = auth_header.replace("Bearer ", "").strip()

    if token:
        session = await db.sessions.find_one({"token": token})
        if session:
            exp_str = session.get("expiresAt")
            if exp_str:
                exp_dt = datetime.fromisoformat(exp_str)
                if exp_dt > datetime.now(timezone.utc):
                    return {"authenticated": True, "user": session.get("username", "Admin"), "token": token}
    
    # Try refresh token
    ref_token = request.cookies.get("refresh_token")
    if ref_token:
        session = await db.sessions.find_one({"refreshToken": ref_token})
        if session:
            exp_str = session.get("refreshExpiresAt")
            if exp_str and datetime.fromisoformat(exp_str) > datetime.now(timezone.utc):
                new_token = generate_uuid()
                now = datetime.now(timezone.utc)
                await db.sessions.update_one({"refreshToken": ref_token}, {"$set": {"token": new_token, "expiresAt": (now + timedelta(hours=1)).isoformat()}})
                res = JSONResponse({"authenticated": True, "user": session.get("username", "Admin"), "token": new_token, "refreshed": True})
                res.set_cookie("session_token", new_token, max_age=3600, path="/", httponly=True, samesite="lax")
                return res

    res = JSONResponse({"authenticated": False}, status_code=401)
    res.delete_cookie("session_token")
    res.delete_cookie("refresh_token")
    return res

# ---------------------------------------------------------------------------
# Settings Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/settings")
async def get_settings():
    ik = await db.settings.find_one({"type": "imagekit"}) or {}
    admin = await db.settings.find_one({"type": "admin"}) or {}
    player = await db.settings.find_one({"type": "player"}) or {}
    general = await db.settings.find_one({"type": "general"}) or {}

    return {
        "imagekit": {
            "publicKey": os.environ.get("IMAGEKIT_PUBLIC_KEY") or ik.get("publicKey", ""),
            "urlEndpoint": os.environ.get("IMAGEKIT_URL_ENDPOINT") or ik.get("urlEndpoint", ""),
            "hasPrivateKey": bool(os.environ.get("IMAGEKIT_PRIVATE_KEY") or ik.get("privateKey")),
            "isEnvConfigured": bool(os.environ.get("IMAGEKIT_PUBLIC_KEY") or os.environ.get("IMAGEKIT_PRIVATE_KEY"))
        },
        "admin": {
            "username": admin.get("username", "admin")
        },
        "player": {
            "playerType": player.get("playerType", "jwplayer"),
            "autoplay": player.get("autoplay", True),
            "vastEnabled": player.get("vastEnabled", False),
            "vastTags": player.get("vastTags", []),
            "isAdblockEnabled": bool(player.get("isAdblockEnabled", False))
        },
        "general": {
            "cdnUrl": general.get("cdnUrl", ""),
            "downloadCdnUrl": general.get("downloadCdnUrl", ""),
            "isCustomDownloadCdnEnabled": bool(general.get("isCustomDownloadCdnEnabled", False)),
            "vkServiceToken": general.get("vkServiceToken") or os.environ.get("VK_SERVICE_TOKEN", "")
        }
    }

@app.post("/api/settings")
async def update_settings(body: dict = Body(...)):
    stype = body.get("settingsType")
    if not stype:
        raise HTTPException(status_code=400, detail="settingsType is required")

    if stype == "imagekit":
        update_data = {
            "publicKey": body.get("publicKey", ""),
            "urlEndpoint": body.get("urlEndpoint", "")
        }
        if body.get("privateKey") and body["privateKey"] != "●●●●●":
            update_data["privateKey"] = body["privateKey"]
        await db.settings.update_one({"type": "imagekit"}, {"$set": update_data}, upsert=True)
        return {"success": True, "message": "ImageKit settings updated successfully"}

    elif stype == "player":
        update_data = {
            "playerType": body.get("playerType", "jwplayer"),
            "autoplay": bool(body.get("autoplay", True)),
            "vastEnabled": bool(body.get("vastEnabled", False)),
            "vastTags": body.get("vastTags", []),
            "isAdblockEnabled": bool(body.get("isAdblockEnabled", False))
        }
        await db.settings.update_one({"type": "player"}, {"$set": update_data}, upsert=True)
        return {"success": True, "message": "Player settings updated successfully"}

    elif stype == "general":
        update_data = {}
        if "cdnUrl" in body:
            update_data["cdnUrl"] = body["cdnUrl"]
        if "downloadCdnUrl" in body:
            update_data["downloadCdnUrl"] = body["downloadCdnUrl"]
        if "isCustomDownloadCdnEnabled" in body:
            update_data["isCustomDownloadCdnEnabled"] = bool(body["isCustomDownloadCdnEnabled"])
        if "vkServiceToken" in body or "vkApiKey" in body:
            tok = body.get("vkServiceToken") or body.get("vkApiKey", "")
            update_data["vkServiceToken"] = tok
        await db.settings.update_one({"type": "general"}, {"$set": update_data}, upsert=True)
        return {"success": True, "message": "General settings updated successfully"}

    elif stype == "admin":
        user = body.get("username", "").strip()
        pwd = body.get("password", "").strip()
        if not user or not pwd:
            raise HTTPException(status_code=400, detail="Username and password cannot be empty")
        await db.settings.update_one({"type": "admin"}, {"$set": {"username": user, "password": pwd}}, upsert=True)
        return {"success": True, "message": "Admin credentials updated successfully"}

    raise HTTPException(status_code=400, detail="Invalid settings type")

# ---------------------------------------------------------------------------
# ImageKit Auth Endpoint
# ---------------------------------------------------------------------------
@app.get("/api/imagekit-auth")
async def get_imagekit_auth():
    ik = await db.settings.find_one({"type": "imagekit"}) or {}
    pub_key = os.environ.get("IMAGEKIT_PUBLIC_KEY") or ik.get("publicKey", "")
    priv_key = os.environ.get("IMAGEKIT_PRIVATE_KEY") or ik.get("privateKey", "")
    endpoint = os.environ.get("IMAGEKIT_URL_ENDPOINT") or ik.get("urlEndpoint", "")

    token = generate_uuid()
    expire = int(datetime.now(timezone.utc).timestamp()) + 2400
    msg = f"{token}{expire}".encode("utf-8")
    signature = hmac.new(priv_key.encode("utf-8"), msg, hashlib.sha1).hexdigest()

    return {
        "token": token,
        "expire": expire,
        "signature": signature,
        "publicKey": pub_key,
        "urlEndpoint": endpoint
    }

# ---------------------------------------------------------------------------
# Video Parsing Endpoint
# ---------------------------------------------------------------------------
@app.post("/api/parse")
async def parse_video_url(body: dict = Body(...)):
    url = body.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    try:
        extracted = await extract_video_streams(url)
        return extracted
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

# ---------------------------------------------------------------------------
# Parse Stream & Live Token Recovery Endpoint
# ---------------------------------------------------------------------------
@app.get("/api/parse-stream")
async def parse_stream_slug(slug: str = Query(...), force: Optional[str] = Query(None)):
    link = await db.links.find_one({"slug": slug})
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")

    is_force = force in ["1", "true", "yes"]

    # Retrieve CDN setting
    gen = await db.settings.find_one({"type": "general"}) or {}
    cdn_url = (gen.get("cdnUrl") or "").strip().rstrip("/")

    def format_source_cdn(s):
        f = s.get("file", "")
        if f.startswith("/api/stream"):
            if "slug=" not in f and slug:
                f += ("&" if "?" in f else "?") + f"slug={quote(slug)}"
            if cdn_url:
                f = f"{cdn_url}{'' if f.startswith('/') else '/'}{f}"
        return {**s, "file": f}

    if not is_force and link.get("sources"):
        return {
            "success": True,
            "refreshed": False,
            "sources": [format_source_cdn(s) for s in link["sources"]],
            "subtitles": [{
                **sub,
                "file": f"{cdn_url}{sub['file']}" if sub.get("file", "").startswith("/api/") and cdn_url else sub.get("file")
            } for sub in link.get("subtitles", [])],
            "title": link.get("title", ""),
            "posterUrl": link.get("posterUrl", ""),
            "hostType": link.get("hostType", "vk")
        }

    # Live Re-extraction
    try:
        fresh = await extract_video_streams(link["originalUrl"])
        if fresh.get("sources"):
            up_doc = {
                "sources": fresh["sources"],
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
            if fresh.get("posterUrl") and not link.get("posterUrl"):
                up_doc["posterUrl"] = fresh["posterUrl"]
            if fresh.get("hostType"):
                up_doc["hostType"] = fresh["hostType"]

            await db.links.update_one({"slug": slug}, {"$set": up_doc})
            return {
                "success": True,
                "refreshed": True,
                "sources": [format_source_cdn(s) for s in fresh["sources"]],
                "subtitles": [{
                    **sub,
                    "file": f"{cdn_url}{sub['file']}" if sub.get("file", "").startswith("/api/") and cdn_url else sub.get("file")
                } for sub in link.get("subtitles", [])],
                "title": link.get("title") or fresh.get("title"),
                "posterUrl": link.get("posterUrl") or fresh.get("posterUrl"),
                "hostType": link.get("hostType") or fresh.get("hostType", "vk")
            }
    except Exception as e:
        pass

    return {
        "success": True,
        "refreshed": False,
        "fallback": True,
        "sources": [format_source_cdn(s) for s in link.get("sources", [])],
        "subtitles": link.get("subtitles", []),
        "title": link.get("title", slug),
        "posterUrl": link.get("posterUrl", ""),
        "hostType": link.get("hostType", "vk")
    }

# ---------------------------------------------------------------------------
# 24 Hours Background Cron Refresh
# ---------------------------------------------------------------------------
@app.get("/api/cron/refresh-tokens")
@app.post("/api/cron/refresh-tokens")
@app.get("/api/cron/token-refresh")
async def cron_refresh_tokens(limit: int = Query(25), hours: int = Query(24)):
    links = await db.links.find({}).sort("updatedAt", 1).to_list(limit)
    refreshed_count = 0
    error_count = 0
    results = []

    for l in links:
        slug = l.get("slug")
        orig_url = l.get("originalUrl")
        if not orig_url or not slug:
            continue
        try:
            fresh = await extract_video_streams(orig_url)
            if fresh.get("sources"):
                await db.links.update_one({"slug": slug}, {
                    "$set": {
                        "sources": fresh["sources"],
                        "updatedAt": datetime.now(timezone.utc).isoformat()
                    }
                })
                refreshed_count += 1
                results.append({"slug": slug, "status": "refreshed", "title": l.get("title")})
            else:
                error_count += 1
                results.append({"slug": slug, "status": "no_sources"})
        except Exception as e:
            error_count += 1
            results.append({"slug": slug, "status": "error", "message": str(e)})

    return {
        "success": True,
        "message": f"Cron 24 Jam Selesai: Berhasil memperbarui {refreshed_count} video ({error_count} dilewati).",
        "refreshedCount": refreshed_count,
        "errorCount": error_count,
        "totalChecked": len(links),
        "cycleHours": hours,
        "results": results
    }

# ---------------------------------------------------------------------------
# Stream & Direct Stream Proxy
# ---------------------------------------------------------------------------
@app.get("/api/stream")
@app.get("/api/stream/{quality}/{slug}")
async def proxy_stream(
    request: Request,
    quality: Optional[str] = None,
    slug: Optional[str] = None,
    url: Optional[str] = Query(None),
    host: Optional[str] = Query("vk"),
    download: Optional[str] = Query("0"),
    filename: Optional[str] = Query(None)
):
    target_url = url
    host_type = host or "vk"
    slug_val = request.query_params.get("slug", slug or "")

    # Check CDN redirection to Cloudflare Worker
    gen = await db.settings.find_one({"type": "general"}) or {}
    cdn_url = (gen.get("cdnUrl") or "").strip().rstrip("/")
    if cdn_url:
        parsed_cdn = urlparse(cdn_url)
        if request.url.netloc != parsed_cdn.netloc:
            redirect_to = f"{cdn_url}{request.url.path}" + (f"?{request.url.query}" if request.url.query else "")
            return Response(status_code=307, headers={"Location": redirect_to, "Access-Control-Allow-Origin": "*"})

    # Direct quality slug resolution: /api/stream/{quality}/{slug}
    if quality and slug:
        clean_slug = slug.replace(".mp4", "")
        clean_q = quality.lower().rstrip("p")
        link = await db.links.find_one({"slug": clean_slug})
        if not link:
            raise HTTPException(status_code=404, detail="Video not found")
        
        sources = link.get("sources", [])
        matched_src = next((s for s in sources if clean_q in s.get("label", "").lower()), None)
        if not matched_src and sources:
            matched_src = sources[0]
        
        if matched_src and matched_src.get("file"):
            sf = matched_src["file"]
            if "?url=" in sf:
                parsed_sf = urlparse(sf)
                qs = parse_qs(parsed_sf.query)
                target_url = qs.get("url", [""])[0]
                host_type = qs.get("host", [link.get("hostType", "vk")])[0]
            else:
                target_url = sf
                host_type = link.get("hostType", "vk")

    if not target_url:
        raise HTTPException(status_code=400, detail="Missing stream target URL")

    decoded_url = unquote(target_url)

    # Set Upstream Request Headers
    req_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    }
    if host_type in ["vk", "vkvideo"]:
        req_headers["Referer"] = "https://vk.com/"
        req_headers["Origin"] = "https://vk.com"
    elif host_type in ["ok", "okru"]:
        req_headers["Referer"] = "https://ok.ru/"
        req_headers["Origin"] = "https://ok.ru"
    elif host_type == "sibnet":
        req_headers["Referer"] = "https://video.sibnet.ru/"
        req_headers["Origin"] = "https://video.sibnet.ru"

    range_hdr = request.headers.get("Range")
    if range_hdr:
        req_headers["Range"] = range_hdr

    client_http = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
    try:
        req = client_http.build_request("GET", decoded_url, headers=req_headers)
        upstream_res = await client_http.send(req, stream=True)

        # Token Recovery if 401/403/404/410
        if upstream_res.status_code in [401, 403, 404, 410] and slug_val:
            await upstream_res.aclose()
            link = await db.links.find_one({"slug": slug_val})
            if link and link.get("originalUrl"):
                try:
                    fresh = await extract_video_streams(link["originalUrl"])
                    if fresh.get("sources"):
                        await db.links.update_one({"slug": slug_val}, {"$set": {"sources": fresh["sources"]}})
                        fresh_src = fresh["sources"][0].get("file", "")
                        if "?url=" in fresh_src:
                            qs = parse_qs(urlparse(fresh_src).query)
                            decoded_url = unquote(qs.get("url", [""])[0])
                        else:
                            decoded_url = fresh_src
                        
                        req = client_http.build_request("GET", decoded_url, headers=req_headers)
                        upstream_res = await client_http.send(req, stream=True)
                except Exception:
                    pass

        resp_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Range",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Token-Recovered, X-Bypass-Vercel",
            "Accept-Ranges": "bytes",
            "X-Bypass-Vercel": "1",
            "Content-Type": upstream_res.headers.get("content-type") or "video/mp4"
        }

        if download in ["1", "true"]:
            fname = filename or "video.mp4"
            resp_headers["Content-Disposition"] = f'attachment; filename="{fname}"'

        for h in ["content-length", "content-range", "etag", "last-modified"]:
            if upstream_res.headers.get(h):
                resp_headers[h] = upstream_res.headers[h]

        async def stream_content():
            try:
                async for chunk in upstream_res.aiter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await upstream_res.aclose()
                await client_http.aclose()

        return StreamingResponse(stream_content(), status_code=upstream_res.status_code, headers=resp_headers)

    except Exception as e:
        await client_http.aclose()
        raise HTTPException(status_code=500, detail=f"Stream Proxy Error: {str(e)}")

# ---------------------------------------------------------------------------
# Download & Direct Download Proxy
# ---------------------------------------------------------------------------
@app.get("/api/download")
@app.get("/api/download/{quality}/{slug}")
async def proxy_download(
    request: Request,
    quality: Optional[str] = None,
    slug: Optional[str] = None,
    url: Optional[str] = Query(None),
    host: Optional[str] = Query("vk"),
    filename: Optional[str] = Query(None)
):
    target_url = url
    host_type = host or "vk"
    slug_val = request.query_params.get("slug", slug or "")
    q_val = request.query_params.get("quality", quality or "720").lower().rstrip("p")
    custom_filename = filename

    # Check CDN redirection for download
    gen = await db.settings.find_one({"type": "general"}) or {}
    download_cdn_url = ""
    if gen.get("isCustomDownloadCdnEnabled") and gen.get("downloadCdnUrl"):
        download_cdn_url = gen["downloadCdnUrl"].strip().rstrip("/")
    elif gen.get("cdnUrl"):
        download_cdn_url = gen["cdnUrl"].strip().rstrip("/")

    if download_cdn_url:
        parsed_cdn = urlparse(download_cdn_url)
        if request.url.netloc != parsed_cdn.netloc:
            redirect_to = f"{download_cdn_url}{request.url.path}" + (f"?{request.url.query}" if request.url.query else "")
            return Response(status_code=307, headers={"Location": redirect_to, "Access-Control-Allow-Origin": "*"})

    # Direct quality download route
    if slug_val:
        clean_slug = slug_val.replace(".mp4", "")
        link = await db.links.find_one({"slug": clean_slug})
        if link:
            custom_filename = format_download_filename(link.get("title", clean_slug), q_val)
            sources = link.get("sources", [])
            matched_src = next((s for s in sources if q_val in s.get("label", "").lower()), None)
            if not matched_src and sources:
                matched_src = sources[0]
            if matched_src and matched_src.get("file"):
                sf = matched_src["file"]
                if "?url=" in sf:
                    parsed_sf = urlparse(sf)
                    qs = parse_qs(parsed_sf.query)
                    target_url = qs.get("url", [""])[0]
                    host_type = qs.get("host", [link.get("hostType", "vk")])[0]
                else:
                    target_url = sf
                    host_type = link.get("hostType", "vk")

    if not target_url:
        raise HTTPException(status_code=400, detail="Missing download target URL")

    if not custom_filename:
        custom_filename = format_download_filename("video", q_val)

    decoded_url = unquote(target_url)

    req_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    }
    if host_type in ["vk", "vkvideo"]:
        req_headers["Referer"] = "https://vk.com/"
        req_headers["Origin"] = "https://vk.com"
    elif host_type in ["ok", "okru"]:
        req_headers["Referer"] = "https://ok.ru/"
        req_headers["Origin"] = "https://ok.ru"
    elif host_type == "sibnet":
        req_headers["Referer"] = "https://video.sibnet.ru/"
        req_headers["Origin"] = "https://video.sibnet.ru"

    range_hdr = request.headers.get("Range")
    if range_hdr:
        req_headers["Range"] = range_hdr

    client_http = httpx.AsyncClient(timeout=60.0, follow_redirects=True)
    try:
        req = client_http.build_request("GET", decoded_url, headers=req_headers)
        upstream_res = await client_http.send(req, stream=True)

        # Recovery on 401/403/404/410
        if upstream_res.status_code in [401, 403, 404, 410] and slug_val:
            await upstream_res.aclose()
            link = await db.links.find_one({"slug": slug_val.replace(".mp4", "")})
            if link and link.get("originalUrl"):
                try:
                    fresh = await extract_video_streams(link["originalUrl"])
                    if fresh.get("sources"):
                        await db.links.update_one({"slug": link["slug"]}, {"$set": {"sources": fresh["sources"]}})
                        fresh_src = fresh["sources"][0].get("file", "")
                        if "?url=" in fresh_src:
                            qs = parse_qs(urlparse(fresh_src).query)
                            decoded_url = unquote(qs.get("url", [""])[0])
                        else:
                            decoded_url = fresh_src
                        
                        req = client_http.build_request("GET", decoded_url, headers=req_headers)
                        upstream_res = await client_http.send(req, stream=True)
                except Exception:
                    pass

        ascii_fname = re.sub(r"[^\x20-\x7E]", "_", custom_filename)
        resp_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Range",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Bypass-Vercel",
            "Accept-Ranges": "bytes",
            "X-Bypass-Vercel": "1",
            "Content-Type": "application/octet-stream",
            "Content-Disposition": f'attachment; filename="{ascii_fname}"; filename*=UTF-8\'\'{quote(custom_filename)}'
        }

        for h in ["content-length", "content-range", "etag", "last-modified"]:
            if upstream_res.headers.get(h):
                resp_headers[h] = upstream_res.headers[h]

        async def stream_download():
            try:
                async for chunk in upstream_res.aiter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await upstream_res.aclose()
                await client_http.aclose()

        return StreamingResponse(stream_download(), status_code=upstream_res.status_code, headers=resp_headers)

    except Exception as e:
        await client_http.aclose()
        raise HTTPException(status_code=500, detail=f"Download Proxy Error: {str(e)}")

# ---------------------------------------------------------------------------
# Subtitle Proxy & WebVTT Converter
# ---------------------------------------------------------------------------
@app.get("/api/subtitle")
async def proxy_subtitle(url: str = Query(...)):
    if not url:
        raise HTTPException(status_code=400, detail="Missing subtitle URL")

    decoded_url = unquote(url)
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client_http:
        try:
            resp = await client_http.get(decoded_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                "Accept": "text/vtt,text/plain,*/*"
            })
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="Remote subtitle fetch failed")

            raw_sub = resp.text
            vtt_content = convert_srt_to_vtt(raw_sub)

            return RawResponse(
                content=vtt_content,
                media_type="text/vtt; charset=utf-8",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Cache-Control": "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
                    "X-Bypass-Vercel": "1"
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Subtitle error: {str(e)}")

# ---------------------------------------------------------------------------
# VAST XML Proxy & Tester Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/vast-proxy")
async def proxy_vast_xml(url: str = Query(...)):
    if not url:
        raise HTTPException(status_code=400, detail="Missing VAST URL")
    
    decoded_url = unquote(url)
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client_http:
        try:
            resp = await client_http.get(decoded_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
                "Accept": "application/xml, text/xml, */*"
            })
            return RawResponse(
                content=resp.text,
                media_type="application/xml; charset=utf-8",
                status_code=resp.status_code,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Cache-Control": "no-store, max-age=0"
                }
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"VAST Proxy Error: {str(e)}")

@app.get("/api/vast-test")
@app.post("/api/vast-test")
async def test_vast_tag(
    request: Request,
    url: Optional[str] = Query(None),
    body: Optional[dict] = Body(None)
):
    test_url = url or (body.get("url") or body.get("tagUrl") if body else None)
    if not test_url:
        raise HTTPException(status_code=400, detail="URL parameter is required for testing VAST tag")

    try:
        ad = await fetch_and_resolve_vast_tag(test_url, max_depth=4)
        return {
            "success": True,
            "message": "VAST Tag valid dan terurai dengan sukses",
            "ad": {
                "id": ad.get("id"),
                "title": ad.get("title"),
                "duration": ad.get("duration"),
                "durationFormatted": ad.get("durationFormatted"),
                "skipOffset": ad.get("skipOffset"),
                "clickThroughUrl": ad.get("clickThroughUrl"),
                "clickTrackingsCount": len(ad.get("clickTrackingUrls", [])),
                "impressionsCount": len(ad.get("impressionUrls", [])),
                "trackingEvents": list(ad.get("trackingEvents", {}).keys()),
                "bestMediaFile": ad.get("bestMediaFile"),
                "mediaFilesCount": len(ad.get("mediaFiles", [])),
                "mediaFiles": ad.get("mediaFiles", [])
            }
        }
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=422)

# ---------------------------------------------------------------------------
# Video Links CRUD Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/links")
async def get_all_links():
    links = await db.links.find({}, {"_id": 0}).sort("createdAt", -1).to_list(1000)
    return links

@app.post("/api/links")
async def create_link(body: dict = Body(...)):
    title = body.get("title", "").strip()
    slug = (body.get("slug") or "").strip().lower()
    orig_url = (body.get("originalUrl") or "").strip()
    poster_url = body.get("posterUrl", "").strip()
    sources = body.get("sources", [])
    subtitles = body.get("subtitles", [])

    if not title or not orig_url or not sources:
        raise HTTPException(status_code=400, detail="Title, Original URL, and Stream sources are required")

    clean_slug = re.sub(r"[^a-z0-9-_]", "-", slug) if slug else generate_uuid()[:8]
    existing = await db.links.find_one({"slug": clean_slug})
    if existing:
        raise HTTPException(status_code=400, detail="Slug already exists. Please choose another slug.")

    host_type = "other"
    lower_u = orig_url.lower()
    if "vk.com" in lower_u or "vk.ru" in lower_u or "vkvideo.ru" in lower_u:
        host_type = "vk"
    elif "ok.ru" in lower_u or "odnoklassniki.ru" in lower_u:
        host_type = "okru"
    elif "sibnet.ru" in lower_u:
        host_type = "sibnet"

    now_iso = datetime.now(timezone.utc).isoformat()
    new_doc = {
        "id": generate_uuid(),
        "title": title,
        "slug": clean_slug,
        "originalUrl": orig_url,
        "posterUrl": poster_url,
        "sources": sources,
        "subtitles": subtitles,
        "hostType": host_type,
        "createdAt": now_iso,
        "updatedAt": now_iso
    }

    await db.links.insert_one(new_doc)
    new_doc.pop("_id", None)
    return new_doc

@app.get("/api/links/{link_id}")
async def get_single_link(link_id: str = FPath(...)):
    link = await db.links.find_one({"$or": [{"id": link_id}, {"slug": link_id}]}, {"_id": 0})
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    return link

@app.put("/api/links/{link_id}")
async def update_link(link_id: str = FPath(...), body: dict = Body(...)):
    link = await db.links.find_one({"$or": [{"id": link_id}, {"slug": link_id}]})
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")

    title = body.get("title", "").strip()
    slug = (body.get("slug") or "").strip().lower()
    orig_url = (body.get("originalUrl") or "").strip()
    poster_url = body.get("posterUrl", "").strip()
    sources = body.get("sources", [])
    subtitles = body.get("subtitles", [])

    if not title or not orig_url or not sources:
        raise HTTPException(status_code=400, detail="Title, Original URL, and Stream sources are required")

    clean_slug = re.sub(r"[^a-z0-9-_]", "-", slug) if slug else link["slug"]
    if clean_slug != link["slug"]:
        existing = await db.links.find_one({"slug": clean_slug})
        if existing and existing.get("id") != link.get("id"):
            raise HTTPException(status_code=400, detail="Slug already exists. Please choose another slug.")

    host_type = "other"
    lower_u = orig_url.lower()
    if "vk.com" in lower_u or "vk.ru" in lower_u or "vkvideo.ru" in lower_u:
        host_type = "vk"
    elif "ok.ru" in lower_u or "odnoklassniki.ru" in lower_u:
        host_type = "okru"
    elif "sibnet.ru" in lower_u:
        host_type = "sibnet"

    now_iso = datetime.now(timezone.utc).isoformat()
    updated_doc = {
        "title": title,
        "slug": clean_slug,
        "originalUrl": orig_url,
        "posterUrl": poster_url,
        "sources": sources,
        "subtitles": subtitles,
        "hostType": host_type,
        "updatedAt": now_iso
    }

    await db.links.update_one({"id": link["id"]}, {"$set": updated_doc})
    final_doc = await db.links.find_one({"id": link["id"]}, {"_id": 0})
    return final_doc

@app.delete("/api/links/{link_id}")
async def delete_link(link_id: str = FPath(...)):
    res = await db.links.delete_one({"$or": [{"id": link_id}, {"slug": link_id}]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Link not found")
    return {"success": True, "message": "Link deleted successfully"}
