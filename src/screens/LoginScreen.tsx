import { useState } from 'react';
import { supabase } from '../lib/supabase';

interface LoginScreenProps {
  onLogin: (token: string, userId: string, email: string) => void;
}

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const resolveEmail = async (input: string): Promise<string> => {
    // If it looks like an email, return as-is
    if (input.includes('@')) return input;

    // Otherwise treat as subdomain/username and resolve via photographer_profiles
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

      // Persist session
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

  return (
    <div className="flex items-center justify-center h-screen bg-dark-bg">
      <div className="w-full max-w-sm px-8">
        {/* Logo / Title */}
        <div className="text-center mb-10">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-brand-primary flex items-center justify-center">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Pix Online Uploader</h1>
          <p className="text-gray-500 text-sm mt-2">התחברו לחשבון כדי להעלות תמונות</p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm text-center">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">אימייל או שם משתמש</label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="your@email.com או שם המשתמש"
              className="w-full px-4 py-3 bg-dark-card border border-dark-border rounded-lg text-white
                         placeholder-gray-600 focus:outline-none focus:border-brand-primary
                         transition-colors text-sm"
              required
              autoFocus
              dir="ltr"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1.5">סיסמה</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 bg-dark-card border border-dark-border rounded-lg text-white
                         placeholder-gray-600 focus:outline-none focus:border-brand-primary
                         transition-colors text-sm"
              required
              dir="ltr"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !identifier || !password}
            className="w-full py-3 bg-brand-primary hover:bg-brand-hover text-white font-medium
                       rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                       text-sm mt-2"
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
      </div>
    </div>
  );
}
