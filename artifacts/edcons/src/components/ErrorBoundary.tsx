import { Component, type ReactNode } from "react";
import { GraduationCap, RefreshCw, AlertTriangle, ChevronDown, LogOut } from "lucide-react";
import { getTranslation, RTL_LANGUAGES, SUPPORTED_LANGUAGES, type Language } from "@/lib/i18n/index";
import { performLogout } from "@/lib/logout";

const SUPPORTED_LANGS = new Set<string>(SUPPORTED_LANGUAGES);

const RTL_LANGS = new Set<string>(RTL_LANGUAGES);

// A single auto-reload attempt is allowed per pathname per 5-minute window.
// This breaks any infinite loop while still recovering from one-shot
// transient failures (stale chunk after deploy, etc).
const RECOVER_COOLDOWN_MS = 5 * 60 * 1000;
const RECOVER_KEY_PREFIX = "edcons_recover:";

function getLang(): string {
  try {
    const saved = localStorage.getItem("edcons_lang");
    if (saved && SUPPORTED_LANGS.has(saved)) return saved;
    const urlLang = window.location.pathname.split("/")[1];
    if (urlLang && SUPPORTED_LANGS.has(urlLang)) return urlLang;
  } catch {}
  return "en";
}

function recoverKeyForPath(): string {
  try {
    return `${RECOVER_KEY_PREFIX}${window.location.pathname}`;
  } catch {
    return RECOVER_KEY_PREFIX;
  }
}

function cacheBustedReload(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("_cb", Date.now().toString());
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { hasError: boolean; lang: string; errorName: string; errorMessage: string; errorStack: string; showDetails: boolean }

interface FallbackProps {
  errorName: string;
  errorMessage: string;
  errorStack: string;
  showDetails: boolean;
  onReload: () => void;
  onHome: () => void;
  onLogout: () => void;
  onToggleDetails: () => void;
}

function ErrorBoundaryFallback({
  errorName,
  errorMessage,
  errorStack,
  showDetails,
  onReload,
  onHome,
  onLogout,
  onToggleDetails,
}: FallbackProps) {
  // ErrorBoundary wraps the whole app — including I18nProvider — so the
  // fallback can render OUTSIDE the provider. Resolve translations directly
  // (provider-independent) instead of using the useI18n() context hook.
  const lang = getLang();
  const isRTL = RTL_LANGS.has(lang);
  const t = (key: string, params?: Record<string, string | number>) =>
    getTranslation(lang as Language, key, params);
  const hasDetails = Boolean(errorMessage);

  return (
    <div
      dir={isRTL ? "rtl" : "ltr"}
      className="min-h-screen w-full flex flex-col items-center justify-center bg-background p-6 text-center"
    >
      <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center shadow-lg mb-6">
        <GraduationCap className="w-8 h-8 text-white" />
      </div>

      <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-4">
        <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />
      </div>

      <h1 className="text-xl font-bold text-foreground mb-2 max-w-sm">{t("errorBoundary.title")}</h1>
      <p className="text-sm text-muted-foreground mb-6 max-w-xs leading-relaxed">{t("errorBoundary.desc")}</p>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={onReload}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-md hover:opacity-90 active:scale-95 transition-all"
        >
          <RefreshCw className="w-4 h-4" />
          {t("errorBoundary.reload")}
        </button>
        <button
          onClick={onHome}
          className="inline-flex items-center justify-center rounded-xl border border-border bg-background px-6 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
        >
          {t("errorBoundary.home")}
        </button>
        <button
          onClick={onLogout}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background px-6 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <LogOut className="w-4 h-4" />
          {t("errorBoundary.logout")}
        </button>
      </div>

      {hasDetails && (
        <div className="mt-8 max-w-xl w-full">
          <button
            onClick={onToggleDetails}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`} />
            {t("errorBoundary.details")}
          </button>
          {showDetails && (
            <pre
              dir="ltr"
              className="mt-3 text-left text-[11px] leading-relaxed bg-muted/40 border border-border rounded-lg p-3 overflow-auto max-h-64 font-mono text-muted-foreground"
            >
              {errorName}: {errorMessage}
              {errorStack ? `\n\n${errorStack}` : ""}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, lang: "en", errorName: "", errorMessage: "", errorStack: "", showDetails: false };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const e = error as Error | undefined;
    return {
      hasError: true,
      lang: getLang(),
      errorName: e?.name || "Error",
      errorMessage: e?.message || String(error),
      errorStack: (e?.stack || "").split("\n").slice(0, 6).join("\n"),
    };
  }

  componentDidCatch(error: unknown) {
    console.error("[ErrorBoundary]", error);
    // Auto-recover: try ONE cache-busted reload per pathname per 5 minutes.
    // We persist a TIMESTAMP (not a boolean) in sessionStorage so that the
    // boundary can never reload twice in quick succession — that was the
    // bug that put users in an infinite loop. After the first auto-reload
    // we ALWAYS show the recovery UI on the next failure within the
    // cooldown window so the user can pick what to do (reload, go home,
    // or sign out).
    try {
      const key = recoverKeyForPath();
      const lastRaw = sessionStorage.getItem(key);
      const last = lastRaw ? Number(lastRaw) : 0;
      const now = Date.now();
      if (!last || now - last > RECOVER_COOLDOWN_MS) {
        sessionStorage.setItem(key, String(now));
        setTimeout(() => cacheBustedReload(), 50);
      }
    } catch {}
  }

  componentDidUpdate(_: Props, prevState: State) {
    // Only clear the cooldown after we transition from error → no-error,
    // i.e. the user successfully navigated away or the retry worked.
    if (prevState.hasError && !this.state.hasError) {
      try { sessionStorage.removeItem(recoverKeyForPath()); } catch {}
    }
  }

  handleReload = () => {
    // User pressed reload manually — clear cooldown so they can recover
    // again later if needed, then do the cache-busted reload.
    try { sessionStorage.removeItem(recoverKeyForPath()); } catch {}
    cacheBustedReload();
  };

  handleHome = () => {
    try { sessionStorage.removeItem(recoverKeyForPath()); } catch {}
    const lang = this.state.lang;
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
    window.location.href = `${base}/${lang}/?_cb=${Date.now()}`;
  };

  handleLogout = async () => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
    const lang = this.state.lang;
    await performLogout(`${base}/${lang}/login?_cb=${Date.now()}`);
  };

  toggleDetails = () => this.setState((s) => ({ showDetails: !s.showDetails }));

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <ErrorBoundaryFallback
        errorName={this.state.errorName}
        errorMessage={this.state.errorMessage}
        errorStack={this.state.errorStack}
        showDetails={this.state.showDetails}
        onReload={this.handleReload}
        onHome={this.handleHome}
        onLogout={this.handleLogout}
        onToggleDetails={this.toggleDetails}
      />
    );
  }
}
