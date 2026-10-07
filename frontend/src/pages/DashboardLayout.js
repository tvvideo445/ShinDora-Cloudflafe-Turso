import React, { useState } from 'react';
import { Link, useLocation, useNavigate, Outlet } from 'react-router-dom';
import { 
  Play, Video, Settings, DollarSign, LogOut, ExternalLink, 
  Menu, X, Sparkles, Layers, ShieldCheck, User, ChevronRight
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/button';
import { useToast } from '../hooks/use-toast';

export default function DashboardLayout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigation = [
    { name: 'Video Links', href: '/dashboard', icon: Video, exact: true },
    { name: 'VAST Ads Engine', href: '/dashboard/vast-ads', icon: DollarSign },
    { name: 'Settings & Cloudflare CDN', href: '/dashboard/settings', icon: Settings },
  ];

  const isActive = (item) => {
    if (item.exact) {
      return location.pathname === item.href;
    }
    return location.pathname.startsWith(item.href);
  };

  const handleLogout = async () => {
    await logout();
    toast({
      title: 'Logout Berhasil',
      description: 'Sesi admin Anda telah diakhiri.',
    });
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row">
      {/* Sidebar Desktop */}
      <aside className="hidden md:flex w-64 flex-col justify-between border-r border-border bg-card/60 p-4 shrink-0">
        <div className="space-y-6">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3 px-2 py-1">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-primary to-blue-500 flex items-center justify-center text-primary-foreground font-black shadow-md shadow-primary/20">
              <Play className="h-4 w-4 fill-current ml-0.5" />
            </div>
            <div>
              <div className="font-extrabold text-base tracking-tight leading-none">ShinDora Stream</div>
              <div className="text-[10px] text-muted-foreground font-mono mt-0.5">Admin Control Panel</div>
            </div>
          </Link>

          {/* Navigation Links */}
          <nav className="space-y-1">
            {navigation.map((item) => {
              const active = isActive(item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  data-testid={
                    item.href === '/dashboard' ? 'nav-video-links' :
                    item.href === '/dashboard/vast-ads' ? 'nav-vast-ads' :
                    'nav-settings'
                  }
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all ${
                    active
                      ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/20'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.name}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* User Card & Logout */}
        <div className="space-y-3 pt-4 border-t border-border">
          <div className="flex items-center gap-2.5 px-3 py-2 bg-muted/40 rounded-xl border border-border">
            <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-xs">
              <User className="h-4 w-4" />
            </div>
            <div className="truncate flex-1">
              <div className="text-xs font-bold truncate">{user || 'Admin'}</div>
              <div className="text-[10px] text-emerald-500 font-semibold flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Terotentikasi
              </div>
            </div>
          </div>

          <Button
            type="button"
            data-testid="sidebar-logout-btn"
            variant="outline"
            size="sm"
            onClick={handleLogout}
            className="w-full text-xs font-bold text-destructive hover:bg-destructive/10 hover:text-destructive border-border gap-2"
          >
            <LogOut className="h-3.5 w-3.5" /> Keluar (Logout)
          </Button>
        </div>
      </aside>

      {/* Mobile Header */}
      <header className="md:hidden border-b border-border bg-card/80 backdrop-blur-md sticky top-0 z-40 px-4 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
            <Play className="h-3.5 w-3.5 fill-current ml-0.5" />
          </div>
          <span className="font-extrabold text-sm">ShinDora Stream</span>
        </Link>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-1.5"
        >
          {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </header>

      {/* Mobile Dropdown Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-border bg-card p-4 space-y-2 z-30">
          {navigation.map((item) => (
            <Link
              key={item.name}
              to={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-bold hover:bg-muted"
            >
              <item.icon className="h-4 w-4" />
              <span>{item.name}</span>
            </Link>
          ))}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleLogout}
            className="w-full text-xs font-bold mt-2"
          >
            <LogOut className="h-3.5 w-3.5 mr-2" /> Logout
          </Button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
        {children || <Outlet />}
      </main>
    </div>
  );
}
