import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Play, Lock, User, Eye, EyeOff, ShieldCheck, ArrowRight, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { useToast } from '../hooks/use-toast';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      toast({
        title: 'Formulir belum lengkap',
        description: 'Silakan isi username dan password.',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      await login(username, password, remember);
      toast({
        title: 'Login Berhasil!',
        description: `Selamat datang kembali, ${username}!`,
      });
      navigate('/dashboard');
    } catch (err) {
      toast({
        title: 'Login Gagal',
        description: err.message || 'Username atau password salah.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col justify-center items-center p-4 selection:bg-primary/20 relative overflow-hidden">
      {/* Background Glow */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md animate-in fade-in zoom-in-95 duration-300 z-10">
        <div className="text-center mb-6 space-y-2">
          <Link to="/" className="inline-flex items-center gap-2.5 group">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-tr from-primary to-blue-500 flex items-center justify-center text-primary-foreground shadow-lg shadow-primary/25 group-hover:scale-105 transition-transform">
              <Play className="h-5 w-5 fill-current ml-0.5" />
            </div>
            <span className="font-black text-2xl tracking-tight">ShinDora Stream</span>
          </Link>
          <p className="text-xs text-muted-foreground">Admin Authentication & Management Control</p>
        </div>

        <Card className="border-border bg-card/90 backdrop-blur-xl shadow-2xl">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-xl font-extrabold tracking-tight">Masuk ke Dashboard</CardTitle>
            <CardDescription className="text-xs">
              Masukkan kredensial akun administrator ShinDora Anda
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="username" className="text-xs font-bold text-muted-foreground uppercase">Username</Label>
                <div className="relative">
                  <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="username"
                    data-testid="login-username-input"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    className="pl-9 bg-background border-border"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <Label htmlFor="password" data-testid="login-password-label" className="text-xs font-bold text-muted-foreground uppercase">Password</Label>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    data-testid="login-password-input"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="pl-9 pr-10 bg-background border-border font-mono"
                    required
                  />
                  <button
                    type="button"
                    data-testid="toggle-password-visibility-btn"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center space-x-2 pt-1">
                <input
                  type="checkbox"
                  id="remember"
                  data-testid="remember-me-checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                />
                <label htmlFor="remember" className="text-xs text-muted-foreground font-medium cursor-pointer">
                  Ingat sesi login saya
                </label>
              </div>
            </CardContent>

            <CardFooter className="pt-2">
              <Button
                type="submit"
                data-testid="login-submit-button"
                disabled={loading}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-extrabold text-sm py-2.5 shadow-lg shadow-primary/20 gap-2"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {loading ? 'Memproses Masuk...' : 'Masuk ke Dashboard'}
              </Button>
            </CardFooter>
          </form>
        </Card>

        <div className="text-center mt-6">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            &larr; Kembali ke Halaman Utama
          </Link>
        </div>
      </div>
    </div>
  );
}
