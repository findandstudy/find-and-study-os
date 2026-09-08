import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { createDocumentRecord, uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { toLatinUpper } from "@/lib/textTransform";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  User, Globe, Shield, Save, Check, GraduationCap,
  Loader2, FileText, MapPin, Phone, Mail, Calendar, Camera,
  BookOpen, Languages, Award, Upload, FolderOpen, Download,
  CheckCircle2, X, AlertTriangle,
} from "lucide-react";
import { CountryFlag } from "@/components/CountryFlag";
import { PhoneInput } from "@/components/ui/phone-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { validateFileObj as validateFile, sanitizeFileName, ACCEPT_ATTRIBUTE, FILE_UPLOAD_HELP_TEXT } from "@/lib/fileUploadValidation";
import { StudentDocChecklist } from "@/components/StudentDocChecklist";
import { performLogout } from "@/lib/logout";
import { DocumentScanner } from "@/components/DocumentScanner";
import { SYSTEM_LANGUAGE_OPTIONS } from "@/lib/i18n";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const DOC_TYPES = [
  { key: "passport" },
  { key: "diploma" },
  { key: "transcript" },
  { key: "photo" },
  { key: "language_certificate" },
  { key: "cv" },
  { key: "motivation_letter" },
  { key: "recommendation" },
  { key: "other" },
];

const LANGUAGES = SYSTEM_LANGUAGE_OPTIONS;

export default function StudentAccount() {
  const { user } = useAuth(true);
  const { t, lang, setLang } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "" });
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const emptyStudentForm = {
    nationality: "", dateOfBirth: "",
    passportNumber: "", passportIssueDate: "", passportExpiry: "",
    motherName: "", fatherName: "", address: "",
    highSchool: "", universityBachelor: "", universityMaster: "",
    graduationYear: "", gpa: "", languageScore: "",
  };
  const [studentForm, setStudentForm] = useState(emptyStudentForm);
  const [savingStudent, setSavingStudent] = useState(false);

  useEffect(() => {
    if (user) {
      setForm({
        firstName: user.firstName || "",
        lastName:  user.lastName  || "",
        phone:     (user as any).phone || "",
      });
    }
  }, [user]);

  const { data: studentProfile, isLoading: profileLoading } = useQuery<any>({
    queryKey: ["student-me"],
    enabled: !!user,
    queryFn: async () => {
      try {
        return await customFetch("/api/students/me");
      } catch {
        return null;
      }
    },
  });

  const { data: countriesResp } = useQuery({
    queryKey: ["all-countries-nationality"],
    queryFn: async () => customFetch("/api/countries?limit=500"),
    staleTime: 5 * 60_000,
  });
  const nationalityOptions = ((countriesResp as any)?.data ?? []).map((c: any) => ({
    value: c.name,
    label: c.name,
    icon: c.code ? <CountryFlag code={c.code} size="sm" /> : undefined,
  }));

  useEffect(() => {
    if (studentProfile) {
      setStudentForm({
        nationality: studentProfile.nationality || "",
        dateOfBirth: studentProfile.dateOfBirth || "",
        passportNumber: studentProfile.passportNumber || "",
        passportIssueDate: studentProfile.passportIssueDate || "",
        passportExpiry: studentProfile.passportExpiry || "",
        motherName: studentProfile.motherName || "",
        fatherName: studentProfile.fatherName || "",
        address: studentProfile.address || "",
        highSchool: studentProfile.highSchool || "",
        universityBachelor: studentProfile.universityBachelor || "",
        universityMaster: studentProfile.universityMaster || "",
        graduationYear: studentProfile.graduationYear ? String(studentProfile.graduationYear) : "",
        gpa: studentProfile.gpa || "",
        languageScore: studentProfile.languageScore || "",
      });
    }
  }, [studentProfile]);

  async function handleSaveProfile() {
    if (!user) return;
    setSaving(true);
    try {
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName:  form.lastName,
          phone:     form.phone || undefined,
        }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: t("account.toastProfileUpdated"), description: t("account.toastProfileUpdatedDesc") });
    } catch (err: any) {
      toast({ title: t("account.toastError"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveLang(code: string) {
    if (!user) return;
    setLang(code as any);
    try {
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
    } catch {}
  }

  async function handleSaveStudentInfo() {
    if (!user) return;
    setSavingStudent(true);
    try {
      await customFetch("/api/students/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...studentForm,
          graduationYear: studentForm.graduationYear ? parseInt(studentForm.graduationYear, 10) : null,
        }),
      });
      await qc.invalidateQueries({ queryKey: ["student-me"] });
      toast({ title: t("account.toastStudentUpdated"), description: t("account.toastStudentUpdatedDesc") });
    } catch (err: any) {
      toast({ title: t("account.toastError"), description: err.message, variant: "destructive" });
    } finally {
      setSavingStudent(false);
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: t("account.toastInvalidFile"), description: t("account.toastInvalidFileDesc"), variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: t("account.toastFileTooLarge"), description: t("account.toastFileTooLargeDesc"), variant: "destructive" });
      return;
    }
    setUploadingAvatar(true);
    try {
      const { uploadURL, objectPath } = await customFetch<{ uploadURL: string; objectPath: string }>("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `avatar-${user.id}-${Date.now()}.${file.name.split(".").pop()}`, size: file.size, contentType: file.type }),
      });
      const uploadRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!uploadRes.ok) throw new Error(t("account.errUploadImageFailed"));
      const avatarUrl = `/api/storage/objects/${objectPath.replace(/^\/objects\//, "")}`;
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: t("account.toastPhotoUpdated"), description: t("account.toastPhotoUpdatedDesc") });
    } catch (err: any) {
      toast({ title: t("account.toastError"), description: err.message, variant: "destructive" });
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const initials = `${user?.firstName?.[0] || ""}${user?.lastName?.[0] || user?.email?.[0] || "?"}`.toUpperCase();

  return (
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">{t("studentAccount.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("studentAccount.subtitle")}</p>
        </div>

        <Tabs defaultValue="profile">
          <TabsList className="rounded-xl bg-secondary/50 p-1">
            <TabsTrigger value="profile"     className="rounded-lg gap-2"><User className="w-4 h-4" /> {t("account.profileTab")}</TabsTrigger>
            <TabsTrigger value="student"     className="rounded-lg gap-2"><GraduationCap className="w-4 h-4" /> {t("account.studentInfoTab")}</TabsTrigger>
            <TabsTrigger value="documents"   className="rounded-lg gap-2"><FolderOpen className="w-4 h-4" /> {t("account.documentsTab")}</TabsTrigger>
            <TabsTrigger value="language"    className="rounded-lg gap-2"><Globe className="w-4 h-4" /> {t("account.languageTab")}</TabsTrigger>
            <TabsTrigger value="security"    className="rounded-lg gap-2"><Shield className="w-4 h-4" /> {t("account.securityTab")}</TabsTrigger>
          </TabsList>

          {/* ── Profile ── */}
          <TabsContent value="profile" className="mt-6">
            <Card className="border-none shadow-lg shadow-black/5 p-6">
              <h2 className="font-display font-bold text-lg mb-6">{t("account.personalInformation")}</h2>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <div className="flex items-center gap-5 mb-8 p-5 rounded-2xl bg-gradient-to-r from-primary/5 to-accent/5 border border-primary/10">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="relative w-20 h-20 rounded-2xl overflow-hidden shrink-0 group cursor-pointer"
                >
                  {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-white font-display font-bold text-2xl shadow-lg">
                      {initials}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl">
                    {uploadingAvatar ? (
                      <Loader2 className="w-6 h-6 text-white animate-spin" />
                    ) : (
                      <Camera className="w-6 h-6 text-white" />
                    )}
                  </div>
                </button>
                <div>
                  <p className="font-display font-bold text-lg text-foreground">{user?.firstName} {user?.lastName}</p>
                  <p className="text-muted-foreground text-sm">{user?.email}</p>
                  <Badge className="bg-green-500/10 text-green-600 border-green-200 text-xs mt-2">{t("account.studentBadge")}</Badge>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-5">
                <div className="space-y-1.5">
                  <Label>{t("account.firstName")}</Label>
                  <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: toLatinUpper(e.target.value) }))} className="rounded-xl uppercase" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("account.lastName")}</Label>
                  <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: toLatinUpper(e.target.value) }))} className="rounded-xl uppercase" />
                </div>
                <div className="sm:col-span-2 space-y-1.5">
                  <Label className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> {t("account.emailLabel")}</Label>
                  <Input type="email" value={user?.email || ""} disabled className="rounded-xl bg-secondary/40 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">{t("account.emailManaged")}</p>
                </div>
                <div className="sm:col-span-2 space-y-1.5">
                  <Label className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> {t("account.phoneLabel")}</Label>
                  <PhoneInput value={form.phone} onChange={phone => setForm(f => ({ ...f, phone }))} />
                </div>
              </div>
              <Button onClick={handleSaveProfile} disabled={saving} className="mt-6 rounded-xl gap-2 px-8">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t("account.saveChanges")}
              </Button>
            </Card>
          </TabsContent>

          {/* ── Student Info ── */}
          <TabsContent value="student" className="mt-6">
            <Card className="border-none shadow-lg shadow-black/5 p-6">
              <h2 className="font-display font-bold text-lg mb-6">{t("account.studentRecord")}</h2>
              {profileLoading ? (
                <div className="space-y-3">
                  {[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-secondary animate-pulse rounded-xl" />)}
                </div>
              ) : (
                <div className="space-y-6">
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5" /> {t("account.personalDetails")}
                    </p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label>{t("account.nationality")}</Label>
                        <SearchableSelect
                          value={studentForm.nationality}
                          onValueChange={v => setStudentForm(f => ({ ...f, nationality: v }))}
                          options={nationalityOptions}
                          placeholder={t("account.selectCountry")}
                          className="rounded-xl"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.dateOfBirth")}</Label>
                        <Input type="date" value={studentForm.dateOfBirth} onChange={e => setStudentForm(f => ({ ...f, dateOfBirth: e.target.value }))} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.motherName")}</Label>
                        <Input value={studentForm.motherName} onChange={e => setStudentForm(f => ({ ...f, motherName: toLatinUpper(e.target.value) }))} placeholder={t("account.motherNamePlaceholder")} className="rounded-xl uppercase" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.fatherName")}</Label>
                        <Input value={studentForm.fatherName} onChange={e => setStudentForm(f => ({ ...f, fatherName: toLatinUpper(e.target.value) }))} placeholder={t("account.fatherNamePlaceholder")} className="rounded-xl uppercase" />
                      </div>
                      <div className="sm:col-span-2 space-y-1.5">
                        <Label className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> {t("account.address")}</Label>
                        <Textarea value={studentForm.address} onChange={e => setStudentForm(f => ({ ...f, address: e.target.value }))} placeholder={t("account.addressPlaceholder")} className="rounded-xl resize-none" rows={2} />
                      </div>
                    </div>
                  </div>

                  <hr className="border-border/40" />

                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5" /> {t("account.passportInformation")}
                    </p>
                    <div className="grid sm:grid-cols-3 gap-4">
                      <div className="space-y-1.5">
                        <Label>{t("account.passportNumber")}</Label>
                        <Input value={studentForm.passportNumber} onChange={e => setStudentForm(f => ({ ...f, passportNumber: e.target.value }))} placeholder={t("account.passportNumberPlaceholder")} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.issueDate")}</Label>
                        <Input type="date" value={studentForm.passportIssueDate} onChange={e => setStudentForm(f => ({ ...f, passportIssueDate: e.target.value }))} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.expiryDate")}</Label>
                        <Input type="date" value={studentForm.passportExpiry} onChange={e => setStudentForm(f => ({ ...f, passportExpiry: e.target.value }))} className="rounded-xl" />
                      </div>
                    </div>
                  </div>

                  <hr className="border-border/40" />

                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                      <GraduationCap className="w-3.5 h-3.5" /> {t("account.education")}
                    </p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label>{t("account.highSchool")}</Label>
                        <Input value={studentForm.highSchool} onChange={e => setStudentForm(f => ({ ...f, highSchool: e.target.value }))} placeholder={t("account.highSchoolPlaceholder")} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.graduationYear")}</Label>
                        <Input type="number" value={studentForm.graduationYear} onChange={e => setStudentForm(f => ({ ...f, graduationYear: e.target.value }))} placeholder={t("account.graduationYearPlaceholder")} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.universityBachelor")}</Label>
                        <Input value={studentForm.universityBachelor} onChange={e => setStudentForm(f => ({ ...f, universityBachelor: e.target.value }))} placeholder={t("account.universityBachelorPlaceholder")} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("account.universityMaster")}</Label>
                        <Input value={studentForm.universityMaster} onChange={e => setStudentForm(f => ({ ...f, universityMaster: e.target.value }))} placeholder={t("account.universityMasterPlaceholder")} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="flex items-center gap-1.5"><Award className="w-3.5 h-3.5" /> {t("account.gpa")}</Label>
                        <Input value={studentForm.gpa} onChange={e => setStudentForm(f => ({ ...f, gpa: e.target.value }))} placeholder={t("account.gpaPlaceholder")} className="rounded-xl" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="flex items-center gap-1.5"><Languages className="w-3.5 h-3.5" /> {t("account.languageScore")}</Label>
                        <Input value={studentForm.languageScore} onChange={e => setStudentForm(f => ({ ...f, languageScore: e.target.value }))} placeholder={t("account.languageScorePlaceholder")} className="rounded-xl" />
                      </div>
                    </div>
                  </div>

                  <Button onClick={handleSaveStudentInfo} disabled={savingStudent} className="rounded-xl gap-2 px-8">
                    {savingStudent ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    {t("account.saveStudentInfo")}
                  </Button>
                </div>
              )}
            </Card>
          </TabsContent>

          {/* ── Documents ── */}
          <TabsContent value="documents" className="mt-6">
            <StudentDocumentsTab user={user} studentProfile={studentProfile} />
          </TabsContent>

          {/* ── Language ── */}
          <TabsContent value="language" className="mt-6">
            <Card className="border-none shadow-lg shadow-black/5 p-6">
              <h2 className="font-display font-bold text-lg mb-6">{t("account.languagePreference")}</h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {LANGUAGES.map(l => (
                  <button key={l.code} onClick={() => handleSaveLang(l.code)}
                    className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all hover:border-primary/50
                      ${lang === l.code ? "border-primary bg-primary/5 shadow-sm shadow-primary/10" : "border-border hover:bg-secondary/30"}`}>
                    <CountryFlag code={l.country} size="xl" />
                    <div className="flex-1">
                      <p className="font-bold text-foreground">{l.label}</p>
                      <p className="text-xs text-muted-foreground">{l.code.toUpperCase()}</p>
                    </div>
                    {lang === l.code && <Check className="w-5 h-5 text-primary" />}
                  </button>
                ))}
              </div>
            </Card>
          </TabsContent>

          {/* ── Security ── */}
          <TabsContent value="security" className="mt-6">
            <Card className="border-none shadow-lg shadow-black/5 p-6">
              <h2 className="font-display font-bold text-lg mb-6">{t("account.securityTitle")}</h2>
              <div className="space-y-4">
                <div className="p-5 rounded-xl bg-blue-50 border border-blue-200">
                  <p className="font-bold text-blue-800 flex items-center gap-2">
                    <Shield className="w-5 h-5" /> {t("account.securedAccount")}
                  </p>
                  <p className="text-sm text-blue-700 mt-2">
                    {t("account.securedAccountDesc")}
                  </p>
                </div>
                <div className="p-5 rounded-xl border border-border/50 space-y-2">
                  <p className="font-semibold text-foreground">{t("account.accountDetails")}</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t("account.roleLabel")}</span>
                    <Badge className="bg-green-500/10 text-green-600 border-green-200 text-xs">{t("account.studentBadge")}</Badge>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t("account.accountId")}</span>
                    <span className="font-mono text-foreground">#{user?.id}</span>
                  </div>
                </div>
                <Button variant="outline" className="w-full rounded-xl text-destructive hover:bg-destructive/5 hover:border-destructive/30" onClick={() => void performLogout()}>
                  {t("account.signOut")}
                </Button>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
  );
}

function PendingMissingDocRequests({ onUploadFor }: { onUploadFor: (row: any) => void }) {
  const { t } = useI18n();
  const { data: rows = [], isLoading } = useQuery<any[]>({
    queryKey: ["student-missing-docs"],
    queryFn: () => customFetch("/api/students/me/missing-docs"),
    staleTime: 30_000,
  });
  if (isLoading || !Array.isArray(rows) || rows.length === 0) return null;

  // Try to resolve a catalog doc-type key to its localized label;
  // fall back to a humanized version of the slug if the key is not
  // in the localized docTypes namespace.
  function localizeDocType(key: string) {
    const localized = t(`docTypes.${key}`);
    if (localized && localized !== `docTypes.${key}`) return localized;
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return (
    <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-600" />
        <h3 className="font-display font-bold text-base text-amber-900">{t("account.pendingRequests")}</h3>
        <span className="text-xs text-amber-700">({rows.length})</span>
      </div>
      <p className="text-xs text-amber-800 mb-3">
        {t("account.pendingRequestsDesc")}
      </p>
      <ul className="space-y-2">
        {rows.map((r) => {
          const responded = !!r.respondedAt;
          return (
          <li key={r.id} className="rounded-xl bg-white/70 border border-amber-200 px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-foreground">
                    {r.isCustom ? r.fileName : localizeDocType(r.fileName)}
                  </span>
                  <Badge variant={r.isCustom ? "secondary" : "outline"} className="text-[10px] h-4 px-1">
                    {r.isCustom ? t("account.badgeCustom") : t("account.badgeCatalog")}
                  </Badge>
                  {responded && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1 border-blue-400 text-blue-700">
                      {t("account.badgeUploadedAwaiting")}
                    </Badge>
                  )}
                </div>
                {r.note && (
                  <p className="text-xs text-muted-foreground mt-1">{r.note}</p>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">
                  {r.universityName ? `${r.universityName} • ` : ""}{r.programName || ""}
                  {r.stageLabel ? ` • ${r.stageLabel}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                className="rounded-lg h-7 px-2 gap-1 text-xs shrink-0"
                onClick={() => onUploadFor(r)}
                disabled={responded}
                title={responded ? t("account.uploadActionPendingTitle") : undefined}
              >
                <Upload className="w-3 h-3" />
                {responded ? t("account.uploadActionPending") : t("account.uploadActionUpload")}
              </Button>
            </div>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

function StudentDocumentsTab({ user, studentProfile }: { user: any; studentProfile: any }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadType, setUploadType] = useState("passport");
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: applicationsResp } = useQuery<any>({
    queryKey: ["student-applications-for-checklist"],
    queryFn: async () => customFetch(`${BASE_URL}/api/applications`),
    staleTime: 30_000,
  });
  const studentApplications: any[] = useMemo(() => {
    const list = (applicationsResp as any)?.data || applicationsResp || [];
    return Array.isArray(list) ? list : [];
  }, [applicationsResp]);
  const activeApp = useMemo(() => {
    const withProg = studentApplications.filter(a => a && a.programId);
    if (withProg.length === 0) return null;
    const sorted = [...withProg].sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
    return sorted[0];
  }, [studentApplications]);

  const { data: documents = [], isLoading } = useQuery<any[]>({
    queryKey: ["student-documents"],
    enabled: !!user,
    queryFn: () => customFetch("/api/documents"),
  });

  function openUpload() {
    setUploadType("passport");
    setUploadFile(null);
    const first = (user?.firstName ?? "").toLowerCase();
    const last = (user?.lastName ?? "").toLowerCase();
    setUploadName(`passport-${first}-${last}`);
    setUploadOpen(true);
  }

  const [pendingForApplicationId, setPendingForApplicationId] = useState<number | null>(null);
  const [pendingForNoteId, setPendingForNoteId] = useState<number | null>(null);
  function openUploadForRequest(row: any) {
    const first = (user?.firstName ?? "").toLowerCase();
    const last = (user?.lastName ?? "").toLowerCase();
    setPendingForApplicationId(typeof row?.applicationId === "number" ? row.applicationId : null);
    setPendingForNoteId(typeof row?.id === "number" ? row.id : null);
    if (row.isCustom) {
      setUploadType("other");
      setUploadName(`${String(row.fileName).toLowerCase().replace(/\s+/g, "-")}-${first}-${last}`);
    } else {
      const type = String(row.fileName || "other");
      setUploadType(type);
      setUploadName(`${type.replace(/_/g, "-")}-${first}-${last}`);
    }
    setUploadFile(null);
    setUploadOpen(true);
  }

  function handleFileSelect(file: File) {
    const validation = validateFile(file);
    if (!validation.valid) {
      toast({ title: t("account.toastFileError"), description: validation.message, variant: "destructive" });
      return;
    }
    const safeFile = new File([file], sanitizeFileName(file.name), { type: file.type });
    setUploadFile(safeFile);
  }

  async function handleUpload() {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(uploadFile);
      // Keep the saved doc-name slug stable across locales by using the
      // canonical key (e.g. "passport"), not the localized label.
      const type = uploadType;
      const first = (user?.firstName ?? "").toLowerCase();
      const last = (user?.lastName ?? "").toLowerCase();
      const docName = uploadName.trim() || `${type}-${first}-${last}`;

      await createDocumentRecord({
        name: docName,
        type: uploadType,
        studentId: studentProfile?.id || null,
        applicationId: pendingForApplicationId || undefined,
        respondingToNoteId: pendingForNoteId || undefined,
        fileKey,
        mimeType,
        sizeBytes,
        originalFileName: uploadFile.name,
      });
      setPendingForApplicationId(null);
      setPendingForNoteId(null);
      await qc.invalidateQueries({ queryKey: ["student-documents"] });
      await qc.invalidateQueries({ queryKey: ["student-missing-docs"] });
      toast({ title: t("account.toastDocUploaded") });
      setUploadOpen(false);
    } catch (err: any) {
      toast({ title: t("account.toastUploadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function buildDownloadFilename(type: string, firstName: string, lastName: string, mimeType: string) {
    const ext = mimeType.includes("pdf") ? "pdf" : mimeType.includes("png") ? "png" : "jpg";
    return `${type}-${firstName}-${lastName}.${ext}`.toLowerCase().replace(/\s+/g, "-");
  }

  const docCountText = documents.length === 1
    ? t("account.documentsCount_one", { count: documents.length })
    : t("account.documentsCount_other", { count: documents.length });

  return (
    <Card className="border-none shadow-lg shadow-black/5 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display font-bold text-lg">{t("account.myDocuments")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{docCountText}</p>
        </div>
        <Button size="sm" onClick={openUpload} className="rounded-xl gap-2" disabled={!studentProfile?.id}>
          <Upload className="w-4 h-4" />
          {t("account.uploadDocument")}
        </Button>
      </div>

      {!studentProfile?.id && (
        <div className="p-4 mb-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
          {t("account.completeStudentInfoFirst")}
        </div>
      )}

      {studentProfile?.id && (
        <div className="mb-5">
          <StudentDocChecklist
            level={activeApp?.level ?? studentProfile.interestedLevel}
            documents={documents}
            compact={false}
            programId={activeApp?.programId ?? null}
          />
        </div>
      )}

      {studentProfile?.id && <PendingMissingDocRequests onUploadFor={openUploadForRequest} />}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-14 bg-secondary animate-pulse rounded-xl" />)}
        </div>
      ) : documents.length === 0 ? (
        <div
          className="p-16 text-center text-muted-foreground cursor-pointer hover:bg-secondary/30 transition-colors rounded-2xl border-2 border-dashed"
          onClick={openUpload}
        >
          <Upload className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">{t("account.noDocumentsYet")}</p>
          <p className="text-xs mt-1">{t("account.noDocumentsHint")}</p>
        </div>
      ) : (
        <div className="bg-card rounded-2xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("account.tableName")}</th>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("account.tableType")}</th>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("account.tableStatus")}</th>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("account.tableUploaded")}</th>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("account.tableFile")}</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc: any) => {
                const dt = DOC_TYPES.find(d => d.key === doc.type);
                const typeLabel = dt ? t(`docTypes.${dt.key}`) : (doc.type?.replace(/_/g, " ") ?? "");
                return (
                <tr key={doc.id} className="border-t hover:bg-primary/5 transition-colors">
                  <td className="px-4 py-3 font-medium">{doc.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{typeLabel}</td>
                  <td className="px-4 py-3">
                    <Badge className={`capitalize text-xs px-2 py-0.5 border-0 rounded-full ${
                      doc.status === "approved" ? "bg-green-500/10 text-green-600" :
                      doc.status === "rejected" ? "bg-red-500/10 text-red-600" :
                      "bg-secondary text-secondary-foreground"
                    }`}>
                      {doc.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {(() => { const d = new Date(doc.createdAt); return isNaN(d.getTime()) ? "—" : `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`; })()}
                  </td>
                  <td className="px-4 py-3">
                    {(doc.fileKey || doc.fileData || doc.fileUrl) && (
                      <button
                        onClick={() => {
                          const mimeType = doc.mimeType || "application/octet-stream";
                          const filename = buildDownloadFilename(doc.type, user?.firstName ?? "", user?.lastName ?? "", mimeType);
                          const link = document.createElement("a");
                          link.href = `${BASE_URL}/api/documents/${doc.id}/download`;
                          link.download = filename;
                          link.click();
                        }}
                        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {t("account.downloadBtn")}
                      </button>
                    )}
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={uploadOpen} onOpenChange={o => { if (!uploading) setUploadOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("account.uploadDocument")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs font-medium text-muted-foreground">{t("account.documentType")}</Label>
              <Select value={uploadType} onValueChange={v => {
                setUploadType(v);
                const first = (user?.firstName ?? "").toLowerCase();
                const last = (user?.lastName ?? "").toLowerCase();
                setUploadName(`${v}-${first}-${last}`);
              }}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map(d => (
                    <SelectItem key={d.key} value={d.key}>{t(`docTypes.${d.key}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs font-medium text-muted-foreground">{t("account.documentName")}</Label>
              <Input
                className="mt-1"
                value={uploadName}
                onChange={e => setUploadName(e.target.value)}
                placeholder={`passport-${(user?.firstName ?? "").toLowerCase()}-${(user?.lastName ?? "").toLowerCase()}`}
              />
            </div>

            <div>
              <Label className="text-xs font-medium text-muted-foreground">{t("account.fileLabel")}</Label>
              <div
                className={`mt-1 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                  dragging ? "border-primary bg-primary/5" : uploadFile ? "border-primary/40 bg-primary/5" : "border-border hover:border-primary/40 hover:bg-secondary/40"
                }`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) handleFileSelect(file);
                }}
              >
                {uploadFile ? (
                  <div className="flex items-center justify-center gap-3">
                    <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
                    <div className="text-left">
                      <p className="text-sm font-medium text-foreground truncate max-w-[240px]">{uploadFile.name}</p>
                      <p className="text-xs text-muted-foreground">{Math.round(uploadFile.size / 1024)} KB</p>
                    </div>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={e => { e.stopPropagation(); setUploadFile(null); }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                    <p className="text-sm font-medium text-muted-foreground">{t("account.dragOrClick")}</p>
                    <p className="text-xs text-muted-foreground mt-1">{FILE_UPLOAD_HELP_TEXT}</p>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="mt-2 w-full inline-flex items-center justify-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 px-3 py-2 rounded-lg hover:bg-primary/5 transition-colors border border-primary/20"
              >
                <Camera className="w-3.5 h-3.5" />
                {t("scanner.scanWithCamera")}
              </button>
              <DocumentScanner
                open={scannerOpen}
                onClose={() => setScannerOpen(false)}
                baseName={uploadType || "scan"}
                onCapture={(f) => handleFileSelect(f)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading}>{t("account.cancelBtn")}</Button>
            <Button onClick={handleUpload} disabled={!uploadFile || uploading}>
              {uploading ? t("account.uploadingBtn") : t("account.uploadBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
