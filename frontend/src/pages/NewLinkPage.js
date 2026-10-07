import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { 
  ArrowLeft, Video, Upload, Copy, Check, Info, Film, Sparkles, 
  Plus, Trash2, Subtitles, Globe, Download, ExternalLink, Play
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { useToast } from '../hooks/use-toast';

export default function NewLinkPage() {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [posterUrl, setPosterUrl] = useState('');
  const [sources, setSources] = useState([]);
  const [subtitles, setSubtitles] = useState([]);
  const [uploadingSubIndex, setUploadingSubIndex] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [uploadingPoster, setUploadingPoster] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // States for output card copies
  const [copiedDirect, setCopiedDirect] = useState(false);
  const [copiedPlayer, setCopiedPlayer] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [copiedDownload, setCopiedDownload] = useState(false);
  const [copiedSpecificQuality, setCopiedSpecificQuality] = useState('');
  const [outputQuality, setOutputQuality] = useState('720');

  const [domain, setDomain] = useState('localhost:3000');
  const [cdnUrl, setCdnUrl] = useState('');
  const [downloadCdnUrl, setDownloadCdnUrl] = useState('');
  const [isCustomDownloadCdnEnabled, setIsCustomDownloadCdnEnabled] = useState(false);

  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setDomain(window.location.host);
    }
  }, []);

  useEffect(() => {
    async function loadCdnSettings() {
      try {
        const res = await fetch('/api/settings', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          if (data.general?.cdnUrl) {
            setCdnUrl(data.general.cdnUrl.replace(/\/+$/, ''));
          }
          if (data.general?.downloadCdnUrl) {
            setDownloadCdnUrl(data.general.downloadCdnUrl.replace(/\/+$/, ''));
          }
          if (data.general?.isCustomDownloadCdnEnabled !== undefined) {
            setIsCustomDownloadCdnEnabled(!!data.general.isCustomDownloadCdnEnabled);
          }
        }
      } catch (e) {}
    }
    loadCdnSettings();
  }, []);

  const handleParse = async () => {
    if (!originalUrl) {
      toast({
        title: 'URL kosong',
        description: 'Silakan masukkan URL VK Video, OK.ru, atau Sibnet terlebih dahulu.',
        variant: 'destructive',
      });
      return;
    }

    setParsing(true);
    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: originalUrl }),
      });

      const data = await res.json();

      if (res.ok) {
        if (!title && data.title) setTitle(data.title);
        if (!slug && data.title) {
          const autoSlug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          setSlug(autoSlug || `video-${Date.now().toString(36)}`);
        }
        if (!posterUrl && data.posterUrl) setPosterUrl(data.posterUrl);
        setSources(data.sources || []);
        
        if (data.sources && data.sources.length > 0) {
          const firstLabel = data.sources[0].label.replace(/[^0-9]/g, '');
          if (firstLabel) setOutputQuality(firstLabel);
        }

        toast({
          title: 'Parsing Berhasil!',
          description: `Ditemukan ${data.sources?.length || 0} stream video siap digunakan.`,
        });
      } else {
        toast({
          title: 'Parsing Gagal',
          description: data.detail || data.error || 'Gagal mengekstrak video metadata.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Parsing Error',
        description: 'Koneksi ke parser endpoint gagal.',
        variant: 'destructive',
      });
    } finally {
      setParsing(false);
    }
  };

  const handlePosterUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingPoster(true);
    try {
      const authRes = await fetch('/api/imagekit-auth', { credentials: 'include' });
      if (!authRes.ok) throw new Error('Gagal mendapatkan kredensial ImageKit.');
      const authData = await authRes.json();

      if (!authData.publicKey || !authData.signature || !authData.token) {
        throw new Error('Kredensial ImageKit tidak lengkap di pengaturan.');
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileName', file.name);
      formData.append('publicKey', authData.publicKey);
      formData.append('signature', authData.signature);
      formData.append('token', authData.token);
      formData.append('expire', authData.expire);

      const uploadRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
        method: 'POST',
        body: formData,
      });

      const uploadData = await uploadRes.json();
      if (uploadRes.ok && uploadData.url) {
        setPosterUrl(uploadData.url);
        toast({
          title: 'Poster Berhasil Diupload!',
          description: 'URL poster telah diperbarui.',
        });
      } else {
        throw new Error(uploadData.message || 'ImageKit mengembalikan respons error.');
      }
    } catch (err) {
      toast({
        title: 'Upload Gagal',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setUploadingPoster(false);
    }
  };

  const handleAddSubtitle = () => {
    setSubtitles(prev => [
      ...prev,
      { label: prev.length === 0 ? 'Indonesian' : (prev.length === 1 ? 'English' : ''), file: '' }
    ]);
  };

  const handleRemoveSubtitle = (index) => {
    setSubtitles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubtitleChange = (index, field, value) => {
    setSubtitles(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const handleSubtitleUpload = async (index, e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingSubIndex(index);
    try {
      const authRes = await fetch('/api/imagekit-auth', { credentials: 'include' });
      if (!authRes.ok) throw new Error('Gagal mendapatkan kredensial ImageKit.');
      const authData = await authRes.json();

      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileName', file.name);
      formData.append('publicKey', authData.publicKey);
      formData.append('signature', authData.signature);
      formData.append('token', authData.token);
      formData.append('expire', authData.expire);

      const uploadRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
        method: 'POST',
        body: formData,
      });

      const uploadData = await uploadRes.json();
      if (uploadRes.ok && uploadData.url) {
        handleSubtitleChange(index, 'file', uploadData.url);
        if (!subtitles[index]?.label) {
          const fn = file.name.toLowerCase();
          let autoLabel = 'Subtitle';
          if (fn.includes('ind') || fn.includes('id')) autoLabel = 'Indonesian';
          else if (fn.includes('eng') || fn.includes('en')) autoLabel = 'English';
          handleSubtitleChange(index, 'label', autoLabel);
        }
        toast({
          title: 'Subtitle Diupload!',
          description: `File "${file.name}" berhasil diunggah.`,
        });
      } else {
        throw new Error(uploadData.message || 'ImageKit upload error.');
      }
    } catch (err) {
      toast({
        title: 'Upload Gagal',
        description: err.message,
        variant: 'destructive',
      });
    } finally {
      setUploadingSubIndex(null);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!title || !originalUrl || sources.length === 0) {
      toast({
        title: 'Formulir belum lengkap',
        description: 'Pastikan Anda telah melakukan "Parse Video" dan memiliki stream source.',
        variant: 'destructive',
      });
      return;
    }

    const validSubtitles = subtitles
      .map(s => ({ label: (s.label || 'Subtitle').trim(), file: s.file.trim() }))
      .filter(s => s.file);

    setSubmitting(true);
    try {
      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title,
          slug: slug.trim() || undefined,
          originalUrl,
          posterUrl,
          sources,
          subtitles: validSubtitles,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        toast({
          title: 'Link video disimpan!',
          description: `Video "${title}" berhasil ditambahkan.`,
        });
        navigate('/dashboard');
      } else {
        toast({
          title: 'Gagal Menyimpan',
          description: data.detail || data.error || 'Terjadi kesalahan saat menyimpan video link.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Error Koneksi',
        description: 'Gagal mengirim permintaan ke server.',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyText = (text, type, extraId = '') => {
    navigator.clipboard.writeText(text);
    if (type === 'direct') {
      setCopiedDirect(true);
      setTimeout(() => setCopiedDirect(false), 2000);
    } else if (type === 'player') {
      setCopiedPlayer(true);
      setTimeout(() => setCopiedPlayer(false), 2000);
    } else if (type === 'embed') {
      setCopiedEmbed(true);
      setTimeout(() => setCopiedEmbed(false), 2000);
    } else if (type === 'download') {
      setCopiedDownload(true);
      setTimeout(() => setCopiedDownload(false), 2000);
    } else if (type === 'specific-quality') {
      setCopiedSpecificQuality(extraId);
      setTimeout(() => setCopiedSpecificQuality(''), 2000);
    }
    toast({
      title: 'Disalin!',
      description: 'Berhasil disalin ke clipboard.',
    });
  };

  const displaySlug = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') || '[slug]';
  const playerLink = `https://${domain}/v/${displaySlug}`;
  const embedCode = `<iframe src="https://${domain}/v/${displaySlug}" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen style="border:0; overflow:hidden; width:100%; height:100%;"></iframe>`;

  const streamHost = cdnUrl || `https://${domain}`;
  const downloadHost = (isCustomDownloadCdnEnabled && downloadCdnUrl) ? downloadCdnUrl : (cdnUrl || `https://${domain}`);

  let directStreamLink = `${streamHost}/api/stream/${outputQuality}/${displaySlug}.mp4`;
  let directDownloadLink = `${downloadHost}/api/download/${outputQuality}/${displaySlug}.mp4`;

  return (
    <div className="space-y-8 animate-in fade-in-50 duration-300">
      <div>
        <Link to="/dashboard" className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground gap-1 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Kembali ke Daftar Link
        </Link>
        <h1 className="text-3xl font-black tracking-tight mt-2">Tambah Link Video Baru</h1>
        <p className="text-muted-foreground text-xs sm:text-sm mt-1">
          Parse video VK, OK.ru, atau Sibnet, kelola metadata & subtitle, serta dapatkan kode embed & direct download
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Form */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border bg-card">
            <form onSubmit={handleSubmit}>
              <CardHeader>
                <CardTitle className="text-lg">Metadata Video</CardTitle>
                <CardDescription className="text-xs">
                  Masukkan URL video asli untuk mengekstrak resolusi stream secara otomatis
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-5">
                {/* 1. Original URL */}
                <div className="space-y-1.5">
                  <Label htmlFor="originalUrl" className="text-xs font-bold text-muted-foreground uppercase">
                    URL Video VK / OK.ru / Sibnet
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="originalUrl"
                      data-testid="original-url-input"
                      type="url"
                      placeholder="e.g. https://vkvideo.ru/video-241161797_456239017 atau https://ok.ru/video/..."
                      value={originalUrl}
                      onChange={(e) => setOriginalUrl(e.target.value)}
                      className="bg-background border-border text-xs"
                      required
                    />
                    <Button
                      type="button"
                      data-testid="parse-video-btn"
                      onClick={handleParse}
                      disabled={parsing}
                      className="bg-primary text-primary-foreground font-bold text-xs shrink-0"
                    >
                      {parsing ? 'Parsing...' : 'Parse Video'}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Mendukung domain VK (vk.com, vkvideo.ru), OK.ru (ok.ru), dan Sibnet (video.sibnet.ru).
                  </p>
                </div>

                {/* 2. Title */}
                <div className="space-y-1.5">
                  <Label htmlFor="title" className="text-xs font-bold text-muted-foreground uppercase">Judul Video</Label>
                  <Input
                    id="title"
                    data-testid="video-title-input"
                    type="text"
                    placeholder="Judul video..."
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="bg-background border-border text-xs"
                    required
                  />
                </div>

                {/* 3. Slug */}
                <div className="space-y-1.5">
                  <Label htmlFor="slug" className="text-xs font-bold text-muted-foreground uppercase">Custom Slug</Label>
                  <Input
                    id="slug"
                    data-testid="video-slug-input"
                    type="text"
                    placeholder="e.g. video-terbaru-2026"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    className="bg-background border-border font-mono text-xs"
                  />
                </div>

                {/* 4. Poster Image */}
                <div className="space-y-1.5">
                  <Label htmlFor="posterUrl" className="text-xs font-bold text-muted-foreground uppercase">URL Poster / Thumbnail</Label>
                  <div className="space-y-2">
                    <Input
                      id="posterUrl"
                      type="text"
                      placeholder="e.g. https://ik.imagekit.io/..."
                      value={posterUrl}
                      onChange={(e) => setPosterUrl(e.target.value)}
                      className="bg-background border-border text-xs"
                    />
                    <div className="flex items-center gap-3">
                      <Label
                        htmlFor="poster-file-new"
                        className="flex items-center gap-1.5 cursor-pointer border border-dashed border-border hover:bg-muted rounded-lg p-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {uploadingPoster ? 'Mengupload...' : 'Upload Thumbnail via ImageKit'}
                        <input
                          id="poster-file-new"
                          type="file"
                          accept="image/*"
                          onChange={handlePosterUpload}
                          disabled={uploadingPoster}
                          className="hidden"
                        />
                      </Label>
                      {posterUrl && (
                        <div className="h-8 w-14 bg-muted rounded border border-border overflow-hidden shrink-0">
                          <img src={posterUrl} alt="Thumbnail preview" className="h-full w-full object-cover" />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 5. Subtitle Video */}
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="flex justify-between items-center">
                    <div>
                      <Label className="text-xs font-bold text-foreground flex items-center gap-1.5">
                        <Subtitles className="h-4 w-4 text-primary" /> Subtitle Video (Opsional)
                      </Label>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddSubtitle}
                      className="text-xs font-semibold gap-1 border-primary/30 text-primary hover:bg-primary/10 h-7"
                    >
                      <Plus className="h-3.5 w-3.5" /> Tambah Subtitle
                    </Button>
                  </div>

                  {subtitles.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-3 bg-muted/30 rounded-lg border border-dashed border-border text-center">
                      Belum ada subtitle. Klik &quot;+ Tambah Subtitle&quot; untuk menambahkan file teks (.vtt atau .srt).
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {subtitles.map((sub, index) => (
                        <div key={index} className="p-3 rounded-lg bg-muted/30 border border-border space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-primary flex items-center gap-1">
                              <Globe className="h-3 w-3" /> Subtitle #{index + 1}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveSubtitle(index)}
                              className="h-6 px-2 text-destructive hover:bg-destructive/10 text-xs"
                            >
                              <Trash2 className="h-3 w-3 mr-1" /> Hapus
                            </Button>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <Input
                              type="text"
                              placeholder='Label ("Indonesian")'
                              value={sub.label}
                              onChange={(e) => handleSubtitleChange(index, 'label', e.target.value)}
                              className="text-xs bg-background"
                            />
                            <Input
                              type="text"
                              placeholder="URL Subtitle (.vtt / .srt)"
                              value={sub.file}
                              onChange={(e) => handleSubtitleChange(index, 'file', e.target.value)}
                              className="sm:col-span-2 text-xs bg-background font-mono"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Label
                              htmlFor={`sub-upload-new-${index}`}
                              className="flex items-center gap-1 cursor-pointer bg-background hover:bg-muted border border-border rounded px-2.5 py-1 text-xs text-muted-foreground"
                            >
                              <Upload className="h-3 w-3 text-primary" />
                              {uploadingSubIndex === index ? 'Mengupload...' : 'Upload ImageKit'}
                              <input
                                id={`sub-upload-new-${index}`}
                                type="file"
                                accept=".vtt,.srt,.txt"
                                onChange={(e) => handleSubtitleUpload(index, e)}
                                disabled={uploadingSubIndex !== null}
                                className="hidden"
                              />
                            </Label>
                            {sub.file && <span className="text-[11px] text-green-500 font-medium">✓ Siap</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 6. Sources List */}
                <div className="space-y-2 pt-2 border-t border-border">
                  <Label className="text-xs font-bold text-foreground flex items-center gap-1.5">
                    <Film className="h-4 w-4 text-primary" /> Stream Sources ({sources.length})
                  </Label>
                  {sources.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-3 bg-muted/40 rounded-lg border border-border text-center">
                      Belum ada source stream. Masukkan URL dan klik &quot;Parse Video&quot;.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto border border-border rounded-lg p-2 bg-background/50">
                      {sources.map((src, index) => (
                        <div key={index} className="flex justify-between items-center bg-muted/40 p-2 rounded text-xs">
                          <span className="font-mono truncate max-w-[280px] text-[11px]">{src.file}</span>
                          <span className="bg-primary/10 text-primary px-2 py-0.5 rounded font-bold text-[10px]">
                            {src.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>

              <CardFooter className="flex justify-between border-t border-border pt-4">
                <Link to="/dashboard">
                  <Button variant="ghost" type="button" size="sm">Batal</Button>
                </Link>
                <Button
                  type="submit"
                  disabled={submitting || parsing || uploadingPoster || uploadingSubIndex !== null}
                  className="bg-primary text-primary-foreground font-bold text-xs"
                >
                  {submitting ? 'Menyimpan...' : 'Simpan Link Video'}
                </Button>
              </CardFooter>
            </form>
          </Card>
        </div>

        {/* Right Output Card */}
        <div className="space-y-6">
          <Card className="border-primary/20 bg-card shadow-md sticky top-6">
            <CardHeader className="bg-primary/5 border-b border-border">
              <CardTitle className="flex items-center gap-2 text-base font-bold">
                <Sparkles className="h-4 w-4 text-primary" /> Output Code Generator
              </CardTitle>
              <CardDescription className="text-xs">
                Link embed & streaming yang dihasilkan secara real-time
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <div className="space-y-1">
                <Label htmlFor="out-quality" className="text-xs font-bold text-muted-foreground uppercase">Kualitas Direct Link</Label>
                <select
                  id="out-quality"
                  data-testid="quality-direct-link-select"
                  value={outputQuality}
                  onChange={(e) => setOutputQuality(e.target.value)}
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2 font-medium"
                >
                  <option value="1080">1080p Full HD</option>
                  <option value="720">720p HD</option>
                  <option value="480">480p SD</option>
                  <option value="360">360p Low</option>
                  <option value="240">240p Lowest</option>
                </select>
              </div>

              {/* 1. Direct Stream */}
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-bold text-muted-foreground uppercase">1. Direct Stream Link</span>
                  <Button
                    onClick={() => handleCopyText(directStreamLink, 'direct')}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs font-semibold gap-1"
                  >
                    {copiedDirect ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedDirect ? 'Disalin' : 'Salin'}</span>
                  </Button>
                </div>
                <div className="bg-muted border border-border rounded-lg p-2.5">
                  <code className="block text-[11px] font-mono break-all text-foreground select-all">{directStreamLink}</code>
                </div>
              </div>

              {/* 2. Player Link */}
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-bold text-muted-foreground uppercase">2. Player Link</span>
                  <Button
                    onClick={() => handleCopyText(playerLink, 'player')}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs font-semibold gap-1"
                  >
                    {copiedPlayer ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedPlayer ? 'Disalin' : 'Salin'}</span>
                  </Button>
                </div>
                <div className="bg-muted border border-border rounded-lg p-2.5">
                  <code className="block text-[11px] font-mono break-all text-foreground select-all">{playerLink}</code>
                </div>
              </div>

              {/* 3. Embed iFrame */}
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-bold text-muted-foreground uppercase">3. Embed iFrame Code</span>
                  <Button
                    onClick={() => handleCopyText(embedCode, 'embed')}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs font-semibold gap-1"
                  >
                    {copiedEmbed ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedEmbed ? 'Disalin' : 'Salin'}</span>
                  </Button>
                </div>
                <div className="bg-muted border border-border rounded-lg p-2.5">
                  <code className="block text-[11px] font-mono break-all text-foreground select-all">{embedCode}</code>
                </div>
              </div>

              {/* 4. Direct Download */}
              <div className="space-y-1 pt-2 border-t border-border">
                <div className="flex justify-between items-center">
                  <span data-testid="direct-download-heading" className="text-[11px] font-bold text-primary uppercase flex items-center gap-1">
                    <Download className="h-3.5 w-3.5" /> 4. DIRECT DOWNLOAD LINK
                  </span>
                  <Button
                    data-testid="copy-download-link-btn"
                    onClick={() => handleCopyText(directDownloadLink, 'download')}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs font-semibold gap-1"
                  >
                    {copiedDownload ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedDownload ? 'Disalin' : 'Salin'}</span>
                  </Button>
                </div>
                <div className="bg-muted border border-border rounded-lg p-2.5">
                  <code data-testid="direct-download-link-output" className="block text-[11px] font-mono break-all text-foreground select-all">
                    {directDownloadLink}
                  </code>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
