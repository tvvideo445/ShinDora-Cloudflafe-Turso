import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  Play, Shield, Zap, Sparkles, Layers, ArrowRight, Video, 
  ExternalLink, Download, Subtitles, CheckCircle2, ChevronRight 
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';

export default function LandingPage() {
  const [stats, setStats] = useState({ totalVideos: 0, vkCount: 0, okCount: 0, sibnetCount: 0 });

  useEffect(() => {
    fetch('/api/stats')
      .then(res => res.json())
      .then(data => {
        if (data.stats) setStats(data.stats);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-between selection:bg-primary/20">
      {/* Navigation Header */}
      <header className="border-b border-border/40 backdrop-blur-md sticky top-0 z-50 bg-background/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-primary to-blue-500 flex items-center justify-center text-primary-foreground font-black shadow-lg shadow-primary/20">
              <Play className="h-4 w-4 fill-current ml-0.5" />
            </div>
            <span className="font-extrabold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground via-foreground/90 to-muted-foreground">
              ShinDora Stream
            </span>
          </div>

          <div className="flex items-center gap-3">
            <Link to="/login">
              <Button data-testid="nav-login-btn" variant="ghost" size="sm" className="font-semibold text-xs sm:text-sm">
                Admin Login
              </Button>
            </Link>
            <Link to="/dashboard">
              <Button data-testid="nav-dashboard-btn" size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs sm:text-sm shadow-md gap-1.5">
                Dashboard <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-20 flex flex-col justify-center">
        <div className="text-center space-y-6 max-w-3xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold tracking-wide">
            <Sparkles className="h-3.5 w-3.5" /> SHINDORA FINAL VERSION · CLOUDFLARE WORKER READY
          </div>

          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1]">
            Next-Gen Video Stream & Proxy CDN Engine
          </h1>

          <p className="text-muted-foreground text-sm sm:text-lg leading-relaxed">
            Streaming video instan dari <strong className="text-foreground">VK Video</strong>, <strong className="text-foreground">OK.ru</strong>, dan <strong className="text-foreground">Sibnet</strong> dengan JWPlayer 8, Multi-Layer VAST Ads, Otomatis 24h Token Recovery, serta Direct Download Proxy berkecepatan tinggi.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4 pt-4">
            <Link to="/dashboard">
              <Button data-testid="hero-get-started-btn" size="lg" className="bg-primary hover:bg-primary/90 text-primary-foreground font-extrabold text-base px-8 shadow-xl shadow-primary/20 gap-2">
                Buka Dashboard <ArrowRight className="h-5 w-5" />
              </Button>
            </Link>
            <Link to="/login">
              <Button data-testid="hero-login-btn" size="lg" variant="outline" className="border-border hover:bg-muted/50 font-bold text-base px-6">
                Masuk sebagai Admin
              </Button>
            </Link>
          </div>

          {/* Live Quick Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-10 text-left">
            <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
              <div className="text-2xl font-black text-primary">{stats.totalVideos}</div>
              <div className="text-xs text-muted-foreground font-medium mt-0.5">Total Video Tersimpan</div>
            </div>
            <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
              <div className="text-2xl font-black text-blue-500">{stats.vkCount}</div>
              <div className="text-xs text-muted-foreground font-medium mt-0.5">VK Video Streams</div>
            </div>
            <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
              <div className="text-2xl font-black text-amber-500">{stats.okCount}</div>
              <div className="text-xs text-muted-foreground font-medium mt-0.5">OK.ru Streams</div>
            </div>
            <div className="p-4 rounded-2xl bg-card border border-border shadow-sm">
              <div className="text-2xl font-black text-purple-500">{stats.sibnetCount}</div>
              <div className="text-xs text-muted-foreground font-medium mt-0.5">Sibnet Streams</div>
            </div>
          </div>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-16">
          <Card className="border-border bg-card/60 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <div className="h-10 w-10 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center mb-2">
                <Zap className="h-5 w-5" />
              </div>
              <CardTitle className="text-lg">Cloudflare Worker Proxy</CardTitle>
              <CardDescription>
                Streaming bebas CORS dan 100% bypass outbound bandwidth ke Cloudflare Edge secara efisien.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="border-border bg-card/60 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <div className="h-10 w-10 rounded-xl bg-amber-500/10 text-amber-500 flex items-center justify-center mb-2">
                <Layers className="h-5 w-5" />
              </div>
              <CardTitle className="text-lg">VAST / VMAP Waterfall Ads</CardTitle>
              <CardDescription>
                Mendukung monetisasi video VAST 2.0-4.2, VMAP, banner overlay, popup trigger, dan custom skip offset.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card className="border-border bg-card/60 backdrop-blur-sm hover:border-primary/40 transition-all duration-300">
            <CardHeader>
              <div className="h-10 w-10 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center mb-2">
                <Shield className="h-5 w-5" />
              </div>
              <CardTitle className="text-lg">Auto Token 24h Refresh</CardTitle>
              <CardDescription>
                Penyegaran token expired otomatis saat pemutaran atau lewat background Cron scheduled triggers.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 py-6 text-center text-xs text-muted-foreground">
        ShinDora Stream Engine &copy; 2026. All rights reserved.
      </footer>
    </div>
  );
}
