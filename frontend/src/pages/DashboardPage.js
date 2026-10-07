import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { 
  Plus, Search, RefreshCw, Trash2, Edit, ExternalLink, Copy, 
  Check, Play, Film, ShieldAlert, Sparkles, Download, Eye, AlertCircle,
  Clock, CheckCircle2, ChevronRight, Video
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { useToast } from '../hooks/use-toast';

export default function DashboardPage() {
  const [links, setLinks] = useState([]);
  const [stats, setStats] = useState({ totalVideos: 0, vkCount: 0, okCount: 0, sibnetCount: 0 });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [hostFilter, setHostFilter] = useState('all');
  const [refreshingSlug, setRefreshingSlug] = useState(null);
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [copiedType, setCopiedType] = useState(null);
  const [cdnUrl, setCdnUrl] = useState('');
  const [downloadCdnUrl, setDownloadCdnUrl] = useState('');
  const [isCustomDownloadCdnEnabled, setIsCustomDownloadCdnEnabled] = useState(false);
  const { toast } = useToast();

  const domain = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';

  const fetchData = useCallback(async () => {
    try {
      const [linksRes, statsRes, settingsRes] = await Promise.all([
        fetch('/api/links', { credentials: 'include' }),
        fetch('/api/stats', { credentials: 'include' }),
        fetch('/api/settings', { credentials: 'include' })
      ]);

      if (linksRes.ok) {
        const linksData = await linksRes.json();
        setLinks(linksData || []);
      }
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        if (statsData.stats) setStats(statsData.stats);
      }
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        if (settingsData.general?.cdnUrl) {
          setCdnUrl(settingsData.general.cdnUrl.replace(/\/+$/, ''));
        }
        if (settingsData.general?.downloadCdnUrl) {
          setDownloadCdnUrl(settingsData.general.downloadCdnUrl.replace(/\/+$/, ''));
        }
        if (settingsData.general?.isCustomDownloadCdnEnabled !== undefined) {
          setIsCustomDownloadCdnEnabled(!!settingsData.general.isCustomDownloadCdnEnabled);
        }
      }
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefreshSingleToken = async (slug) => {
    setRefreshingSlug(slug);
    try {
      const res = await fetch(`/api/parse-stream?slug=${slug}&force=1&t=${Date.now()}`);
      const data = await res.json();
      if (res.ok && data.success) {
        toast({
          title: 'Token Segar!',
          description: `Token untuk video "${data.title || slug}" berhasil diperbarui.`,
        });
        fetchData();
      } else {
        toast({
          title: 'Refresh Gagal',
          description: data.error || 'Gagal memperbarui token video.',
          variant: 'destructive',
        });
      }
    } catch (e) {
      toast({
        title: 'Error Koneksi',
        description: 'Gagal mengirim permintaan refresh token.',
        variant: 'destructive',
      });
    } finally {
      setRefreshingSlug(null);
    }
  };

  const handleBatchRefresh = async () => {
    setBatchRefreshing(true);
    try {
      const res = await fetch('/api/cron/refresh-tokens?hours=24&limit=50', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast({
          title: 'Penyegaran 24 Jam Selesai',
          description: data.message || `Berhasil memperbarui ${data.refreshedCount} video.`,
        });
        fetchData();
      } else {
        toast({
          title: 'Gagal Refresh Batch',
          description: data.error || 'Terjadi kesalahan cron.',
          variant: 'destructive',
        });
      }
    } catch (e) {
      toast({
        title: 'Error',
        description: 'Gagal menjalankan cron refresh token.',
        variant: 'destructive',
      });
    } finally {
      setBatchRefreshing(false);
    }
  };

  const handleDelete = async (id, title) => {
    if (!window.confirm(`Apakah Anda yakin ingin menghapus video "${title}"?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/links/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok) {
        toast({
          title: 'Video Dihapus',
          description: `Video "${title}" berhasil dihapus dari database.`,
        });
        setLinks(prev => prev.filter(l => l.id !== id && l.slug !== id));
        fetchData();
      } else {
        toast({
          title: 'Gagal Menghapus',
          description: 'Tidak dapat menghapus link video.',
          variant: 'destructive',
        });
      }
    } catch (e) {
      toast({
        title: 'Error',
        description: 'Terjadi kesalahan koneksi.',
        variant: 'destructive',
      });
    }
  };

  const copyToClipboard = (text, id, type) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setCopiedType(type);
    toast({
      title: 'Disalin!',
      description: 'Tautan berhasil disalin ke clipboard.',
    });
    setTimeout(() => {
      setCopiedId(null);
      setCopiedType(null);
    }, 2000);
  };

  const filteredLinks = links.filter(link => {
    const matchesSearch = 
      (link.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (link.slug || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (link.originalUrl || '').toLowerCase().includes(searchQuery.toLowerCase());

    if (hostFilter === 'all') return matchesSearch;
    return matchesSearch && (link.hostType === hostFilter || (link.originalUrl || '').includes(hostFilter));
  });

  const streamHost = cdnUrl || `https://${domain}`;
  const downloadHost = (isCustomDownloadCdnEnabled && downloadCdnUrl) ? downloadCdnUrl : (cdnUrl || `https://${domain}`);

  return (
    <div className="space-y-8 animate-in fade-in-50 duration-300">
      {/* Top Header & Action */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Daftar Link Video</h1>
          <p className="text-muted-foreground text-xs sm:text-sm mt-1">
            Kelola tautan streaming, otomatis token recovery, iFrame embed generator, dan direct download proxy
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <Button
            type="button"
            data-testid="batch-refresh-btn"
            variant="outline"
            size="sm"
            onClick={handleBatchRefresh}
            disabled={batchRefreshing}
            className="text-xs font-bold border-border gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${batchRefreshing ? 'animate-spin text-primary' : ''}`} />
            {batchRefreshing ? 'Menyegarkan Semua...' : 'Sync Token 24h'}
          </Button>

          <Link to="/dashboard/links/new">
            <Button
              type="button"
              data-testid="add-new-link-btn"
              size="sm"
              className="bg-primary hover:bg-primary/90 text-primary-foreground font-extrabold text-xs shadow-md gap-1.5"
            >
              <Plus className="h-4 w-4" /> Tambah Video Baru
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted-foreground uppercase">Total Videos</span>
            <Film className="h-4 w-4 text-primary" />
          </div>
          <div data-testid="stats-total-videos" className="text-2xl font-black text-foreground mt-2">{stats.totalVideos}</div>
        </div>

        <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-blue-400 uppercase">VK Video</span>
            <div className="h-2 w-2 rounded-full bg-blue-500" />
          </div>
          <div data-testid="stats-vk-videos" className="text-2xl font-black text-blue-500 mt-2">{stats.vkCount}</div>
        </div>

        <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-amber-400 uppercase">OK.ru</span>
            <div className="h-2 w-2 rounded-full bg-amber-500" />
          </div>
          <div data-testid="stats-ok-videos" className="text-2xl font-black text-amber-500 mt-2">{stats.okCount}</div>
        </div>

        <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-purple-400 uppercase">Sibnet</span>
            <div className="h-2 w-2 rounded-full bg-purple-500" />
          </div>
          <div data-testid="stats-sibnet-videos" className="text-2xl font-black text-purple-500 mt-2">{stats.sibnetCount}</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-card p-4 rounded-2xl border border-border">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            data-testid="search-video-input"
            type="text"
            placeholder="Cari judul, slug, atau URL..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-background border-border text-xs"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-xs font-bold text-muted-foreground uppercase">Filter Host:</span>
          <select
            data-testid="host-filter-select"
            value={hostFilter}
            onChange={(e) => setHostFilter(e.target.value)}
            className="bg-background border border-border text-foreground text-xs rounded-lg p-2 font-semibold"
          >
            <option value="all">Semua Host ({links.length})</option>
            <option value="vk">VK Video</option>
            <option value="okru">OK.ru</option>
            <option value="sibnet">Sibnet</option>
          </select>
        </div>
      </div>

      {/* Video Table List */}
      <Card className="border-border bg-card overflow-hidden">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-12 text-center text-muted-foreground flex flex-col items-center justify-center gap-3">
              <RefreshCw className="h-6 w-6 animate-spin text-primary" />
              <span className="text-xs font-semibold">Memuat daftar video...</span>
            </div>
          ) : filteredLinks.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <Film className="h-10 w-10 text-muted-foreground/40 mx-auto" />
              <div className="text-base font-bold text-foreground">Tidak Ada Video Ditemukan</div>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                {searchQuery ? 'Tidak ada hasil untuk pencarian Anda.' : 'Belum ada link video tersimpan. Klik tombol di bawah untuk menambahkan video baru.'}
              </p>
              {!searchQuery && (
                <Link to="/dashboard/links/new">
                  <Button size="sm" className="bg-primary text-primary-foreground font-bold text-xs mt-2">
                    <Plus className="h-3.5 w-3.5 mr-1" /> Tambah Video Pertama
                  </Button>
                </Link>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 border-b border-border text-muted-foreground uppercase font-mono text-[10px]">
                  <tr>
                    <th className="py-3 px-4">Video & Slug</th>
                    <th className="py-3 px-4">Host</th>
                    <th className="py-3 px-4">Streams</th>
                    <th className="py-3 px-4">Token & 24h Status</th>
                    <th className="py-3 px-4 text-right">Quick Links & Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredLinks.map((link) => {
                    const playerUrl = `https://${domain}/v/${link.slug}`;
                    const embedCode = `<iframe src="https://${domain}/v/${link.slug}" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen style="border:0; overflow:hidden; width:100%; height:100%;"></iframe>`;
                    const directStream = `${streamHost}/api/stream/720/${link.slug}.mp4`;
                    const directDownload = `${downloadHost}/api/download/720/${link.slug}.mp4`;

                    const updateDate = link.updatedAt || link.createdAt;
                    const hoursAgo = updateDate ? Math.floor((Date.now() - new Date(updateDate).getTime()) / (1000 * 60 * 60)) : 0;
                    const isTokenFresh = hoursAgo < 24;

                    return (
                      <tr key={link.id || link.slug} className="hover:bg-muted/30 transition-colors group">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <div className="h-10 w-16 bg-muted rounded border border-border overflow-hidden shrink-0 relative">
                              {link.posterUrl ? (
                                <img src={link.posterUrl} alt="Thumbnail" className="h-full w-full object-cover" />
                              ) : (
                                <div className="h-full w-full flex items-center justify-center text-muted-foreground/40">
                                  <Film className="h-4 w-4" />
                                </div>
                              )}
                            </div>
                            <div className="min-w-0 max-w-[240px]">
                              <div className="font-bold text-foreground truncate text-xs" title={link.title}>
                                {link.title}
                              </div>
                              <div className="font-mono text-[11px] text-primary truncate flex items-center gap-1">
                                <span>/v/{link.slug}</span>
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold uppercase ${
                            link.hostType === 'vk' ? 'bg-blue-500/10 text-blue-500 border border-blue-500/20' :
                            link.hostType === 'okru' || link.hostType === 'ok' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                            'bg-purple-500/10 text-purple-500 border border-purple-500/20'
                          }`}>
                            {link.hostType || 'VK'}
                          </span>
                        </td>

                        <td className="py-3 px-4">
                          <div className="flex flex-wrap gap-1">
                            {(link.sources || []).map((s, idx) => (
                              <span key={idx} className="bg-muted px-1.5 py-0.2 rounded text-[10px] font-mono font-semibold">
                                {s.label}
                              </span>
                            ))}
                            {link.subtitles && link.subtitles.length > 0 && (
                              <span className="bg-emerald-500/10 text-emerald-500 px-1.5 py-0.2 rounded text-[10px] font-bold">
                                {link.subtitles.length} Sub
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${isTokenFresh ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
                            <span className="text-[11px] font-medium text-muted-foreground">
                              {isTokenFresh ? `${hoursAgo}j lalu (Aktif)` : `${hoursAgo}j lalu (Perlu Sync)`}
                            </span>
                            <button
                              type="button"
                              data-testid={`refresh-token-btn-${link.slug}`}
                              onClick={() => handleRefreshSingleToken(link.slug)}
                              disabled={refreshingSlug === link.slug}
                              className="ml-1 text-primary hover:text-primary/80 transition-colors"
                              title="Penyegaran token langsung"
                            >
                              <RefreshCw className={`h-3 w-3 ${refreshingSlug === link.slug ? 'animate-spin' : ''}`} />
                            </button>
                          </div>
                        </td>

                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Copy Player Link */}
                            <Button
                              type="button"
                              data-testid={`copy-player-${link.slug}`}
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(playerUrl, link.slug, 'player')}
                              className="h-7 px-2 text-[11px] font-semibold hover:bg-primary/10 hover:text-primary gap-1"
                              title="Salin Link Player"
                            >
                              {copiedId === link.slug && copiedType === 'player' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                              <span>Player</span>
                            </Button>

                            {/* Copy Embed */}
                            <Button
                              type="button"
                              data-testid={`copy-embed-${link.slug}`}
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(embedCode, link.slug, 'embed')}
                              className="h-7 px-2 text-[11px] font-semibold hover:bg-primary/10 hover:text-primary gap-1"
                              title="Salin Kode iFrame Embed"
                            >
                              {copiedId === link.slug && copiedType === 'embed' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                              <span>Embed</span>
                            </Button>

                            {/* Copy Download Link */}
                            <Button
                              type="button"
                              data-testid={`copy-download-${link.slug}`}
                              variant="ghost"
                              size="sm"
                              onClick={() => copyToClipboard(directDownload, link.slug, 'download')}
                              className="h-7 px-2 text-[11px] font-semibold text-primary hover:bg-primary/10 gap-1"
                              title="Salin Direct Download"
                            >
                              {copiedId === link.slug && copiedType === 'download' ? <Check className="h-3 w-3 text-green-500" /> : <Download className="h-3 w-3" />}
                              <span>Download</span>
                            </Button>

                            {/* Preview Player in new tab */}
                            <a
                              href={`/v/${link.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              data-testid={`preview-link-${link.slug}`}
                              className="h-7 px-2 text-[11px] font-semibold inline-flex items-center gap-1 bg-muted hover:bg-muted/80 rounded-md transition-colors"
                              title="Buka Player Preview"
                            >
                              <Play className="h-3 w-3" />
                            </a>

                            {/* Edit */}
                            <Link to={`/dashboard/links/edit/${link.id || link.slug}`}>
                              <Button
                                type="button"
                                data-testid={`edit-link-${link.slug}`}
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                title="Edit Metadata"
                              >
                                <Edit className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                              </Button>
                            </Link>

                            {/* Delete */}
                            <Button
                              type="button"
                              data-testid={`delete-link-${link.slug}`}
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(link.id || link.slug, link.title)}
                              className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              title="Hapus Video"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
