import React, { useState, useEffect } from 'react';
import { 
  Settings, Play, Shield, Cloud, Key, User, Save, RefreshCw, 
  CheckCircle2, AlertCircle, ExternalLink, ShieldAlert, Sparkles, Server
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { useToast } from '../hooks/use-toast';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // Settings states
  const [playerType, setPlayerType] = useState('jwplayer');
  const [autoplay, setAutoplay] = useState(true);
  const [isAdblockEnabled, setIsAdblockEnabled] = useState(false);

  // Cloudflare CDN
  const [cdnUrl, setCdnUrl] = useState('');
  const [downloadCdnUrl, setDownloadCdnUrl] = useState('');
  const [isCustomDownloadCdnEnabled, setIsCustomDownloadCdnEnabled] = useState(false);
  const [vkServiceToken, setVkServiceToken] = useState('');

  // ImageKit
  const [imagekitPublic, setImagekitPublic] = useState('');
  const [imagekitPrivate, setImagekitPrivate] = useState('');
  const [imagekitEndpoint, setImagekitEndpoint] = useState('');

  // Admin Account
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminPassword, setAdminPassword] = useState('');

  const loadSettings = async () => {
    try {
      const res = await fetch('/api/settings', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.player) {
          setPlayerType(data.player.playerType || 'jwplayer');
          setAutoplay(data.player.autoplay !== undefined ? data.player.autoplay : true);
          setIsAdblockEnabled(!!data.player.isAdblockEnabled);
        }
        if (data.general) {
          setCdnUrl(data.general.cdnUrl || '');
          setDownloadCdnUrl(data.general.downloadCdnUrl || '');
          setIsCustomDownloadCdnEnabled(!!data.general.isCustomDownloadCdnEnabled);
          setVkServiceToken(data.general.vkServiceToken || '');
        }
        if (data.imagekit) {
          setImagekitPublic(data.imagekit.publicKey || '');
          setImagekitEndpoint(data.imagekit.urlEndpoint || '');
          if (data.imagekit.hasPrivateKey) {
            setImagekitPrivate('●●●●●');
          }
        }
        if (data.admin) {
          setAdminUsername(data.admin.username || 'admin');
        }
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const savePlayerSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          settingsType: 'player',
          playerType,
          autoplay,
          isAdblockEnabled,
        }),
      });
      if (res.ok) {
        toast({ title: 'Pengaturan Player Disimpan!', description: 'Preferensi player berhasil diperbarui.' });
      }
    } catch (e) {
      toast({ title: 'Gagal Menyimpan', description: 'Terjadi kesalahan.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const saveGeneralSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          settingsType: 'general',
          cdnUrl: cdnUrl.trim().replace(/\/+$/, ''),
          downloadCdnUrl: downloadCdnUrl.trim().replace(/\/+$/, ''),
          isCustomDownloadCdnEnabled,
          vkServiceToken: vkServiceToken.trim(),
        }),
      });
      if (res.ok) {
        toast({ title: 'Pengaturan CDN Disimpan!', description: 'Konfigurasi Cloudflare CDN & VK Token berhasil disimpan.' });
      }
    } catch (e) {
      toast({ title: 'Gagal Menyimpan', description: 'Terjadi kesalahan.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const saveImageKitSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          settingsType: 'imagekit',
          publicKey: imagekitPublic.trim(),
          privateKey: imagekitPrivate.trim(),
          urlEndpoint: imagekitEndpoint.trim(),
        }),
      });
      if (res.ok) {
        toast({ title: 'Pengaturan ImageKit Disimpan!', description: 'Kredensial SDK ImageKit berhasil diperbarui.' });
      }
    } catch (e) {
      toast({ title: 'Gagal Menyimpan', description: 'Terjadi kesalahan.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const saveAdminSettings = async () => {
    if (!adminUsername || !adminPassword) {
      toast({ title: 'Data belum lengkap', description: 'Username dan password baru wajib diisi.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          settingsType: 'admin',
          username: adminUsername.trim(),
          password: adminPassword.trim(),
        }),
      });
      if (res.ok) {
        toast({ title: 'Kredensial Admin Diperbarui!', description: 'Password akun admin berhasil diubah.' });
        setAdminPassword('');
      }
    } catch (e) {
      toast({ title: 'Gagal Mengubah', description: 'Terjadi kesalahan.', variant: 'destructive' });
    } finally {
      setSaving(false);
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
      <div>
        <h1 className="text-3xl font-black tracking-tight">Pengaturan & Cloudflare CDN</h1>
        <p className="text-muted-foreground text-xs sm:text-sm mt-1">
          Konfigurasi player engine, domain Cloudflare Worker streaming/download, ImageKit SDK, dan akun admin
        </p>
      </div>

      <Tabs defaultValue="cdn" className="space-y-6">
        <TabsList className="bg-card border border-border p-1 rounded-xl flex flex-wrap h-auto gap-1">
          <TabsTrigger value="cdn" data-testid="tab-cdn" className="text-xs font-bold gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <Cloud className="h-3.5 w-3.5" /> CDN Cloudflare
          </TabsTrigger>
          <TabsTrigger value="player" data-testid="tab-player" className="text-xs font-bold gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <Play className="h-3.5 w-3.5" /> JW Player
          </TabsTrigger>
          <TabsTrigger value="imagekit" data-testid="tab-imagekit" className="text-xs font-bold gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <Key className="h-3.5 w-3.5" /> ImageKit SDK
          </TabsTrigger>
          <TabsTrigger value="admin" data-testid="tab-admin" className="text-xs font-bold gap-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <User className="h-3.5 w-3.5" /> Akun Admin
          </TabsTrigger>
        </TabsList>

        {/* 1. CDN Cloudflare Tab */}
        <TabsContent value="cdn" className="space-y-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Cloud className="h-5 w-5 text-primary" /> Cloudflare Worker CDN Integration
              </CardTitle>
              <CardDescription className="text-xs">
                Hubungkan domain custom Cloudflare Worker Anda untuk membypass 100% outbound traffic dan storage serverless
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="cdnUrl" className="text-xs font-bold text-muted-foreground uppercase">
                  1. Stream CDN / Cloudflare Worker URL
                </Label>
                <Input
                  id="cdnUrl"
                  data-testid="cdn-url-input"
                  type="url"
                  placeholder="e.g. https://cdn.domainanda.com atau https://shindora-stream.workers.dev"
                  value={cdnUrl}
                  onChange={(e) => setCdnUrl(e.target.value)}
                  className="bg-background border-border text-xs font-mono"
                />
                <p className="text-[11px] text-muted-foreground">
                  Semua video player dan direct streaming akan menggunakan domain worker ini.
                </p>
              </div>

              <div className="space-y-3 pt-3 border-t border-border">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="customDownloadCdn"
                    data-testid="custom-download-cdn-toggle"
                    checked={isCustomDownloadCdnEnabled}
                    onChange={(e) => setIsCustomDownloadCdnEnabled(e.target.checked)}
                    className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                  />
                  <label htmlFor="customDownloadCdn" className="text-xs font-bold text-foreground cursor-pointer">
                    Gunakan Dedicated Download CDN (Worker Download Terpisah)
                  </label>
                </div>

                {isCustomDownloadCdnEnabled && (
                  <div className="space-y-1.5 pl-6 animate-in fade-in-50 duration-200">
                    <Label htmlFor="downloadCdnUrl" className="text-xs font-bold text-muted-foreground uppercase">
                      2. Dedicated Download CDN URL
                    </Label>
                    <Input
                      id="downloadCdnUrl"
                      data-testid="download-cdn-url-input"
                      type="url"
                      placeholder="e.g. https://download.domainanda.com"
                      value={downloadCdnUrl}
                      onChange={(e) => setDownloadCdnUrl(e.target.value)}
                      className="bg-background border-border text-xs font-mono"
                    />
                  </div>
                )}
              </div>

              <div className="space-y-1.5 pt-3 border-t border-border">
                <Label htmlFor="vkServiceToken" className="text-xs font-bold text-muted-foreground uppercase">
                  3. VK Service Access Token (Opsional)
                </Label>
                <Input
                  id="vkServiceToken"
                  data-testid="vk-service-token-input"
                  type="password"
                  placeholder="VK Service Token untuk resolusi 1080p Full HD"
                  value={vkServiceToken}
                  onChange={(e) => setVkServiceToken(e.target.value)}
                  className="bg-background border-border text-xs font-mono"
                />
              </div>
            </CardContent>

            <CardFooter className="border-t border-border pt-4">
              <Button
                data-testid="save-cdn-settings-btn"
                onClick={saveGeneralSettings}
                disabled={saving}
                className="bg-primary text-primary-foreground font-bold text-xs"
              >
                {saving ? 'Menyimpan...' : 'Simpan Pengaturan CDN'}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        {/* 2. JW Player Tab */}
        <TabsContent value="player" className="space-y-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Play className="h-5 w-5 text-primary" /> Pengaturan JW Player 8
              </CardTitle>
              <CardDescription className="text-xs">
                Konfigurasi engine pemutar video default, autoplay, dan detektor AdBlock
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="playerEngine" className="text-xs font-bold text-muted-foreground uppercase">
                  Default Player Engine
                </Label>
                <select
                  id="playerEngine"
                  data-testid="player-engine-select"
                  value={playerType}
                  onChange={(e) => setPlayerType(e.target.value)}
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 font-semibold"
                >
                  <option value="jwplayer">JWPlayer 8 (Recommended - Custom Seeker, HLS, Subtitle)</option>
                  <option value="videojs">Video.js HTML5 Player</option>
                </select>
              </div>

              <div className="flex items-center space-x-2 pt-2">
                <input
                  type="checkbox"
                  id="autoplay"
                  data-testid="autoplay-toggle"
                  checked={autoplay}
                  onChange={(e) => setAutoplay(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                />
                <label htmlFor="autoplay" className="text-xs font-bold text-foreground cursor-pointer">
                  Autoplay Video Saat Halaman Dibuka (Muted Fallback Aktif)
                </label>
              </div>

              <div className="flex items-center space-x-2 pt-2">
                <input
                  type="checkbox"
                  id="adblockDetector"
                  data-testid="adblock-detector-toggle"
                  checked={isAdblockEnabled}
                  onChange={(e) => setIsAdblockEnabled(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                />
                <label htmlFor="adblockDetector" className="text-xs font-bold text-foreground cursor-pointer flex items-center gap-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 text-red-400" /> Aktifkan Multi-Layer AdBlock Detector Modal
                </label>
              </div>
            </CardContent>

            <CardFooter className="border-t border-border pt-4">
              <Button
                data-testid="save-player-settings-btn"
                onClick={savePlayerSettings}
                disabled={saving}
                className="bg-primary text-primary-foreground font-bold text-xs"
              >
                {saving ? 'Menyimpan...' : 'Simpan Pengaturan Player'}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        {/* 3. ImageKit Tab */}
        <TabsContent value="imagekit" className="space-y-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Key className="h-5 w-5 text-primary" /> ImageKit Media Storage SDK
              </CardTitle>
              <CardDescription className="text-xs">
                Kredensial ImageKit untuk upload poster thumbnail dan file subtitle (.vtt/.srt)
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ikPublic" className="text-xs font-bold text-muted-foreground uppercase">Public Key</Label>
                <Input
                  id="ikPublic"
                  data-testid="imagekit-public-key-input"
                  type="text"
                  placeholder="public_..."
                  value={imagekitPublic}
                  onChange={(e) => setImagekitPublic(e.target.value)}
                  className="bg-background border-border text-xs font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ikPrivate" className="text-xs font-bold text-muted-foreground uppercase">Private Key</Label>
                <Input
                  id="ikPrivate"
                  data-testid="imagekit-private-key-input"
                  type="password"
                  placeholder="private_..."
                  value={imagekitPrivate}
                  onChange={(e) => setImagekitPrivate(e.target.value)}
                  className="bg-background border-border text-xs font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ikEndpoint" className="text-xs font-bold text-muted-foreground uppercase">URL Endpoint</Label>
                <Input
                  id="ikEndpoint"
                  data-testid="imagekit-url-endpoint-input"
                  type="text"
                  placeholder="https://ik.imagekit.io/your_id"
                  value={imagekitEndpoint}
                  onChange={(e) => setImagekitEndpoint(e.target.value)}
                  className="bg-background border-border text-xs font-mono"
                />
              </div>
            </CardContent>

            <CardFooter className="border-t border-border pt-4">
              <Button
                data-testid="save-imagekit-settings-btn"
                onClick={saveImageKitSettings}
                disabled={saving}
                className="bg-primary text-primary-foreground font-bold text-xs"
              >
                {saving ? 'Menyimpan...' : 'Simpan Kredensial ImageKit'}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>

        {/* 4. Admin Account Tab */}
        <TabsContent value="admin" className="space-y-6">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <User className="h-5 w-5 text-primary" /> Pengaturan Akun Administrator
              </CardTitle>
              <CardDescription className="text-xs">
                Perbarui username atau password login dashboard
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="adminUser" className="text-xs font-bold text-muted-foreground uppercase">Username</Label>
                <Input
                  id="adminUser"
                  data-testid="admin-username-input"
                  type="text"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  className="bg-background border-border text-xs font-bold"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="adminPass" className="text-xs font-bold text-muted-foreground uppercase">Password Baru</Label>
                <Input
                  id="adminPass"
                  data-testid="admin-password-input"
                  type="password"
                  placeholder="Masukkan password baru..."
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  className="bg-background border-border text-xs font-mono"
                  required
                />
              </div>
            </CardContent>

            <CardFooter className="border-t border-border pt-4">
              <Button
                data-testid="save-admin-settings-btn"
                onClick={saveAdminSettings}
                disabled={saving}
                className="bg-primary text-primary-foreground font-bold text-xs"
              >
                {saving ? 'Menyimpan...' : 'Simpan Perubahan Akun'}
              </Button>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
