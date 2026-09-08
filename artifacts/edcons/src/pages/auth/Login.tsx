import { useState, useEffect, useMemo, useRef, startTransition } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { setAuthCache, setStickyUser } from "@/lib/auth-cache";
import { useTheme } from "@/contexts/ThemeContext";
import { useI18n } from "@/hooks/use-i18n";
import { GraduationCap, Globe2, Star, ArrowRight, Loader2, Mail, Lock, User, Phone, Eye, EyeOff, ShieldCheck, ChevronDown } from "lucide-react";
import { SUPPORTED_LANGUAGES, LANGUAGE_META, LANGUAGE_COUNTRY_CODES, type Language, isValidLanguage } from "@/lib/i18n/index";
import { storeLangHint, getLangHintByEmail } from "@/lib/i18n/context";
import { PasswordStrengthIndicator } from "@/components/PasswordStrengthIndicator";
import { validatePasswordPolicy } from "@/components/password-policy";
import { toLatinUpper, digitsOnly } from "@/lib/textTransform";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { CountryFlag } from "@/components/CountryFlag";

import { motion, AnimatePresence } from "framer-motion";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function safeJson(res: Response): Promise<any> {
  try {
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  } catch { return {}; }
}

async function authFetch(url: string, init: RequestInit, retries = 1): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        return res;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function describeAuthError(status: number, data: any, t: (k: string) => string): string {
  if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  if (status === 401) return t("login.invalidCredentials") || "Invalid email or password";
  if (status === 403) return data?.error || "Access denied";
  if (status === 429) return t("login.tooManyAttempts") || "Too many attempts. Please wait a moment and try again.";
  if (status >= 500) return t("login.serverError") || "Server is temporarily unavailable. Please try again in a moment.";
  return t("login.connectionError");
}

type Tab = "login" | "register" | "verify" | "set-password" | "forgot-password";

export default function Login() {
  const { user, isLoading } = useAuth(false);
  const { settings, resolvedTheme } = useTheme();
  const { t, lang, setLang, localePath, isRTL } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleLangSwitch(newLang: Language) {
    setLang(newLang);
    setLangOpen(false);
  }
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const returnTo = useMemo(() => {
    const raw = urlParams.get("returnTo");
    if (!raw) return null;
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith("/") && !decoded.startsWith("//")) return decoded;
    return null;
  }, [urlParams]);

  const passwordToken = urlParams.get("token");
  const verifiedSuccess = urlParams.get("verified") === "true";
  const verifyError = urlParams.get("verifyError");

  const [tab, setTab] = useState<Tab>(passwordToken ? "set-password" : "login");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState(
    verifiedSuccess ? "verified" :
    verifyError === "invalid" ? "" : ""
  );
  const [setPasswordForm, setSetPasswordForm] = useState({ password: "", confirmPassword: "" });
  const [passwordSet, setPasswordSet] = useState(false);

  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ email: "", password: "", confirmPassword: "", firstName: "", lastName: "", phoneCode: "", phone: "" });
  const [verifyEmail, setVerifyEmail] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [resending, setResending] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);

  const hasLogo = resolvedTheme === "dark" && settings.logoDarkUrl ? settings.logoDarkUrl : settings.logoUrl;
  const logoSrc = hasLogo
    ? `${BASE_URL}/api/settings/branding/logo${resolvedTheme === "dark" && settings.logoDarkUrl ? "?variant=dark" : ""}`
    : null;
  const companyName = settings.companyName || "Find And Study OS";

  // When the user types a recognised email on the login page, pre-select the
  // language they last used on this device.  This is the shared-device fix:
  // two people sharing one browser each see their own language on the login
  // form before they have authenticated.
  useEffect(() => {
    const email = loginForm.email.trim();
    if (!email.includes("@")) return;
    const hint = getLangHintByEmail(email);
    if (hint && hint !== lang) {
      setLang(hint);
    }
  }, [loginForm.email]);

  useEffect(() => {
    if (!isLoading && user) {
      startTransition(() => {
        if (returnTo) {
          setLocation(returnTo);
        } else if (["super_admin", "admin", "manager"].includes(user.role)) {
          setLocation("/admin/dashboard");
        } else if (["staff", "consultant", "accountant", "editor"].includes(user.role)) {
          setLocation("/staff/dashboard");
        } else if (user.role === "student") {
          setLocation("/student");
        } else if (["agent", "sub_agent", "agent_staff"].includes(user.role)) {
          setLocation("/agent");
        } else if (user.role === "institution_user") {
          setLocation("/institution");
        } else {
          setLocation("/staff");
        }
      });
    }
  }, [user, isLoading, setLocation, returnTo]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await authFetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginForm.email, password: loginForm.password }),
        credentials: "include",
      });
      const data = await safeJson(res);
      if (!res.ok) {
        setError(describeAuthError(res.status, data, t));
        return;
      }
      if (data.user) {
        // Persist the freshly-authenticated user across all three caches
        // (in-memory sticky, React Query, and localStorage) BEFORE the
        // redirect-effect navigates to the portal. Without the localStorage
        // write, the next mount of `useAuth` could see neither a sticky
        // user (race) nor a cached one and bounce the user back to /login,
        // creating a redirect loop between /login and the portal.
        setStickyUser(data.user as any);
        setAuthCache(data.user);
        queryClient.setQueryData(["/api/auth/me"], data.user);
        // Apply and store the effective language for this user.
        // Using a per-user key (edcons_lang_hint_<userId>) means two people
        // sharing the same device each see their own language on next visit,
        // instead of inheriting the previous user's preference.
        const effectiveLang = (data.user.language && isValidLanguage(data.user.language))
          ? data.user.language as Language
          : lang;
        if (data.user.language && isValidLanguage(data.user.language)) {
          setLang(effectiveLang);
        }
        storeLangHint(data.user.id, effectiveLang, loginForm.email.trim() || undefined);
      }
    } catch {
      setError(t("login.connectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const firstName = registerForm.firstName.trim();
    const lastName = registerForm.lastName.trim();
    const email = registerForm.email.trim();
    const phone = registerForm.phone.trim();
    const phoneCode = registerForm.phoneCode.trim();
    if (!firstName || !lastName || !email || !phoneCode || !phone) {
      setError(t("login.requiredFields"));
      return;
    }

    if (registerForm.password !== registerForm.confirmPassword) {
      setError(t("login.passwordsNoMatch"));
      return;
    }
    const pwdError = validatePasswordPolicy(registerForm.password);
    if (pwdError) {
      setError(t("login.passwordMinLength"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: registerForm.email,
          password: registerForm.password,
          firstName: registerForm.firstName,
          lastName: registerForm.lastName,
          phone: `${registerForm.phoneCode}${registerForm.phone}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("login.connectionError"));
        return;
      }
      setVerifyEmail(registerForm.email);
      setTab("verify");
    } catch {
      setError(t("login.connectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/verify-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail, code: verifyCode }),
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("login.connectionError"));
        return;
      }
      // The backend creates a session and returns the user payload on
      // successful verification — feed it into the auth cache so the
      // existing redirect-on-user-detect effect at the top of this
      // component logs the student straight into their portal.
      if (data.user) {
        // Persist the freshly-authenticated user across all three caches
        // (in-memory sticky, React Query, and localStorage) BEFORE the
        // redirect-effect navigates to the portal. Without the localStorage
        // write, the next mount of `useAuth` could see neither a sticky
        // user (race) nor a cached one and bounce the user back to /login,
        // creating a redirect loop between /login and the portal.
        setStickyUser(data.user as any);
        setAuthCache(data.user);
        queryClient.setQueryData(["/api/auth/me"], data.user);
        const effectiveLang = (data.user.language && isValidLanguage(data.user.language))
          ? data.user.language as Language
          : lang;
        if (data.user.language && isValidLanguage(data.user.language)) {
          setLang(effectiveLang);
        }
        storeLangHint(data.user.id, effectiveLang, verifyEmail.trim() || undefined);
      } else {
        setTab("login");
      }
    } catch {
      setError(t("login.connectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResendCode() {
    setResending(true);
    setError("");
    try {
      await fetch(`${BASE_URL}/api/auth/resend-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail }),
      });
      setError("");
    } catch {} finally {
      setResending(false);
    }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        return;
      }
      setForgotSent(true);
    } catch {
      setError(t("login.connectionError"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (setPasswordForm.password !== setPasswordForm.confirmPassword) {
      setError(t("login.passwordsNoMatch"));
      return;
    }
    const pwdError = validatePasswordPolicy(setPasswordForm.password);
    if (pwdError) {
      setError(t("login.passwordMinLength"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: passwordToken, password: setPasswordForm.password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t("login.connectionError"));
        return;
      }
      setPasswordSet(true);
    } catch {
      setError(t("login.connectionError"));
    } finally {
      setLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-accent/5">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 text-primary animate-spin" />
          <p className="text-muted-foreground font-medium">{t("login.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary to-accent relative overflow-hidden flex-col justify-between p-12">
        <div className="absolute inset-0">
          <div className="absolute top-20 left-20 w-72 h-72 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute bottom-20 right-20 w-96 h-96 rounded-full bg-white/5 blur-3xl" />
        </div>
        <div className="relative z-10">
          <button
            type="button"
            onClick={() => setLocation(localePath("/"))}
            aria-label={t("common.goHome") || "Go to home"}
            className="flex items-center gap-3 mb-16 cursor-pointer rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 transition-opacity hover:opacity-90"
          >
            {logoSrc ? (
              <img src={logoSrc} alt={companyName} className="h-12 max-w-[220px] object-contain brightness-0 invert" />
            ) : (
              <>
                <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center">
                  <GraduationCap className="w-7 h-7 text-white" />
                </div>
                <span className="font-display font-bold text-3xl text-white">{companyName}</span>
              </>
            )}
          </button>
          <h1 className="text-4xl font-display font-bold text-white mb-6 leading-tight whitespace-pre-line">
            {t("login.loginHeroTitle")}
          </h1>
          <p className="text-white/80 text-lg leading-relaxed max-w-md">
            {t("login.loginHeroSubtitle")}
          </p>
        </div>

        <div className="relative z-10 space-y-4">
          {[
            { icon: Globe2, text: t("login.partnerUniversities") },
            { icon: Star, text: t("login.visaApproval") },
            { icon: GraduationCap, text: t("login.studentsPlaced") },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3 text-white/90">
              <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                <item.icon className="w-4 h-4 text-white" />
              </div>
              <span className="font-medium">{item.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 relative flex items-center justify-center bg-background p-8">
        <div
          ref={langRef}
          className={`absolute top-4 ${isRTL ? "left-4" : "right-4"} z-50`}
        >
          <button
            type="button"
            onClick={() => setLangOpen(!langOpen)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-sm font-medium"
            aria-label="Select language"
          >
            <CountryFlag code={LANGUAGE_COUNTRY_CODES[lang]} size="sm" />
            <span className="text-foreground">{LANGUAGE_META[lang].code.toUpperCase()}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${langOpen ? "rotate-180" : ""}`} />
          </button>
          {langOpen && (
            <div className={`absolute top-full mt-2 ${isRTL ? "left-0" : "right-0"} bg-card border border-border rounded-xl shadow-xl py-2 min-w-[200px] max-h-[400px] overflow-y-auto`}>
              {SUPPORTED_LANGUAGES.map((code) => {
                const meta = LANGUAGE_META[code];
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => handleLangSwitch(code)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-secondary/80 transition-colors ${
                      code === lang ? "bg-primary/10 text-primary font-semibold" : "text-foreground"
                    }`}
                  >
                    <CountryFlag code={LANGUAGE_COUNTRY_CODES[code]} size="md" />
                    <span>{meta.nativeName}</span>
                    <span className="text-muted-foreground text-xs ms-auto">{meta.code.toUpperCase()}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
          <button
            type="button"
            onClick={() => setLocation(localePath("/"))}
            aria-label={t("common.goHome") || "Go to home"}
            className="lg:hidden flex items-center gap-2 justify-center mb-10 mx-auto cursor-pointer rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 transition-opacity hover:opacity-90"
          >
            {logoSrc ? (
              <img src={logoSrc} alt={companyName} className="h-10 max-w-[180px] object-contain" />
            ) : (
              <>
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                  <GraduationCap className="w-6 h-6 text-white" />
                </div>
                <span className="font-display font-bold text-2xl">{companyName}</span>
              </>
            )}
          </button>

          {successMessage && tab === "login" && (
            <div className="p-3 rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 text-sm mb-4 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              {t("login.verifiedSuccess")}
            </div>
          )}

          {verifyError === "invalid" && tab === "login" && (
            <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm mb-4">
              {t("login.invalidLink")}
            </div>
          )}

          {tab !== "verify" && tab !== "set-password" && tab !== "forgot-password" && (
            <div className="flex rounded-xl bg-secondary/50 p-1 mb-8">
              <button
                aria-label="Login tab"
                onClick={() => { setTab("login"); setError(""); }}
                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${tab === "login" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("login.signIn")}
              </button>
              <button
                onClick={() => { setTab("register"); setError(""); }}
                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${tab === "register" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t("login.studentRegistration")}
              </button>
              <button
                type="button"
                onClick={() => setLocation(localePath("/agency/apply"))}
                className="flex-1 py-2.5 px-3 rounded-lg text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-background/70 transition-all"
              >
                {t("footer.becomePartner")}
              </button>
            </div>
          )}

          <AnimatePresence mode="wait">
            {tab === "login" && (
              <motion.div key="login" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
                <h2 className="text-3xl font-display font-bold text-foreground mb-2">{t("login.welcomeBack")}</h2>
                <p className="text-muted-foreground mb-8">{t("login.signInSubtitle")}</p>

                <form onSubmit={handleLogin} className="space-y-5">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-email" className="flex items-center gap-1.5 text-sm font-semibold"><Mail className="w-3.5 h-3.5" /> {t("login.emailLabel")}</Label>
                    <Input
                      id="login-email"
                      type="email"
                      value={loginForm.email}
                      onChange={e => setLoginForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="you@example.com"
                      className="rounded-xl h-12"
                      required
                      autoComplete="email"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="login-password" className="flex items-center gap-1.5 text-sm font-semibold"><Lock className="w-3.5 h-3.5" /> {t("login.passwordLabel")}</Label>
                    <div className="relative">
                      <Input
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        value={loginForm.password}
                        onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))}
                        placeholder={t("login.passwordLabel")}
                        className="rounded-xl h-12 pr-12"
                        required
                        autoComplete="current-password"
                      />
                      <button type="button" onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                        aria-pressed={showPassword}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      {error}
                    </div>
                  )}

                  <Button type="submit" size="lg" disabled={loading}
                    className="w-full rounded-xl py-6 text-base font-semibold shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all hover:-translate-y-0.5">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <ArrowRight className="w-5 h-5 mr-2" />}
                    {t("login.signInButton")}
                  </Button>

                  <div className="text-center mt-4">
                    <button
                      type="button"
                      onClick={() => { setTab("forgot-password"); setError(""); setForgotSent(false); setForgotEmail(loginForm.email); }}
                      className="text-sm text-primary hover:text-primary/80 font-medium transition-colors hover:underline"
                    >
                      {t("login.forgotPassword") || "Forgot your password?"}
                    </button>
                  </div>
                </form>
              </motion.div>
            )}

            {tab === "register" && (
              <motion.div key="register" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <h2 className="text-3xl font-display font-bold text-foreground mb-2">{t("login.createAccount")}</h2>
                <p className="text-muted-foreground mb-8">{t("login.registerSubtitle")}</p>

                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-sm font-semibold">{t("login.firstName")}</Label>
                      <Input
                        value={registerForm.firstName}
                        onChange={e => setRegisterForm(f => ({ ...f, firstName: toLatinUpper(e.target.value) }))}
                        placeholder="John"
                        className="rounded-xl h-11"
                        required
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm font-semibold">{t("login.lastName")}</Label>
                      <Input
                        value={registerForm.lastName}
                        onChange={e => setRegisterForm(f => ({ ...f, lastName: toLatinUpper(e.target.value) }))}
                        placeholder="Doe"
                        className="rounded-xl h-11"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5 text-sm font-semibold"><Mail className="w-3.5 h-3.5" /> {t("login.emailLabel")}</Label>
                    <Input
                      type="email"
                      value={registerForm.email}
                      onChange={e => setRegisterForm(f => ({ ...f, email: e.target.value }))}
                      placeholder="you@example.com"
                      className="rounded-xl h-11"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5 text-sm font-semibold"><Phone className="w-3.5 h-3.5" /> {t("login.phoneLabel")}</Label>
                    <div className="flex gap-2">
                      <PhoneCodePicker
                        value={registerForm.phoneCode}
                        onChange={v => setRegisterForm(f => ({ ...f, phoneCode: v }))}
                        triggerClassName="h-11 rounded-xl w-[110px] shrink-0"
                      />
                      <Input
                        value={registerForm.phone}
                        onChange={e => setRegisterForm(f => ({ ...f, phone: digitsOnly(e.target.value) }))}
                        placeholder="555 123 4567"
                        className="rounded-xl h-11 flex-1"
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5 text-sm font-semibold"><Lock className="w-3.5 h-3.5" /> {t("login.passwordLabel")}</Label>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        value={registerForm.password}
                        onChange={e => setRegisterForm(f => ({ ...f, password: e.target.value }))}
                        placeholder={t("login.minChars")}
                        className="rounded-xl h-11 pr-12"
                        required
                        minLength={8}
                      />
                      <button type="button" onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                        aria-pressed={showPassword}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <PasswordStrengthIndicator password={registerForm.password} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm font-semibold">{t("login.confirmPassword")}</Label>
                    <Input
                      type="password"
                      value={registerForm.confirmPassword}
                      onChange={e => setRegisterForm(f => ({ ...f, confirmPassword: e.target.value }))}
                      placeholder={t("login.reenterPassword")}
                      className="rounded-xl h-11"
                      required
                    />
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      {error}
                    </div>
                  )}

                  <Button type="submit" size="lg" disabled={loading}
                    className="w-full rounded-xl py-5 text-base font-semibold shadow-lg shadow-primary/25 hover:shadow-xl transition-all hover:-translate-y-0.5">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <User className="w-5 h-5 mr-2" />}
                    {t("login.createAccountButton")}
                  </Button>

                  <p className="text-xs text-muted-foreground text-center">
                    {t("login.verificationNote")}
                  </p>
                </form>
              </motion.div>
            )}

            {tab === "verify" && (
              <motion.div key="verify" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
                <div className="text-center mb-8">
                  <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <ShieldCheck className="w-8 h-8 text-primary" />
                  </div>
                  <h2 className="text-2xl font-display font-bold text-foreground mb-2">{t("login.verifyTitle")}</h2>
                  <p className="text-muted-foreground text-sm">
                    {t("login.verifySubtitle", { email: "" })}<br />
                    <span className="font-semibold text-foreground">{verifyEmail}</span>
                  </p>
                </div>

                <form onSubmit={handleVerify} className="space-y-5">
                  <div className="space-y-1.5">
                    <Label className="text-sm font-semibold text-center block">{t("login.verificationCodeLabel")}</Label>
                    <Input
                      value={verifyCode}
                      onChange={e => setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="000000"
                      className="rounded-xl h-14 text-center text-2xl tracking-[0.5em] font-mono"
                      maxLength={6}
                      required
                      autoFocus
                    />
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                      {error}
                    </div>
                  )}

                  <Button type="submit" size="lg" disabled={loading || verifyCode.length !== 6}
                    className="w-full rounded-xl py-6 text-base font-semibold shadow-lg shadow-primary/25">
                    {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <ShieldCheck className="w-5 h-5 mr-2" />}
                    {t("login.verifyButton")}
                  </Button>

                  <div className="text-center">
                    <button type="button" onClick={handleResendCode} disabled={resending}
                      className="text-sm text-primary font-medium hover:underline disabled:opacity-50">
                      {resending ? t("login.loading") : t("login.resendCode")}
                    </button>
                  </div>

                  <button type="button" onClick={() => { setTab("login"); setError(""); }}
                    className="w-full text-sm text-muted-foreground hover:text-foreground text-center">
                    {t("login.backToLogin")}
                  </button>
                </form>
              </motion.div>
            )}

            {tab === "forgot-password" && (
              <motion.div key="forgot-password" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
                {forgotSent ? (
                  <div className="text-center">
                    <div className="w-16 h-16 rounded-2xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                      <Mail className="w-8 h-8 text-green-600 dark:text-green-400" />
                    </div>
                    <h2 className="text-2xl font-display font-bold text-foreground mb-2">
                      {t("login.resetEmailSent") || "Check Your Email"}
                    </h2>
                    <p className="text-muted-foreground text-sm mb-6">
                      {t("login.resetEmailSentDesc") || "If an account exists with that email, we've sent a password reset link. Please check your inbox and spam folder."}
                    </p>
                    <Button size="lg" onClick={() => { setTab("login"); setError(""); setForgotSent(false); }}
                      className="w-full rounded-xl py-6 text-base font-semibold shadow-lg shadow-primary/25">
                      <ArrowRight className="w-5 h-5 mr-2" />
                      {t("login.backToLogin") || "Back to Sign In"}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                        <Lock className="w-8 h-8 text-primary" />
                      </div>
                      <h2 className="text-2xl font-display font-bold text-foreground mb-2">
                        {t("login.forgotPasswordTitle") || "Forgot Password?"}
                      </h2>
                      <p className="text-muted-foreground text-sm">
                        {t("login.forgotPasswordDesc") || "Enter your email address and we'll send you a link to reset your password."}
                      </p>
                    </div>

                    <form onSubmit={handleForgotPassword} className="space-y-5">
                      <div className="space-y-1.5">
                        <Label className="flex items-center gap-1.5 text-sm font-semibold"><Mail className="w-3.5 h-3.5" /> {t("login.emailLabel")}</Label>
                        <Input
                          type="email"
                          value={forgotEmail}
                          onChange={e => setForgotEmail(e.target.value)}
                          placeholder="you@example.com"
                          className="rounded-xl h-12"
                          required
                          autoFocus
                        />
                      </div>

                      {error && (
                        <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                          {error}
                        </div>
                      )}

                      <Button type="submit" size="lg" disabled={loading}
                        className="w-full rounded-xl py-6 text-base font-semibold shadow-lg shadow-primary/25">
                        {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Mail className="w-5 h-5 mr-2" />}
                        {t("login.sendResetLink") || "Send Reset Link"}
                      </Button>

                      <button type="button" onClick={() => { setTab("login"); setError(""); }}
                        className="w-full text-sm text-muted-foreground hover:text-foreground text-center">
                        {t("login.backToLogin") || "Back to Sign In"}
                      </button>
                    </form>
                  </>
                )}
              </motion.div>
            )}

            {tab === "set-password" && (
              <motion.div key="set-password" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
                {passwordSet ? (
                  <div className="text-center">
                    <div className="w-16 h-16 rounded-2xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                      <ShieldCheck className="w-8 h-8 text-green-600 dark:text-green-400" />
                    </div>
                    <h2 className="text-2xl font-display font-bold text-foreground mb-2">{t("login.passwordSetSuccess")}</h2>
                    <p className="text-muted-foreground text-sm mb-6">
                      {t("login.setPasswordSubtitle")}
                    </p>
                    <Button size="lg" onClick={() => { setTab("login"); setError(""); setSuccessMessage(""); }}
                      className="w-full rounded-xl py-6 text-base font-semibold shadow-lg shadow-primary/25">
                      <ArrowRight className="w-5 h-5 mr-2" />
                      {t("login.goToSignIn")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="text-center mb-8">
                      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                        <Lock className="w-8 h-8 text-primary" />
                      </div>
                      <h2 className="text-2xl font-display font-bold text-foreground mb-2">{t("login.setPasswordTitle")}</h2>
                      <p className="text-muted-foreground text-sm">
                        {t("login.setPasswordSubtitle")}
                      </p>
                    </div>

                    <form onSubmit={handleSetPassword} className="space-y-5">
                      <div className="space-y-1.5">
                        <Label className="flex items-center gap-1.5 text-sm font-semibold"><Lock className="w-3.5 h-3.5" /> {t("login.newPassword")}</Label>
                        <div className="relative">
                          <Input
                            type={showPassword ? "text" : "password"}
                            value={setPasswordForm.password}
                            onChange={e => setSetPasswordForm(f => ({ ...f, password: e.target.value }))}
                            placeholder={t("login.minChars")}
                            className="rounded-xl h-12 pr-12"
                            required
                            minLength={8}
                            autoFocus
                          />
                          
                          <button type="button" onClick={() => setShowPassword(!showPassword)}
                            aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                            aria-pressed={showPassword}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                            {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                          </button>
                        </div>
                        <PasswordStrengthIndicator password={setPasswordForm.password} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-sm font-semibold">{t("login.confirmPassword")}</Label>
                        <Input
                          type="password"
                          value={setPasswordForm.confirmPassword}
                          onChange={e => setSetPasswordForm(f => ({ ...f, confirmPassword: e.target.value }))}
                          placeholder={t("login.reenterPassword")}
                          className="rounded-xl h-12"
                          required
                        />
                      </div>

                      {error && (
                        <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                          {error}
                        </div>
                      )}

                      <Button type="submit" size="lg" disabled={loading}
                        className="w-full rounded-xl py-6 text-base font-semibold shadow-lg shadow-primary/25">
                        {loading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <ShieldCheck className="w-5 h-5 mr-2" />}
                        {t("login.setPasswordButton")}
                      </Button>

                      <button type="button" onClick={() => { setTab("login"); setError(""); }}
                        className="w-full text-sm text-muted-foreground hover:text-foreground text-center">
                        {t("login.backToLogin")}
                      </button>
                    </form>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {tab !== "verify" && tab !== "set-password" && tab !== "forgot-password" && (
            <div className="mt-8 p-5 rounded-2xl bg-secondary/50 border border-border/40">
              <p className="text-sm text-muted-foreground text-center">
                {t("login.termsText")}{" "}
                <span className="text-primary font-medium cursor-pointer hover:underline">{t("login.termsOfService")}</span>
                {" "}{t("login.and")}{" "}
                <span className="text-primary font-medium cursor-pointer hover:underline">{t("login.privacyPolicy")}</span>.
              </p>
            </div>
          )}

          {tab === "login" && (
            <div className="mt-8 grid grid-cols-3 gap-4">
              {[
                { label: t("login.studentsPortal"), icon: "🎓" },
                { label: t("login.agentsPortal"), icon: "🤝" },
                { label: t("login.staffPortal"), icon: "💼" },
              ].map((p, i) => (
                <div key={i} className="text-center p-4 rounded-xl bg-secondary/30 border border-border/30">
                  <div className="text-2xl mb-2">{p.icon}</div>
                  <p className="text-xs font-medium text-muted-foreground">{p.label}</p>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}
