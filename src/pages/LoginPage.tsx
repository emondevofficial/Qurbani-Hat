import React, { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth-context';
import { useRouter, Link } from '../lib/router-context';
import { getGoogleRedirectUri } from '../lib/oauth';
import { 
  Mail, 
  Lock, 
  ArrowRight, 
  Loader2, 
  AlertCircle,
  ShieldCheck,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';

export function LoginPage() {
  const { signInWithEmail, signInWithGoogle, initiateGoogleOAuth, isLoading } = useAuth();
  const { navigate, searchParams } = useRouter();
  const redirectPath = searchParams.get('redirect') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const [showOAuthHelp, setShowOAuthHelp] = useState(false);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);

  // Derived from the same shared helper the server uses, so the value shown
  // here can never drift from the redirect_uri actually sent to Google.
  const currentRedirectUri = getGoogleRedirectUri(window.location.origin);
  const localhostRedirectUri = getGoogleRedirectUri('http://localhost:3000');

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedUri(text);
    setTimeout(() => setCopiedUri(null), 2500);
  };

  useEffect(() => {
    const errorParam = searchParams.get('error');
    const errorDesc = searchParams.get('error_description');
    if (errorParam) {
      setError(errorDesc ? `${errorParam}: ${decodeURIComponent(errorDesc)}` : errorParam);
      setShowOAuthHelp(true);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password) {
      setError('Please fill in both email and password.');
      return;
    }

    setIsSubmitting(true);
    const success = await signInWithEmail(email, password);
    setIsSubmitting(false);

    if (success) {
      navigate(redirectPath);
    }
  };

  const handleGoogleLogin = async () => {
    setError('');
    setIsGoogleSubmitting(true);
    const initiated = await initiateGoogleOAuth({
      // Google sign-in finished inside the popup: send the user to the page
      // they originally asked for (the home dashboard by default).
      onSuccess: () => {
        setIsGoogleSubmitting(false);
        navigate(redirectPath);
      },
      // Popup closed / abandoned / provider error — just release the button.
      onCancel: () => setIsGoogleSubmitting(false),
    });
    if (!initiated) {
      setIsGoogleSubmitting(false);
    }
  };

  return (
    <div className="min-h-[80vh] bg-[#faf8f5] flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full bg-white rounded-3xl p-8 sm:p-10 border border-emerald-100 shadow-xl space-y-6 animate__animated animate__fadeIn">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-emerald-800 text-amber-400 flex items-center justify-center mx-auto shadow-md shadow-emerald-900/10">
            <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
              <path d="M12 2C7.5 2 3.8 5.4 3.1 9.7L2 10.5V13H3.2C3.7 17.5 7.4 21 12 21C16.6 21 20.3 17.5 20.8 13H22V10.5L20.9 9.7C20.2 5.4 16.5 2 12 2Z" />
            </svg>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 font-serif tracking-tight">
            Welcome Back
          </h1>
          <p className="text-xs sm:text-sm text-slate-500">
            Sign in to access your profile and reserve livestock for Qurbani.
          </p>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Google Login Button */}
        <div>
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={isGoogleSubmitting || isSubmitting}
            id="google-login-button"
            className="w-full py-3 px-4 rounded-xl border border-slate-200 hover:bg-slate-50 active:bg-slate-100 text-slate-700 font-bold text-xs sm:text-sm shadow-xs transition-all flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60"
          >
            {isGoogleSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin text-emerald-800" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            )}
            <span>Continue with Google</span>
          </button>

          {/* OAuth Setup & Redirect URI Helper */}
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => setShowOAuthHelp(!showOAuthHelp)}
              className="text-[11px] text-slate-500 hover:text-emerald-700 flex items-center justify-between w-full py-1 px-1.5 rounded transition-colors"
            >
              <span className="font-medium flex items-center gap-1">
                Seeing 'redirect_uri_mismatch' error? Click to fix
              </span>
              {showOAuthHelp ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {showOAuthHelp && (
              <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-2.5 animate__animated animate__fadeIn">
                <div className="text-slate-700 leading-relaxed">
                  In <strong>Google Cloud Console</strong> &gt; <strong>APIs &amp; Services</strong> &gt; <strong>Credentials</strong> &gt; <strong>OAuth 2.0 Client ID</strong>, add these to <strong>Authorized redirect URIs</strong>:
                </div>

                {/* Cloud Run Redirect URI */}
                <div className="space-y-1">
                  <div className="text-[10px] uppercase font-bold text-slate-500">
                    Current Environment (Cloud / Dev):
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={currentRedirectUri}
                      className="text-[11px] font-mono bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 w-full text-slate-700 select-all"
                    />
                    <button
                      type="button"
                      onClick={() => copyToClipboard(currentRedirectUri)}
                      className="px-2.5 py-1.5 bg-emerald-800 text-white rounded-lg hover:bg-emerald-900 transition-colors flex items-center gap-1 shrink-0 text-[11px] font-medium"
                      title="Copy redirect URI"
                    >
                      {copiedUri === currentRedirectUri ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Localhost Redirect URI */}
                <div className="space-y-1">
                  <div className="text-[10px] uppercase font-bold text-slate-500">
                    Localhost (for local development):
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={localhostRedirectUri}
                      className="text-[11px] font-mono bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 w-full text-slate-700 select-all"
                    />
                    <button
                      type="button"
                      onClick={() => copyToClipboard(localhostRedirectUri)}
                      className="px-2.5 py-1.5 bg-slate-700 text-white rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1 shrink-0 text-[11px] font-medium"
                      title="Copy localhost URI"
                    >
                      {copiedUri === localhostRedirectUri ? (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="pt-1 text-[11px] text-slate-500 flex items-center gap-1">
                  <span>Authorized JavaScript origin:</span>
                  <code className="text-slate-800 font-mono bg-slate-200/60 px-1 py-0.5 rounded text-[10px]">{window.location.origin}</code>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="relative flex items-center justify-center">
          <div className="border-t border-slate-200 w-full" />
          <span className="bg-white px-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider absolute">
            Or with email
          </span>
        </div>

        {/* Email/Password Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Email Address
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Mail className="w-4 h-4" />
              </div>
              <input
                type="email"
                id="login-email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500/20 focus:bg-white outline-hidden transition-all"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
              Password
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type="password"
                id="login-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500/20 focus:bg-white outline-hidden transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            id="login-submit-button"
            disabled={isSubmitting || isGoogleSubmitting}
            className="w-full py-3.5 px-6 rounded-xl bg-emerald-800 hover:bg-emerald-900 active:bg-emerald-950 text-white font-extrabold text-sm shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing In...</span>
              </>
            ) : (
              <>
                <span>Sign In</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Footer Link to Register */}
        <div className="pt-2 text-center text-xs text-slate-500 border-t border-slate-100">
          Don't have an account?{' '}
          <Link
            href={`/register${redirectPath !== '/' ? `?redirect=${encodeURIComponent(redirectPath)}` : ''}`}
            className="font-bold text-emerald-800 hover:text-emerald-950 underline"
            id="link-to-register"
          >
            Create Your Account
          </Link>
        </div>

      </div>
    </div>
  );
}
