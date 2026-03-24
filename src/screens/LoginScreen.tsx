import { useState } from 'react';
import { supabase } from '../lib/supabase';

interface LoginScreenProps {
  onLogin: (token: string, userId: string, email: string) => void;
}

type Mode = 'login' | 'forgot' | 'forgot-sent';

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');

  const resolveEmail = async (input: string): Promise<string> => {
    if (input.includes('@')) return input;

    const { data, error: queryError } = await supabase
      .from('photographer_profiles')
      .select('email')
      .eq('subdomain', input.toLowerCase().trim())
      .single();

    if (queryError || !data) {
      throw new Error('שם המשתמש לא נמצא');
    }

    return data.email as string;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const email = await resolveEmail(identifier);
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        throw new Error(authError.message === 'Invalid login credentials'
          ? 'שם משתמש או סיסמה שגויים'
          : authError.message);
      }

      if (!data.session) {
        throw new Error('לא התקבלה תגובה מהשרת');
      }

      await window.electronAPI.store.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user_id: data.session.user.id,
        email: data.session.user.email || email,
      });

      onLogin(
        data.session.access_token,
        data.session.user.id,
        data.session.user.email || email
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בהתחברות');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const email = await resolveEmail(forgotEmail.trim());
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://www.pix-online.com/reset-password',
      });

      if (resetError) throw new Error(resetError.message);

      setMode('forgot-sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בשליחת המייל');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-dark-bg relative overflow-hidden">
      {/* Background decorative elements */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-20%] right-[-10%] w-[500px] h-[500px] bg-brand-primary/[0.06] rounded-full blur-3xl" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[400px] h-[400px] bg-brand-hover/[0.06] rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-sm px-8 relative z-10 animate-slide-up mx-auto flex flex-col items-center">
        {/* Logo / Title */}
        <div className="flex flex-col items-center mb-10">
          <div className="relative w-20 h-20 mb-5">
            <img
              src="/icon.png"
              alt="Pix Online"
              className="w-20 h-20 rounded-2xl object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 text-center">Pix Online</h1>
          <p className="text-gray-500 text-sm mt-1.5 text-center">כלי העלאה מהיר לצלמים</p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center animate-slide-down">
            {error}
          </div>
        )}

        {/* ===== LOGIN FORM ===== */}
        {mode === 'login' && (
          <div className="w-full">
          <form onSubmit={handleSubmit} className="space-y-4 w-full">
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">אימייל או שם משתמש</label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="your@email.com"
                className="w-full px-4 py-3 bg-dark-card border border-dark-border rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/20 transition-all text-sm"
                required
                autoFocus
                dir="ltr"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 font-medium mb-1.5">סיסמה</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-3 pr-10 bg-dark-card border border-dark-border rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/20 transition-all text-sm"
                  required
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !identifier || !password}
              className="w-full py-3 bg-gradient-to-r from-brand-primary to-brand-hover text-white font-medium rounded-none transition-all disabled:opacity-40 disabled:cursor-not-allowed text-sm mt-2 hover:shadow-lg hover:shadow-brand-primary/25 hover:-translate-y-0.5 active:translate-y-0 active:shadow-md"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  מתחבר...
                </span>
              ) : (
                'התחברות'
              )}
            </button>
          </form>

          {/* Google users - OUTSIDE form so button works */}
          <div className="mt-8 border-t border-gray-200 pt-6 border-blue-100 bg-blue-50/80 px-4 py-3 text-center">
            <p className="text-[11px] text-blue-600 mb-2 leading-relaxed">
              נרשמת עם Google? יש ליצור סיסמה עבור התחברות ל-Uploader
            </p>
            <button
              type="button"
              onClick={() => { setMode('forgot'); setForgotEmail(identifier.includes('@') ? identifier : ''); setError(''); }}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-none transition-colors w-full"
            >
              צור סיסמה
            </button>
          </div>
          </div>
        )}

        {/* ===== FORGOT PASSWORD FORM ===== */}
        {mode === 'forgot' && (
          <form onSubmit={handleForgotPassword} className="space-y-4 w-full">
            <div className="flex flex-col items-center text-center mb-4">
              <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">שלב 1 מתוך 2</p>
              <p className="text-xs text-gray-500 leading-relaxed">
                הזן את המייל של חשבון Google שלך.<br />
                נשלח לך קישור — לחץ עליו ובחר סיסמה.
              </p>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5 font-medium">אימייל או שם משתמש</label>
              <input
                type="text"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full px-4 py-3 bg-dark-card border border-dark-border rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/20 transition-all text-sm"
                required
                autoFocus
                dir="ltr"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !forgotEmail.trim()}
              className="w-full py-3 bg-gradient-to-r from-brand-primary to-brand-hover text-white font-medium rounded-none transition-all disabled:opacity-40 disabled:cursor-not-allowed text-sm hover:shadow-lg hover:shadow-brand-primary/25"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  שולח...
                </span>
              ) : (
                'שלח קישור ליצירת סיסמה'
              )}
            </button>

            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
              className="w-full text-center text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← חזרה להתחברות
            </button>
          </form>
        )}

        {/* ===== FORGOT SENT CONFIRMATION ===== */}
        {mode === 'forgot-sent' && (
          <div className="flex flex-col items-center space-y-4">
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">מייל נשלח!</p>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                בדוק את תיבת הדואר שלך ולחץ על הקישור ליצירת הסיסמה.
                לאחר יצירת הסיסמה, תוכל להתחבר לאפלודר.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
              className="w-full py-3 bg-gradient-to-r from-brand-primary to-brand-hover text-white font-medium rounded-none text-sm"
            >
              חזרה להתחברות
            </button>
          </div>
        )}

        {/* Bottom subtle branding */}
        <p className="text-center text-gray-400 text-[10px] mt-8">Pix Online Uploader</p>
      </div>
    </div>
  );
}
