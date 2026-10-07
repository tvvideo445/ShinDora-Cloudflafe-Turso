import React, { useState, useEffect } from 'react';
import { 
  DollarSign, Plus, Trash2, Play, Sparkles, CheckCircle2, 
  AlertCircle, ExternalLink, ShieldCheck, RefreshCw, Eye
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { useToast } from '../hooks/use-toast';

export function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  if (timeStr === 'pre') return 0;
  if (timeStr === 'post') return 999999;
  const parts = String(timeStr).split(':').map(p => parseInt(p, 10) || 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parseInt(timeStr, 10) || 0;
}

export default function VastAdsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vastEnabled, setVastEnabled] = useState(false);
  const [vastTags, setVastTags] = useState([]);
  
  // Live tester
  const [testUrl, setTestUrl] = useState('https://raw.githubusercontent.com/InteractiveAdvertisingBureau/VAST_Samples/master/VAST%204.0%20Samples/Inline_Linear_Tag-test.xml');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const { toast } = useToast();

  useEffect(() => {
    async function fetchSettings() {
      try {
        const res = await fetch('/api/settings', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.player) {
            setVastEnabled(!!data.player.vastEnabled);
            setVastTags(data.player.vastTags || []);
          }
        }
      } catch (e) {
      } finally {
        setLoading(false);
      }
    }
    fetchSettings();
  }, []);

  const handleAddTag = () => {
    setVastTags(prev => [
      ...prev,
      {
        id: `tag_${Date.now()}`,
        name: `Ad Break #${prev.length + 1}`,
        adType: 'vast',
        offset: prev.length === 0 ? 'pre' : 'mid',
        customTime: prev.length === 0 ? '00:00' : '05:00',
        tagUrl: '',
        skipOffsetSeconds: 5,
        enabled: true,
        fallbackTags: [],
      }
    ]);
  };

  const handleRemoveTag = (index) => {
    setVastTags(prev => prev.filter((_, i) => i !== index));
  };

  const handleTagChange = (index, field, value) => {
    setVastTags(prev => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          settingsType: 'player',
          vastEnabled,
          vastTags,
        }),
      });

      if (res.ok) {
        toast({
          title: 'Pengaturan VAST Disimpan!',
          description: `Berhasil memperbarui ${vastTags.length} konfigurasi slot iklan.`,
        });
      } else {
        toast({ title: 'Gagal Menyimpan', description: 'Terjadi kesalahan.', variant: 'destructive' });
      }
    } catch (e) {
      toast({ title: 'Error', description: 'Gagal menghubungi server.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleTestTag = async () => {
    if (!testUrl.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/vast-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: testUrl }),
      });
      const data = await res.json();
      setTestResult(data);
      if (res.ok && data.success) {
        toast({ title: 'VAST Tag Valid!', description: 'Media file & tracking beacons terurai sempurna.' });
      } else {
        toast({ title: 'Pengujian Gagal', description: data.error || 'Bukan format VAST XML valid.', variant: 'destructive' });
      }
    } catch (e) {
      setTestResult({ success: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20 min-h-[60vh]">
        <RefreshCw className="h-8 w-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in-50 duration-300">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-2.5">
            <DollarSign className="h-7 w-7 text-primary" /> VAST / VMAP Ads Engine
          </h1>
          <p className="text-muted-foreground text-xs sm:text-sm mt-1">
            Konfigurasi monetisasi video dengan VAST 2.0-4.2 Waterfall, Banner Overlay, dan Popup Triggers
          </p>
        </div>

        <Button
          data-testid="save-vast-settings-btn"
          onClick={handleSave}
          disabled={saving}
          className="bg-primary hover:bg-primary/90 text-primary-foreground font-extrabold text-xs shadow-md"
        >
          {saving ? 'Menyimpan...' : 'Simpan Semua Konfigurasi Iklan'}
        </Button>
      </div>

      {/* Global Toggle */}
      <Card className="border-border bg-card">
        <CardContent className="p-4 flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="vast-main-toggle" className="text-sm font-bold text-foreground cursor-pointer">
              Aktifkan Mesin VAST Video Ads
            </Label>
            <p className="text-xs text-muted-foreground">
              Ketika aktif, semua video player embed akan menampilkan iklan sesuai slot yang dikonfigurasi.
            </p>
          </div>
          <input
            type="checkbox"
            id="vast-main-toggle"
            data-testid="vast-enabled-toggle"
            checked={vastEnabled}
            onChange={(e) => setVastEnabled(e.target.checked)}
            className="rounded border-border text-primary focus:ring-primary h-5 w-5 cursor-pointer"
          />
        </CardContent>
      </Card>

      {/* Ad Breaks Slot List */}
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-bold">Slot Iklan Terpasang ({vastTags.length})</h2>
          <Button
            type="button"
            data-testid="add-ad-break-btn"
            variant="outline"
            size="sm"
            onClick={handleAddTag}
            className="text-xs font-semibold gap-1.5 border-primary/30 text-primary hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" /> + Tambah Slot Iklan
          </Button>
        </div>

        {vastTags.length === 0 ? (
          <Card className="border-dashed border-border bg-card/40 p-8 text-center space-y-3">
            <DollarSign className="h-10 w-10 text-muted-foreground/40 mx-auto" />
            <div className="text-sm font-bold">Belum Ada Slot Iklan</div>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Tambahkan URL tag VAST dari jaringan iklan seperti HilltopAds, Monetag, PropellerAds, atau Google IMA.
            </p>
            <Button size="sm" onClick={handleAddTag} className="bg-primary text-primary-foreground font-bold text-xs">
              <Plus className="h-3.5 w-3.5 mr-1" /> Buat Slot Iklan Pertama
            </Button>
          </Card>
        ) : (
          <div className="space-y-4">
            {vastTags.map((tag, index) => (
              <Card key={tag.id || index} className="border-border bg-card">
                <CardHeader className="bg-muted/30 pb-3 flex flex-row items-center justify-between space-y-0">
                  <div className="flex items-center gap-3">
                    <span className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-xs">
                      #{index + 1}
                    </span>
                    <Input
                      type="text"
                      value={tag.name}
                      onChange={(e) => handleTagChange(index, 'name', e.target.value)}
                      className="h-7 w-48 text-xs font-bold bg-background border-border"
                      placeholder="Nama Slot Iklan"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tag.enabled !== false}
                        onChange={(e) => handleTagChange(index, 'enabled', e.target.checked)}
                        className="rounded text-primary h-4 w-4"
                      />
                      <span>Aktif</span>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveTag(index)}
                      className="h-7 px-2 text-destructive hover:bg-destructive/10 text-xs"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="pt-4 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs font-bold text-muted-foreground uppercase">Tipe Iklan</Label>
                      <select
                        value={tag.adType || 'vast'}
                        onChange={(e) => handleTagChange(index, 'adType', e.target.value)}
                        className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2 font-semibold"
                      >
                        <option value="vast">Linear VAST / VMAP Video Ad</option>
                        <option value="overlay">Banner Overlay</option>
                        <option value="popup">On-Click Popup Trigger</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs font-bold text-muted-foreground uppercase">Offset Waktu Tayang</Label>
                      <select
                        value={tag.offset || 'pre'}
                        onChange={(e) => handleTagChange(index, 'offset', e.target.value)}
                        className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2 font-semibold"
                      >
                        <option value="pre">Preroll (Awal Video 00:00)</option>
                        <option value="mid">Midroll (Menit Tertentu)</option>
                        <option value="post">Postroll (Akhir Video)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-xs font-bold text-muted-foreground uppercase">
                        Skip Offset (Detik, Min 5s)
                      </Label>
                      <Input
                        type="number"
                        min="5"
                        value={tag.skipOffsetSeconds ?? 5}
                        onChange={(e) => handleTagChange(index, 'skipOffsetSeconds', Math.max(5, parseInt(e.target.value, 10) || 5))}
                        className="text-xs bg-background"
                      />
                    </div>
                  </div>

                  {tag.offset === 'mid' && (
                    <div className="space-y-1">
                      <Label className="text-xs font-bold text-muted-foreground uppercase">Menit Midroll (MM:SS)</Label>
                      <Input
                        type="text"
                        placeholder="05:00"
                        value={tag.customTime || '05:00'}
                        onChange={(e) => handleTagChange(index, 'customTime', e.target.value)}
                        className="text-xs bg-background font-mono w-32"
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    <Label className="text-xs font-bold text-muted-foreground uppercase">Primary VAST Tag URL</Label>
                    <Input
                      type="url"
                      placeholder="https://vast.adnetwork.com/tag.xml"
                      value={tag.tagUrl || ''}
                      onChange={(e) => handleTagChange(index, 'tagUrl', e.target.value)}
                      className="text-xs bg-background font-mono"
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Live VAST Tester Card */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Live VAST Tag Tester
          </CardTitle>
          <CardDescription className="text-xs">
            Uji dan verifikasi tag XML iklan sebelum dipasang di video player
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              type="url"
              data-testid="vast-test-url-input"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              placeholder="Masukkan URL VAST Tag XML..."
              className="text-xs bg-background font-mono"
            />
            <Button
              type="button"
              data-testid="run-vast-test-btn"
              onClick={handleTestTag}
              disabled={testing}
              className="bg-primary text-primary-foreground font-bold text-xs shrink-0"
            >
              {testing ? 'Menguji...' : 'Uji Tag'}
            </Button>
          </div>

          {testResult && (
            <div className={`p-3 rounded-xl border text-xs space-y-1.5 ${
              testResult.success ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200' : 'bg-red-950/40 border-red-500/40 text-red-200'
            }`}>
              <div className="font-bold flex items-center gap-1.5">
                {testResult.success ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertCircle className="h-4 w-4 text-red-400" />}
                <span>{testResult.message || testResult.error}</span>
              </div>
              {testResult.ad && (
                <div className="font-mono text-[11px] text-zinc-300 space-y-0.5 pt-1">
                  <div>Judul Iklan: {testResult.ad.title}</div>
                  <div>Durasi: {testResult.ad.durationFormatted} ({testResult.ad.duration}s)</div>
                  <div>Skip Offset: {testResult.ad.skipOffset}s</div>
                  {testResult.ad.bestMediaFile && (
                    <div className="truncate">Media: {testResult.ad.bestMediaFile.src}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
