import { ReactNode, useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useI18n } from "@/hooks/use-i18n";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { GraduationCap, Menu, X, ChevronDown, Mail, Phone, MapPin } from "lucide-react";
import { SUPPORTED_LANGUAGES, LANGUAGE_META, LANGUAGE_COUNTRY_CODES, type Language } from "@/lib/i18n/index";
import { CountryFlag } from "@/components/CountryFlag";
import { CookieBanner } from "@/components/CookieBanner";

export function PublicLayout({ children }: { children: ReactNode }) {
  const { t, lang, setLang, localePath, isRTL } = useI18n();
  const { settings, resolvedTheme } = useTheme();
  const [, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);

  const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
  const hasLogo = resolvedTheme === "dark" && settings.logoDarkUrl
    ? settings.logoDarkUrl
    : settings.logoUrl;
  const logoUrl = hasLogo
    ? `${BASE_URL}/api/settings/branding/logo${resolvedTheme === "dark" && settings.logoDarkUrl ? "?variant=dark" : ""}`
    : null;
  const companyName = settings.companyName || "Find And Study OS";

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const currentMeta = LANGUAGE_META[lang];

  const navLinks = [
    { href: localePath("/"), label: t("nav.home") },
    { href: localePath("/about"), label: t("nav.about") },
    { href: localePath("/countries"), label: t("nav.countries") },
    { href: localePath("/programs"), label: t("nav.programs") },
    { href: localePath("/blog"), label: t("nav.blog") },
    { href: localePath("/contact"), label: t("nav.contact") },
  ];

  function handleLangSwitch(newLang: Language) {
    setLang(newLang);
    setLangOpen(false);
    const currentPath = window.location.pathname;
    const stripped = currentPath.replace(/^\/[a-z]{2}(\/|$)/, "/") || "/";
    const newPath = `/${newLang}${stripped === "/" ? "" : stripped}`;
    setLocation(newPath, { replace: true });
  }

  return (
    <div className="min-h-screen flex flex-col font-sans" dir={isRTL ? "rtl" : "ltr"}>
      <a href="#main-content" className="skip-to-content">
        {t("a11y.skipToContent")}
      </a>
      <header className="sticky top-0 z-50 w-full glass border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <Link href={localePath("/")} className="flex items-center gap-2 group">
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={companyName}
                className="h-10 max-w-[180px] object-contain group-hover:scale-105 transition-transform duration-300"
              />
            ) : (
              <>
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white shadow-lg group-hover:scale-105 transition-transform duration-300">
                  <GraduationCap className="w-6 h-6" />
                </div>
                <span className="font-display font-bold text-2xl tracking-tight text-foreground">
                  {companyName}
                </span>
              </>
            )}
          </Link>

          <nav aria-label="Main navigation" className="hidden md:flex items-center gap-8 font-medium text-sm text-muted-foreground">
            {navLinks.map((link) => (
              <Link key={link.href} href={link.href} className="hover:text-primary transition-colors">
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <div className="relative" ref={langRef}>
              <button
                onClick={() => setLangOpen(!langOpen)}
                className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors text-sm font-medium"
                aria-label="Select language"
              >
                <CountryFlag code={LANGUAGE_COUNTRY_CODES[lang]} size="sm" alt="" />
                <span className="text-foreground">{currentMeta.code.toUpperCase()}</span>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${langOpen ? "rotate-180" : ""}`} />
              </button>
              {langOpen && (
                <div className={`absolute top-full mt-2 ${isRTL ? "left-0" : "right-0"} bg-card border border-border rounded-xl shadow-xl py-2 min-w-[200px] z-50 max-h-[400px] overflow-y-auto`}>
                  {SUPPORTED_LANGUAGES.map((code) => {
                    const meta = LANGUAGE_META[code];
                    return (
                      <button
                        key={code}
                        onClick={() => handleLangSwitch(code)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-secondary/80 transition-colors ${
                          code === lang ? "bg-primary/10 text-primary font-semibold" : "text-foreground"
                        }`}
                      >
                        <CountryFlag code={LANGUAGE_COUNTRY_CODES[code]} size="md" alt="" />
                        <span>{meta.nativeName}</span>
                        <span className="text-muted-foreground text-xs ms-auto">{meta.code.toUpperCase()}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <Button asChild className="rounded-full px-6 shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 transition-all duration-300 hover:-translate-y-0.5">
              <Link href={localePath("/login")}>{t("nav.login")}</Link>
            </Button>

            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" onClick={() => setMobileOpen(!mobileOpen)}>
              {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </Button>
          </div>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t bg-background/95 backdrop-blur-md">
            <nav className="max-w-7xl mx-auto px-4 py-4 flex flex-col gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="px-4 py-3 rounded-lg hover:bg-secondary/80 text-foreground font-medium transition-colors"
                  onClick={() => setMobileOpen(false)}
                >
                  {link.label}
                </Link>
              ))}
              <div className="border-t mt-2 pt-2">
                <p className="px-4 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">
                  {t("nav.home") === "Home" ? "Language" : ""}
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {SUPPORTED_LANGUAGES.map((code) => {
                    const meta = LANGUAGE_META[code];
                    return (
                      <button
                        key={code}
                        onClick={() => { handleLangSwitch(code); setMobileOpen(false); }}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm ${
                          code === lang ? "bg-primary/10 text-primary font-semibold" : "text-foreground hover:bg-secondary/80"
                        }`}
                      >
                        <CountryFlag code={LANGUAGE_COUNTRY_CODES[code]} size="sm" alt="" />
                        <span>{meta.nativeName}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </nav>
          </div>
        )}
      </header>

      <main id="main-content" className="flex-1">
        {children}
      </main>

      <footer className="bg-foreground text-white/70 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center gap-2 mb-6">
                {logoUrl ? (
                  <img src={logoUrl} alt={companyName} className="h-8 max-w-[160px] object-contain brightness-0 invert" loading="lazy" />
                ) : (
                  <>
                    <GraduationCap className="w-8 h-8 text-primary" />
                    <span className="font-display font-bold text-2xl text-white">
                      {settings.publicBrandName || companyName}
                    </span>
                  </>
                )}
              </div>
              <p className="max-w-md">
                {settings.footerDescription || t("footer.description")}
              </p>
              {(settings.socialInstagram || settings.socialFacebook || settings.socialLinkedin || settings.socialTwitter || settings.socialYoutube || settings.socialTiktok) && (
                <div className="flex items-center gap-3 mt-6 flex-wrap">
                  {settings.socialInstagram && (
                    <a href={settings.socialInstagram} target="_blank" rel="noopener noreferrer"
                      aria-label="Instagram"
                      className="w-9 h-9 rounded-full bg-white/10 hover:bg-primary/80 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
                    </a>
                  )}
                  {settings.socialFacebook && (
                    <a href={settings.socialFacebook} target="_blank" rel="noopener noreferrer"
                      aria-label="Facebook"
                      className="w-9 h-9 rounded-full bg-white/10 hover:bg-primary/80 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                    </a>
                  )}
                  {settings.socialLinkedin && (
                    <a href={settings.socialLinkedin} target="_blank" rel="noopener noreferrer"
                      aria-label="LinkedIn"
                      className="w-9 h-9 rounded-full bg-white/10 hover:bg-primary/80 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                    </a>
                  )}
                  {settings.socialTwitter && (
                    <a href={settings.socialTwitter} target="_blank" rel="noopener noreferrer"
                      aria-label="X / Twitter"
                      className="w-9 h-9 rounded-full bg-white/10 hover:bg-primary/80 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    </a>
                  )}
                  {settings.socialYoutube && (
                    <a href={settings.socialYoutube} target="_blank" rel="noopener noreferrer"
                      aria-label="YouTube"
                      className="w-9 h-9 rounded-full bg-white/10 hover:bg-primary/80 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                    </a>
                  )}
                  {settings.socialTiktok && (
                    <a href={settings.socialTiktok} target="_blank" rel="noopener noreferrer"
                      aria-label="TikTok"
                      className="w-9 h-9 rounded-full bg-white/10 hover:bg-primary/80 flex items-center justify-center transition-colors">
                      <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>
                    </a>
                  )}
                </div>
              )}
            </div>
            <div>
              <h4 className="text-white font-bold mb-6 font-display">{t("footer.quickLinks")}</h4>
              <ul className="space-y-3">
                <li><Link href={localePath("/programs")} className="hover:text-primary transition-colors">{t("footer.findPrograms")}</Link></li>
                <li><Link href={localePath("/countries")} className="hover:text-primary transition-colors">{t("footer.studyDestinations")}</Link></li>
                <li><Link href={localePath("/about")} className="hover:text-primary transition-colors">{t("footer.ourServices")}</Link></li>
                <li><Link href={localePath("/blog")} className="hover:text-primary transition-colors">{t("footer.studentBlog")}</Link></li>
                <li><Link href={localePath("/agency/apply")} className="hover:text-primary transition-colors">{t("footer.becomePartner")}</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="text-white font-bold mb-6 font-display">{t("footer.contactTitle")}</h4>
              <ul className="space-y-3">
                {settings.companyEmail && (
                  <li className="flex items-start gap-2">
                    <Mail className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                    <a href={`mailto:${settings.companyEmail}`} className="hover:text-primary transition-colors break-all">
                      {settings.companyEmail}
                    </a>
                  </li>
                )}
                {settings.companyPhone && (
                  <li className="flex items-start gap-2">
                    <Phone className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                    <a href={`tel:${settings.companyPhone.replace(/\s/g, "")}`} className="hover:text-primary transition-colors">
                      {settings.companyPhone}
                    </a>
                  </li>
                )}
                {(settings.companyAddress || settings.companyCity) && (
                  <li className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
                    <span>
                      {[settings.companyAddress, settings.companyCity, settings.companyCountry]
                        .filter(Boolean).join(", ")}
                    </span>
                  </li>
                )}
                {settings.workingHours && (
                  <li className="text-sm text-white/50">{settings.workingHours}</li>
                )}
              </ul>
            </div>
          </div>
          <div className="border-t border-white/10 mt-12 pt-6 text-center text-sm text-white/40">
            {settings.footerCopyright || `© ${new Date().getFullYear()} ${settings.publicBrandName || companyName}. All rights reserved.`}
          </div>
        </div>
      </footer>
      <CookieBanner />
    </div>
  );
}
