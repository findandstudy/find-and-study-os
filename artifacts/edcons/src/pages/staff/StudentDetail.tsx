import { useState, useRef, useMemo, useEffect, lazy, Suspense } from "react";
import { useLocation } from "wouter";
import { useEntityViewTracker } from "@/hooks/use-entity-view-tracker";
import {
  useGetStudent,
  useListApplications,
  useListDocuments,
  customFetch,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useI18n } from "@/hooks/use-i18n";
import { formatDate } from "@workspace/i18n";
import { fmtDate } from "@/lib/formatDate";
import { useDateFormat } from "@/hooks/use-date-format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneField, isPhoneFieldValid, toPhoneFieldValue } from "@/components/ui/phone-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Mail, Phone, Globe, GraduationCap, FileText, User, Home, Calendar, Upload, X, CheckCircle2, Camera, Download, Trash2, Plus, Loader2, Pencil, Clock, CalendarClock, Copy, Check, Eye, UserPlus } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/apiFetch";
import { useDocumentPreview } from "@/components/DocumentPreviewDialog";
import { getPreviewKind } from "@/components/documentPreview";
import { createDocumentRecord, uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { toLatinUpper } from "@/lib/textTransform";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import { QuickContactButtons } from "@/components/QuickContact";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { OriginBadge } from "@/components/OriginBadge";
import { PortalReadinessBadge } from "@/components/PortalReadinessBadge";
import { AllMessagingHistory } from "@/components/inbox/AllMessagingHistory";
import { AuditLogSection } from "@/components/AuditLogSection";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import { requiredEducationLevels, academicFieldsForLevel, academicGroupForLevel, type EducationLevel } from "@/lib/academicLevels";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { humanizePipelineStageKey } from "@/lib/pipelineStageLabel";
import { invalidateAssignmentWorkspaceQueries, invalidateFollowUpWorkspaceQueries } from "@/lib/workspaceQueryInvalidation";
import { applicationCreationErrorToast } from "@/components/ApplicationCreationErrorToast";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const LazyPdfPhotoAvatar = lazy(() => import("@/components/PdfPhotoAvatar"));

const FALLBACK_DOC_TYPES = [
  { key: "passport", label: "Passport", accept: ".pdf,.jpg,.jpeg,.png" },
  { key: "diploma_certificate", label: "Diploma Certificate", accept: ".pdf,.jpg,.jpeg,.png" },
  { key: "diploma_transcript", label: "Diploma Transcript", accept: ".pdf,.jpg,.jpeg,.png" },
  { key: "photo", label: "Photograph", accept: ".pdf,.jpg,.jpeg,.png" },
  { key: "other_certificates_documents", label: "Other Certificates", accept: ".pdf,.jpg,.jpeg,.png" },
];

interface Props {
  id: number;
  basePath?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  inactive: "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300",
  graduated: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  suspended: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const STAGE_COLORS: Record<string, string> = {
  inquiry: "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300",
  documents_collected: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  submitted: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  offer_received: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  visa_applied: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  visa_approved: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  enrolled: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

function buildDownloadFilename(docType: string, firstName: string, lastName: string, mimeType: string): string {
  const MIME_EXT: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  const ext = MIME_EXT[mimeType] || (mimeType.startsWith("image/") ? mimeType.split("/")[1].split("+")[0] : "bin");
  const sanitize = (s: string) => (s || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${sanitize(docType || "document")}-${sanitize(firstName)}-${sanitize(lastName)}.${ext}`;
}

// ---------------------------------------------------------------------------
// AcademicInfoCard — dynamic level-based academic information (FAZ 4).
// Records come from GET /students/:id/education; required levels derive from
// the applied study level (applications take precedence over interestedLevel).
// PUT is replace-set: saving one level re-sends the whole merged record set.
// ---------------------------------------------------------------------------
const EDUCATION_LEVELS_UI: EducationLevel[] = ["high_school", "bachelor", "master"];

function AcademicInfoCard({
  studentId,
  interestedLevel,
  applications,
  isLoading,
}: {
  studentId: number;
  interestedLevel?: string | null;
  applications?: any[];
  isLoading?: boolean;
}) {
  const { t, dir } = useI18n() as any;
  const { toast } = useToast();
  const qc = useQueryClient();

  // Applied level: pick the most demanding level among the student's
  // applications (C=PhD > B=Master > A=Bachelor/other), deterministic
  // regardless of application order; else fall back to interestedLevel.
  const appliedLevel: string = (() => {
    const GROUP_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };
    let best = "";
    let bestRank = -1;
    for (const a of applications ?? []) {
      const l: string = a.level || a.degree || a.programDegree || "";
      if (!l) continue;
      const rank = GROUP_RANK[academicGroupForLevel(l)] ?? 0;
      if (rank > bestRank) {
        best = l;
        bestRank = rank;
      }
    }
    return best || interestedLevel || "";
  })();
  const required = requiredEducationLevels(appliedLevel);

  const { data: eduResp } = useQuery<any>({
    queryKey: ["student-education", studentId],
    queryFn: () => apiFetch(`${BASE_URL}/api/students/${studentId}/education`).then((r) => r.json()),
    enabled: Number.isFinite(studentId) && studentId > 0,
  });
  const records: any[] = eduResp?.records ?? [];
  const byLevel = new Map<string, any>(records.map((r: any) => [r.level, r]));

  const LEVEL_LABELS: Record<EducationLevel, string> = {
    high_school: t("studentAcademic.highSchool"),
    bachelor: t("studentAcademic.bachelor"),
    master: t("studentAcademic.master"),
  };

  const [editLevel, setEditLevel] = useState<EducationLevel | null>(null);
  const [form, setForm] = useState({ institution: "", program: "", graduationYear: "", gpa: "", languageScore: "" });
  const [saving, setSaving] = useState(false);

  function openEdit(level: EducationLevel) {
    const rec = byLevel.get(level) || {};
    setForm({
      institution: rec.institution ?? "",
      program: rec.program ?? "",
      graduationYear: rec.graduationYear != null ? String(rec.graduationYear) : "",
      gpa: rec.gpa ?? "",
      languageScore: rec.languageScore ?? "",
    });
    setEditLevel(level);
  }

  async function handleSave() {
    if (!editLevel) return;
    setSaving(true);
    try {
      // Replace-set semantics: merge the edited level into the full record set.
      const merged = new Map(byLevel);
      merged.set(editLevel, {
        ...(byLevel.get(editLevel) || {}),
        level: editLevel,
        institution: form.institution || null,
        program: editLevel === "high_school" ? null : (form.program || null),
        graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
        gpa: form.gpa || null,
        languageScore: form.languageScore || null,
      });
      const payload = {
        records: EDUCATION_LEVELS_UI.filter((l) => merged.has(l)).map((l) => {
          const r = merged.get(l);
          return {
            level: l,
            institution: r.institution ?? null,
            program: r.program ?? null,
            graduationYear: r.graduationYear ?? null,
            gpa: r.gpa ?? null,
            gpaRaw: r.gpaRaw ?? null,
            gpaScale: r.gpaScale ?? null,
            languageScore: r.languageScore ?? null,
          };
        }),
      };
      const res = await apiFetch(`${BASE_URL}/api/students/${studentId}/education`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: t("common.saved") });
      setEditLevel(null);
      qc.invalidateQueries({ queryKey: ["student-education", studentId] });
    } catch {
      toast({ title: t("common.error"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4" dir={dir}>
      <h2 className="font-semibold text-foreground">{t("studentAcademic.title")}</h2>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {required.map((level) => {
            const rec = byLevel.get(level);
            const fields = academicFieldsForLevel(level);
            return (
              <div key={level} className="border rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm flex items-center gap-1.5">
                    <GraduationCap className="w-4 h-4 text-primary" />
                    {LEVEL_LABELS[level]}
                  </span>
                  <Button size="sm" variant="outline" className="h-7 text-xs rounded-full" onClick={() => openEdit(level)}>
                    <Pencil className="w-3 h-3 mr-1" />{t("common.edit")}
                  </Button>
                </div>
                <div className="space-y-2 text-sm">
                  {fields.includes("institution") && (
                    <InfoRow icon={<GraduationCap className="w-4 h-4" />} label={level === "high_school" ? t("studentAcademic.highSchool") : t("studentAcademic.university")} value={rec?.institution} />
                  )}
                  {fields.includes("program") && (
                    <InfoRow icon={<FileText className="w-4 h-4" />} label={t("studentAcademic.program")} value={rec?.program} />
                  )}
                  <InfoRow icon={<Calendar className="w-4 h-4" />} label={t("studentAcademic.graduationYear")} value={rec?.graduationYear != null ? String(rec.graduationYear) : null} />
                  <InfoRow icon={<FileText className="w-4 h-4" />} label={t("studentAcademic.gpa")} value={rec?.gpa ? `${rec.gpa}${rec.gpaScale ? ` / ${rec.gpaScale}` : ""}${rec.gpaRaw && rec.gpaRaw !== rec.gpa ? ` (${rec.gpaRaw})` : ""}` : null} />
                  <InfoRow icon={<Globe className="w-4 h-4" />} label={t("studentAcademic.languageScore")} value={rec?.languageScore} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!editLevel} onOpenChange={(o) => { if (!o) setEditLevel(null); }}>
        <DialogContent className="sm:max-w-md" dir={dir}>
          <DialogHeader>
            <DialogTitle>{editLevel ? LEVEL_LABELS[editLevel] : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs font-medium">{editLevel === "high_school" ? t("studentAcademic.highSchool") : t("studentAcademic.university")}</Label>
              <Input value={form.institution} onChange={(e) => setForm((f) => ({ ...f, institution: e.target.value }))} />
            </div>
            {editLevel !== "high_school" && (
              <div>
                <Label className="text-xs font-medium">{t("studentAcademic.program")}</Label>
                <Input value={form.program} onChange={(e) => setForm((f) => ({ ...f, program: e.target.value }))} />
              </div>
            )}
            <div className="flex gap-3">
              <div className="flex-1">
                <Label className="text-xs font-medium">{t("studentAcademic.graduationYear")}</Label>
                <Input type="number" min="1950" max="2100" value={form.graduationYear} onChange={(e) => setForm((f) => ({ ...f, graduationYear: e.target.value }))} />
              </div>
              <div className="flex-1">
                <Label className="text-xs font-medium">{t("studentAcademic.gpa")}</Label>
                <Input value={form.gpa} onChange={(e) => setForm((f) => ({ ...f, gpa: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label className="text-xs font-medium">{t("studentAcademic.languageScore")}</Label>
              <Input value={form.languageScore} onChange={(e) => setForm((f) => ({ ...f, languageScore: e.target.value }))} placeholder="IELTS 6.5" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditLevel(null)}>{t("common.cancel")}</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


export default function StudentDetail({ id, basePath = "/staff" }: Props) {
  const { t, lang } = useI18n();
  const { stages: studentStages } = usePipelineStages("student");
  const { stages: applicationStages } = usePipelineStages("application");
  const studentStageLabelByKey = useMemo(
    () => new Map<string, string>(studentStages.map((stage) => [stage.key, stage.label] as const)),
    [studentStages],
  );
  const applicationStageLabelByKey = useMemo(
    () => new Map<string, string>(applicationStages.map((stage) => [stage.key, stage.label] as const)),
    [applicationStages],
  );
  const getStudentStageLabel = (key?: string | null) =>
    key ? (studentStageLabelByKey.get(key) ?? humanizePipelineStageKey(key)) : "";
  const getApplicationStageLabel = (key?: string | null) =>
    key ? (applicationStageLabelByKey.get(key) ?? humanizePipelineStageKey(key)) : "";
  const dateFormat = useDateFormat();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  useEntityViewTracker("student", id);
  const isAgent = basePath === "/agent";

  const { data: student, isLoading } = useGetStudent(id) as { data: any; isLoading: boolean };
  const { data: applicationsResp } = useListApplications({ studentId: id });
  const { data: documentsResp } = useListDocuments({ studentId: id });

  const applications: any[] = (applicationsResp as any)?.data || applicationsResp || [];
  const documents: any[] = Array.isArray(documentsResp) ? documentsResp : (documentsResp as any)?.data || [];

  // Split the student's applications into 3 groups by WHO created each one.
  // null / unknown created_source falls back to the "student" group (safe default).
  // This only affects the student-profile Applications tab; the main pipeline is untouched.
  const applicationGroups = useMemo(() => {
    const buckets: Record<"student" | "staff" | "automation", any[]> = {
      student: [],
      staff: [],
      automation: [],
    };
    for (const app of applications) {
      const src =
        app?.createdSource === "staff"
          ? "staff"
          : app?.createdSource === "automation"
            ? "automation"
            : "student";
      buckets[src].push(app);
    }
    return [
      { key: "student", titleKey: "studentDetailPage.appGroupStudent", items: buckets.student },
      { key: "staff", titleKey: "studentDetailPage.appGroupStaff", items: buckets.staff },
      { key: "automation", titleKey: "studentDetailPage.appGroupAutomation", items: buckets.automation },
    ] as const;
  }, [applications]);

  // Endpoint-first existence probe (defense-in-depth): /api/students/:id/photo is
  // the single source of truth that serves the bytes (object-storage key, legacy
  // fileData, or fileUrl). Probing it directly means the avatar renders correctly
  // even if the denormalized students.has_photo flag is ever stale. Reads the
  // Content-Type header and cancels the body so we don't download the image twice.
  const [photoRevision, setPhotoRevision] = useState(0);
  const { data: photoMime } = useQuery<string | null>({
    queryKey: ["student-photo-mime", id, photoRevision],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/students/${id}/photo?v=${photoRevision}`, { credentials: "include" });
      if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
      const ct = res.headers.get("content-type") || "image/jpeg";
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return ct;
    },
    enabled: !!id,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const hasPhotoResolved = !!photoMime;

  const photoDoc = useMemo(() => {
    // fileData-only uploads (legacy) have no fileKey/fileUrl in the API response,
    // but /api/students/:id/photo can still serve them. Drive existence off the
    // endpoint probe (with the denormalized flag as a fallback), then scan the
    // documents list for the real doc (needed for download/delete) when present.
    if (hasPhotoResolved || student?.hasPhoto) {
      const photoDocs = documents.filter((d: any) => d.type === "photo" || d.type === "photograph");
      const best = photoDocs.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      // Synthetic sentinel so the display block activates even for fileData-only photos.
      return best ?? { mimeType: photoMime ?? "image/jpeg", fileKey: null, fileUrl: null };
    }
    const photoDocs = documents.filter((d: any) => (d.type === "photo" || d.type === "photograph") && (d.fileKey || d.fileUrl));
    if (photoDocs.length === 0) return null;
    return photoDocs.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [documents, hasPhotoResolved, photoMime, student?.hasPhoto]);
  const currentPhotoUrl = `${BASE_URL}/api/students/${id}/photo?v=${photoRevision}`;

  // Reset load-error state whenever the photo source changes (e.g. new upload, different student).
  useEffect(() => { setPhotoLoadError(false); }, [photoDoc]);

  const { toast } = useToast();
  const { user, hasPermission } = useAuth();
  const { data: agencyProfile } = useQuery<any>({
    queryKey: ["/api/agents/me", "student-document-capability"],
    queryFn: () => customFetch("/api/agents/me"),
    enabled: isAgent,
    staleTime: 5 * 60_000,
  });
  const isAdmin = user && ["super_admin", "admin", "manager"].includes(user.role);
  const canChangeStage = !!isAdmin || hasPermission("students.change_stage");
  const canChangeAssigned = !!isAdmin || hasPermission("records.change_assigned");
  // Task #494: strict rule — assignment dropdown only for admin or current assignee
  const isCurrentStudentAssignee = !!(student?.assignedToId && student.assignedToId === user?.id);
  const isAgentManager = isAgent && !!user && ["agent", "sub_agent"].includes(user.role);
  const canManageAssignment = isAgent ? isAgentManager : (!!isAdmin || isCurrentStudentAssignee);
  const isStudent = user?.role === "student";
  const canSelfAssign = isAgent
    ? user?.role === "agent_staff" && !student?.assignedToId
    : !isAdmin && !isStudent && !isCurrentStudentAssignee && hasPermission("records.assign_button") && !student?.assignedToId;
  const isStaffUser = user && ["super_admin", "admin", "manager", "staff"].includes(user.role);
  const canUploadStudentDocuments = Boolean(!isAgent || agencyProfile?.effectiveFeatures?.lead_document_upload === true);
  const { data: catalogResp } = useQuery<any>({
    queryKey: ["catalog-options"],
    queryFn: () => customFetch("/api/catalog-options"),
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
  const documentTypeOptions = useMemo(() => {
    const rows: any[] = (catalogResp as any)?.grouped?.documents || [];
    const options = rows
      .filter((row: any) => row.isActive !== false)
      .map((row: any) => {
        const metadata = row.metadata || {};
        const label = typeof metadata.label === "string" && metadata.label.trim()
          ? metadata.label.trim()
          : String(row.value).replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        return {
          key: String(row.value),
          label,
          accept: ["photo", "photograph", "passport_photo", "passport_size_photo_specifications"].includes(String(row.value).toLowerCase())
            ? ".pdf,.jpg,.jpeg,.png"
            : typeof metadata.accept === "string" && metadata.accept.trim()
              ? metadata.accept.trim()
              : ".pdf,.jpg,.jpeg,.png",
        };
      });
    return options.length > 0 ? options : FALLBACK_DOC_TYPES;
  }, [catalogResp]);
  const [assigning, setAssigning] = useState(false);
  const [photoLoadError, setPhotoLoadError] = useState(false);

  const { data: staffUsersData } = useQuery<any>({
    queryKey: ["/api/users"],
    queryFn: () => customFetch("/api/users?roles=super_admin,admin,manager,staff,consultant,accountant,editor&limit=100"),
    // Task #494: load for admin AND for the current assignee so they can reassign/unassign
    enabled: !isAgent && !!(isAdmin || (student?.assignedToId && student?.assignedToId === user?.id)),
    staleTime: 5 * 60_000,
  });

  const { data: agentStaffData } = useQuery<any>({
    queryKey: ["/api/agents/me/staff"],
    queryFn: () => customFetch("/api/agents/me/staff?limit=100"),
    enabled: isAgentManager,
    staleTime: 5 * 60_000,
  });
  const assigneeOptions = useMemo(() => {
    if (isAgent) {
      const staff = ((agentStaffData?.data || []) as any[])
        .filter((u: any) => u.isActive !== false)
        .map((u: any) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email }));
      if (user && !staff.some((entry: any) => entry.id === user.id)) {
        staff.unshift({ id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email });
      }
      return staff;
    }
    const list = Array.isArray(staffUsersData) ? staffUsersData : staffUsersData?.data || [];
    const staffRoles = ["super_admin", "admin", "manager", "staff", "consultant", "accountant", "editor"];
    return list.filter((entry: any) => staffRoles.includes(entry.role));
  }, [isAgent, agentStaffData, staffUsersData, user]);

  function getAssignedUserName(assignedToId: number | null | undefined): string | null {
    if (!assignedToId) return null;
    if (assigneeOptions.length > 0) {
      const found = assigneeOptions.find((u: any) => u.id === assignedToId);
      if (found) return `${found.firstName || ''} ${found.lastName || ''}`.trim() || found.email;
    }
    return null;
  }

  async function handleAssign(targetUserId: number | null) {
    setAssigning(true);
    try {
      await customFetch(`/api/students/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: targetUserId }),
      });
      await invalidateAssignmentWorkspaceQueries(qc);
      toast({ title: targetUserId ? t("studentDetailPage.studentAssigned") : t("studentDetailPage.studentUnassigned") });
    } catch (err: any) {
      toast({ title: "Error", description: err?.message, variant: "destructive" });
    } finally {
      setAssigning(false);
    }
  }

  const [noteTab, setNoteTab] = useState<"general" | "internal">("general");
  const [noteText, setNoteText] = useState("");
  const { data: generalNotes = [] } = useQuery<any[]>({
    queryKey: [`/api/students/${id}/notes`, "general"],
    queryFn: () => fetch(`${BASE_URL}/api/students/${id}/notes?internal=false`, { credentials: "include" }).then(r => r.json()).then(j => Array.isArray(j) ? j : []),
    enabled: !!id,
  });
  const { data: internalNotes = [] } = useQuery<any[]>({
    queryKey: [`/api/students/${id}/notes`, "internal"],
    queryFn: () => fetch(`${BASE_URL}/api/students/${id}/notes?internal=true`, { credentials: "include" }).then(r => r.json()).then(j => Array.isArray(j) ? j : []),
    enabled: !!id && !!isStaffUser,
  });
  const selectedNotes = noteTab === "internal" ? internalNotes : generalNotes;
  const activeNotes = Array.isArray(selectedNotes) ? selectedNotes : [];

  async function handleAddNote() {
    if (!noteText.trim()) return;
    try {
      const csrfToken = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1] ? decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)![1]) : "";
      const resp = await fetch(`${BASE_URL}/api/students/${id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        credentials: "include",
        body: JSON.stringify({ content: noteText, isInternal: noteTab === "internal" }),
      });
      if (resp.ok) {
        setNoteText("");
        qc.invalidateQueries({ queryKey: [`/api/students/${id}/notes`, noteTab] });
      }
    } catch {}
  }

  const deleteNote = useMutation({
    mutationFn: async (noteId: number) => {
      const csrfToken = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1]
        ? decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)![1])
        : "";
      const resp = await fetch(`${BASE_URL}/api/students/${id}/notes/${noteId}`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
        credentials: "include",
      });
      if (!resp.ok && resp.status !== 204) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete note");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/students/${id}/notes`, "general"] });
      qc.invalidateQueries({ queryKey: [`/api/students/${id}/notes`, "internal"] });
      toast({ title: "Note deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function handleDeleteNote(noteId: number) {
    if (!window.confirm("Delete this note? This action will be recorded in the audit log.")) return;
    deleteNote.mutate(noteId);
  }

  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [fuTitle, setFuTitle] = useState("");
  const [fuDate, setFuDate] = useState("");
  const [fuTime, setFuTime] = useState("10:00");
  const [fuNotes, setFuNotes] = useState("");
  const [editingFuId, setEditingFuId] = useState<number | null>(null);

  const { data: followUps = [] } = useQuery<any[]>({
    queryKey: [`/api/students/${id}/follow-ups`],
    queryFn: () => fetch(`${BASE_URL}/api/students/${id}/follow-ups`, { credentials: "include" }).then(r => r.json()).then(d => Array.isArray(d) ? d : []),
    enabled: !!id && !!isStaffUser,
  });

  const createFollowUp = useMutation({
    mutationFn: (body: any) =>
      fetch(`${BASE_URL}/api/students/${id}/follow-ups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || "Failed"); }); return r.json(); }),
    onSuccess: async () => {
      await invalidateFollowUpWorkspaceQueries(qc);
      resetFollowUpForm();
      toast({ title: "Follow-up scheduled" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleFollowUp = useMutation({
    mutationFn: ({ fuId, completed }: { fuId: number; completed: boolean }) =>
      fetch(`${BASE_URL}/api/follow-ups/${fuId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ completed }),
      }).then(r => { if (!r.ok) throw new Error("Failed"); return r.json(); }),
    onSuccess: async () => {
      await invalidateFollowUpWorkspaceQueries(qc);
      toast({ title: "Follow-up updated" });
    },
  });

  const editFollowUp = useMutation({
    mutationFn: ({ fuId, body }: { fuId: number; body: any }) =>
      fetch(`${BASE_URL}/api/follow-ups/${fuId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || "Failed"); }); return r.json(); }),
    onSuccess: async () => {
      await invalidateFollowUpWorkspaceQueries(qc);
      resetFollowUpForm();
      toast({ title: "Follow-up updated" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function resetFollowUpForm() {
    setShowFollowUpForm(false);
    setEditingFuId(null);
    setFuTitle("");
    setFuDate("");
    setFuTime("10:00");
    setFuNotes("");
  }

  function handleCreateFollowUp() {
    if (!fuTitle.trim() || !fuDate) return;
    const scheduledAt = new Date(`${fuDate}T${fuTime}`).toISOString();
    if (editingFuId) {
      editFollowUp.mutate({ fuId: editingFuId, body: { title: fuTitle, scheduledAt, notes: fuNotes || null } });
    } else {
      createFollowUp.mutate({ title: fuTitle, scheduledAt, notes: fuNotes || undefined });
    }
  }

  function startEditFollowUp(fu: any) {
    setEditingFuId(fu.id);
    setFuTitle(fu.title);
    const d = new Date(fu.scheduledAt);
    setFuDate(d.toISOString().slice(0, 10));
    setFuTime(d.toTimeString().slice(0, 5));
    setFuNotes(fu.notes || "");
    setShowFollowUpForm(true);
  }

  function isOverdue(scheduledAt: string) {
    return new Date(scheduledAt) < new Date();
  }

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadType, setUploadType] = useState("passport");
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showNewApp, setShowNewApp] = useState(false);
  const [appCountry, setAppCountry] = useState("");
  const [appUniversityId, setAppUniversityId] = useState("");
  const [appProgramId, setAppProgramId] = useState("");
  const [appIntake, setAppIntake] = useState("");
  const [appSubmitting, setAppSubmitting] = useState(false);
  const [deletingAppId, setDeletingAppId] = useState<number | null>(null);
  const canDeleteApplication = !!isAdmin || hasPermission("applications.delete");

  // Source the New Application country + university lists from the Course Finder
  // filters endpoint so they only show destinations that actually have active
  // programs — matching the Course Finder filter exactly (no empty countries
  // like Australia/France that have a university record but no active programs).
  const { data: appFiltersData } = useQuery({
    queryKey: ["app-filters"],
    queryFn: () => customFetch("/api/course-finder/filters") as Promise<{ countries: string[] }>,
    staleTime: 10 * 60 * 1000,
    enabled: showNewApp,
  });
  const countriesList = appFiltersData?.countries;

  const { data: universitiesData } = useQuery({
    queryKey: ["app-universities", appCountry],
    queryFn: () => customFetch(`/api/course-finder/filters?country=${encodeURIComponent(appCountry)}`) as Promise<{ universities: { id: number; name: string }[] }>,
    staleTime: 5 * 60 * 1000,
    enabled: showNewApp && !!appCountry,
  });

  const { data: programsData } = useQuery({
    queryKey: ["app-programs", appUniversityId],
    queryFn: () => customFetch(`/api/course-finder?universityId=${appUniversityId}&limit=500`) as Promise<any>,
    staleTime: 60_000,
    enabled: showNewApp && !!appUniversityId,
  });

  const filteredUniversities: any[] = useMemo(() => {
    return universitiesData?.universities || [];
  }, [universitiesData]);

  const filteredPrograms: any[] = useMemo(() => {
    return programsData?.data || [];
  }, [programsData]);

  const availableIntakes = useMemo(() => {
    if (!appProgramId) return [];
    const prog = filteredPrograms.find((p: any) => String(p.id) === appProgramId);
    if (!prog?.intakes) return [];
    const raw = typeof prog.intakes === "string" ? prog.intakes : "";
    return raw.split(",").map((s: string) => s.trim()).filter(Boolean);
  }, [appProgramId, filteredPrograms]);

  const hasExistingAppAtSameLevel = useMemo(() => {
    if (!appProgramId) return false;
    const prog = filteredPrograms.find((p: any) => String(p.id) === appProgramId);
    if (!prog?.degree) return false;

    function toCanonicalLevel(raw: string): string | null {
      const s = raw.toLowerCase().replace(/['''`\s._-]/g, "");
      if (s.includes("prebachelor")) return "pre_bachelors";
      if (s.includes("associate")) return "associate";
      if (s.includes("bachelor") || s === "undergraduate") return "bachelors";
      if (s.includes("master") || s === "postgraduate") return "masters";
      if (s.includes("doctor") || s.includes("phd") || s.includes("doctorate")) return "phd";
      if (s.includes("language")) return "language";
      if (s.includes("foundation")) return "foundation";
      return null;
    }

    const selectedLevel = toCanonicalLevel(prog.degree);
    if (!selectedLevel) return false;

    return applications.some((app: any) => {
      const appLevel = toCanonicalLevel(app.level || app.degree || "");
      return appLevel === selectedLevel;
    });
  }, [appProgramId, filteredPrograms, applications]);

  const stageSummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of (applications as any[])) {
      const s = a.stage || "unknown";
      counts[s] = (counts[s] || 0) + 1;
    }
    return Object.entries(counts);
  }, [applications]);

  useEffect(() => { setAppUniversityId(""); setAppProgramId(""); setAppIntake(""); }, [appCountry]);
  useEffect(() => { setAppProgramId(""); setAppIntake(""); }, [appUniversityId]);
  useEffect(() => { setAppIntake(""); }, [appProgramId]);

  async function handleQuickApply() {
    if (!appProgramId) return;
    setAppSubmitting(true);
    try {
      const prog = filteredPrograms.find((p: any) => String(p.id) === appProgramId);
      await customFetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: id,
          programId: Number(appProgramId),
          universityId: prog?.universityId ?? null,
          universityName: prog?.universityName ?? null,
          programName: prog?.name ?? null,
          country: prog?.universityCountry ?? appCountry,
          intake: appIntake || null,
          level: prog?.degree ?? null,
          instructionLanguage: prog?.language ?? null,
          tuitionFee: prog?.tuitionFee ?? null,
          stage: "inquiry",
        }),
      });
      toast({ title: "Application created", description: `${prog?.universityName} – ${prog?.name}` });
      await qc.refetchQueries({ queryKey: ["/api/applications"] });
      setShowNewApp(false);
      setAppCountry(""); setAppUniversityId(""); setAppProgramId(""); setAppIntake("");
    } catch (err: any) {
      toast(applicationCreationErrorToast(err, "Could not create application"));
    } finally {
      setAppSubmitting(false);
    }
  }
  async function handleDeleteApplication(app: any) {
    const label = app.universityName ? `\n\n${app.universityName}${app.programName ? ` \u2013 ${app.programName}` : ""}` : "";
    if (!window.confirm(`Delete this application?${label}\n\nThis action will be recorded in the audit log.`)) return;
    setDeletingAppId(app.id);
    try {
      await customFetch(`/api/applications/${app.id}`, { method: "DELETE" });
      toast({ title: "Application deleted" });
      await qc.refetchQueries({ queryKey: ["/api/applications"] });
    } catch (err: any) {
      toast({
        title: "Failed to delete",
        description: err?.data?.error || err?.message || "Could not delete application",
        variant: "destructive",
      });
    } finally {
      setDeletingAppId(null);
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  function openUpload() {
    setUploadType("passport");
    setUploadName("");
    setUploadFile(null);
    setUploadOpen(true);
  }

  function getAcceptForType(t: string) {
    return documentTypeOptions.find((option) => option.key === t)?.accept
      || ".jpg,.jpeg,.png,.pdf";
  }

  function handleFileSelect(file: File) {
    const allowed = ["image/jpeg", "image/png", "application/pdf"];
    if (!allowed.includes(file.type)) {
      toast({ title: "Invalid file type", description: "Only JPG, JPEG, PNG and PDF files are allowed.", variant: "destructive" });
      return;
    }
    setUploadFile(file);
    if (!uploadName) {
      const type = (documentTypeOptions.find(d => d.key === uploadType)?.label ?? "document").toLowerCase();
      const first = (student?.firstName ?? "").toLowerCase();
      const last = (student?.lastName ?? "").toLowerCase();
      setUploadName(`${type}-${first}-${last}`);
    }
  }

  async function handleUpload() {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(uploadFile);
      const type = (documentTypeOptions.find(d => d.key === uploadType)?.label ?? "document").toLowerCase();
      const first = (student?.firstName ?? "").toLowerCase();
      const last = (student?.lastName ?? "").toLowerCase();
      const docName = uploadName.trim() || `${type}-${first}-${last}`;

      await createDocumentRecord({
        name: docName,
        type: uploadType,
        status: "pending",
        studentId: id,
        fileKey,
        mimeType,
        sizeBytes,
        originalFileName: uploadFile.name,
      });

      await qc.invalidateQueries({ predicate: q => q.queryKey.some(k => typeof k === "string" && (k.includes("document") || k.includes("student") || k.includes(`/api/students`))) });
      setUploadOpen(false);
      toast({ title: "Document uploaded" });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err?.message || "The document could not be uploaded.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  async function handlePhotoUpload(file: File) {
    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) return;
    setPhotoUploading(true);
    try {
      const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(file);
      const first = (student?.firstName ?? "").toLowerCase();
      const last = (student?.lastName ?? "").toLowerCase();

      await createDocumentRecord({
        name: `photo-${first}-${last}`,
        type: "photo",
        status: "approved",
        studentId: id,
        fileKey,
        mimeType,
        sizeBytes,
        originalFileName: file.name,
      });

      await qc.invalidateQueries({ predicate: q => q.queryKey.some(k => typeof k === "string" && (k.includes("document") || k.includes("student") || k.includes(`/api/students`))) });
      setPhotoRevision(value => value + 1);
      setPhotoLoadError(false);
      toast({ title: "Photo updated" });
    } catch (err: any) {
      toast({
        title: "Photo upload failed",
        description: err?.message || "The profile photo could not be updated.",
        variant: "destructive",
      });
    } finally {
      setPhotoUploading(false);
    }
  }

  function downloadPhoto() {
    if (!photoDoc) return;
    const mime = photoDoc.mimeType || "image/jpeg";
    const filename = buildDownloadFilename("photo", student?.firstName ?? "", student?.lastName ?? "", mime);
    const link = document.createElement("a");
    link.href = `${BASE_URL}/api/documents/${photoDoc.id}/download`;
    link.download = filename;
    link.click();
  }

  return (
    <>
      <div className="w-full space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation(`${basePath}/students`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="relative group shrink-0">
            {isLoading ? (
              <Skeleton className="w-20 h-20 rounded-full" />
            ) : photoDoc && !photoLoadError ? (
              photoDoc.mimeType === "application/pdf" ? (
                <Suspense fallback={
                  <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center text-primary text-2xl font-bold border-2 border-primary/20">
                    {(student?.firstName?.[0] ?? "").toUpperCase()}{(student?.lastName?.[0] ?? "").toUpperCase()}
                  </div>
                }>
                  <LazyPdfPhotoAvatar
                    src={currentPhotoUrl}
                    alt={`${student?.firstName} ${student?.lastName}`}
                    className="w-20 h-20 rounded-full object-cover border-2 border-primary/20"
                    fallback={
                      <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center text-primary text-2xl font-bold border-2 border-primary/20">
                        {(student?.firstName?.[0] ?? "").toUpperCase()}{(student?.lastName?.[0] ?? "").toUpperCase()}
                      </div>
                    }
                  />
                </Suspense>
              ) : (
                <img
                  src={currentPhotoUrl}
                  alt={`${student?.firstName} ${student?.lastName}`}
                  className="w-20 h-20 rounded-full object-cover border-2 border-primary/20"
                  onError={() => setPhotoLoadError(true)}
                />
              )
            ) : (
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center text-primary text-2xl font-bold border-2 border-primary/20">
                {(student?.firstName?.[0] ?? "").toUpperCase()}{(student?.lastName?.[0] ?? "").toUpperCase()}
              </div>
            )}
            <button
              type="button"
              className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center text-white cursor-pointer"
              title="Upload photo"
              aria-label="Upload profile photo"
              onClick={() => photoInputRef.current?.click()}
              disabled={photoUploading}
            >
              <Camera className="w-5 h-5" />
            </button>
            {photoDoc && (
              <button
                type="button"
                className="absolute -bottom-1 -right-1 z-10 p-1.5 rounded-full bg-background border border-border shadow hover:bg-secondary text-foreground transition-colors"
                title="Download photo"
                aria-label="Download profile photo"
                onClick={downloadPhoto}
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            )}
            {photoUploading && (
              <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <input
              ref={photoInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) handlePhotoUpload(file);
                e.target.value = "";
              }}
            />
          </div>
          <div className="flex-1">
            {isLoading ? (
              <Skeleton className="h-8 w-48" />
            ) : (
              <h1 className="text-2xl font-display font-bold text-foreground">
                {student?.firstName} {student?.lastName}
              </h1>
            )}
            <p className="text-sm text-muted-foreground mt-0.5">{t("studentDetailPage.studentProfile")}</p>
          </div>
          {!isLoading && student && (
            <div className="flex items-center gap-2">
              <QuickContactButtons
                name={`${student.firstName} ${student.lastName}`}
                email={student.email}
                phone={student.phone}
                entityType="student"
                entityId={id}
                hideEmail={isAgent}
                hideWhatsApp={isAgent}
              />
              <PortalReadinessBadge studentId={id} />
              <Badge
                className={`px-3 py-1 rounded-full text-sm font-medium border-0 ${STATUS_COLORS[student.status ?? "active"] ?? "bg-muted text-muted-foreground"}`}
              >
                {getStudentStageLabel(student.status)}
              </Badge>
              {/* T8: Admin can toggle student active/inactive */}
              {canChangeStage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full h-7 px-3"
                  data-testid="student-active-toggle"
                  onClick={() => {
                    const next = (student.status === "inactive") ? "active" : "inactive";
                    customFetch(`/api/students/${student.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: next }),
                    }).then(() => {
                      qc.invalidateQueries({ queryKey: ["getStudent"] });
                      qc.invalidateQueries({ queryKey: [`/api/students/${student.id}`] });
                      qc.invalidateQueries({ queryKey: ["/api/students"] });
                      toast({ title: next === "active" ? t("studentDetailPage.markedAsActive") : t("studentDetailPage.markedAsInactive") });
                    }).catch((err: any) => {
                      toast({ title: t("studentDetailPage.failedToUpdateStatus"), description: err?.message, variant: "destructive" });
                    });
                  }}
                >
                  {student.status === "inactive" ? t("studentDetailPage.markActive") : t("studentDetailPage.markInactive")}
                </Button>
              )}
            </div>
          )}
        </div>

        <Tabs defaultValue="profile">
          <TabsList className="rounded-xl bg-secondary/60">
            <TabsTrigger value="profile">{t("studentDetailPage.profile")}</TabsTrigger>
            <TabsTrigger value="documents">
              {t("studentDetailPage.documents")} {documents.length > 0 && `(${documents.length})`}
            </TabsTrigger>
            <TabsTrigger value="notes">
              {t("studentDetailPage.notes")} ({generalNotes.length + internalNotes.length})
            </TabsTrigger>
            <TabsTrigger value="applications">
              {t("studentDetailPage.applications")} {applications.length > 0 && `(${applications.length})`}
            </TabsTrigger>
            {isStaffUser && (
              <TabsTrigger value="followups">
                {t("studentDetailPage.followUps")} {(followUps as any[]).length > 0 && `(${(followUps as any[]).length})`}
              </TabsTrigger>
            )}
            <TabsTrigger value="messaging">{t("studentDetailPage.allMessaging")}</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="mt-4">
            <div className="flex justify-end mb-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => setShowEditDialog(true)}>
                <Pencil className="w-3.5 h-3.5 mr-1.5" />
                {t("studentDetailPage.editProfile")}
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              <div className="min-w-0 space-y-4">
                <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
                  <h2 className="font-semibold text-foreground">{t("studentDetailPage.personalInformation")}</h2>
                  {isLoading ? (
                    <div className="space-y-3">
                      {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm">
                      <InfoRow icon={<Calendar className="w-4 h-4" />} label={t("studentDetailPage.dateOfBirth")} value={fmtDate(student?.dateOfBirth, dateFormat) || undefined} />
                      <InfoRow icon={<User className="w-4 h-4" />} label={t("studentDetailPage.gender")} value={student?.gender === "female" ? t("studentDetailPage.female") : student?.gender === "male" ? t("studentDetailPage.male") : null} />
                      <InfoRow icon={<Globe className="w-4 h-4" />} label={t("studentDetailPage.nationality")} value={student?.nationality} />
                      <InfoRow icon={<Mail className="w-4 h-4" />} label={t("studentDetailPage.email")} value={student?.email} />
                      <InfoRow icon={<Phone className="w-4 h-4" />} label={t("studentDetailPage.phone")} value={student?.phone} />
                      <InfoRow icon={<User className="w-4 h-4" />} label={t("studentDetailPage.mothersName")} value={student?.motherName} />
                      <InfoRow icon={<User className="w-4 h-4" />} label={t("studentDetailPage.fathersName")} value={student?.fatherName} />
                      <InfoRow icon={<Home className="w-4 h-4" />} label={t("studentDetailPage.address")} value={student?.address} />
                    </div>
                  )}
                </div>

                <AcademicInfoCard
                  studentId={Number(id)}
                  interestedLevel={student?.interestedLevel}
                  applications={applications}
                  isLoading={isLoading}
                />
              </div>

              <div className="min-w-0 space-y-4">
                <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
                  <h2 className="font-semibold text-foreground">Passport / ID</h2>
                  {isLoading ? (
                    <div className="space-y-3">
                      {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm">
                      <InfoRow icon={<FileText className="w-4 h-4" />} label="Passport No" value={student?.passportNumber} />
                      <InfoRow icon={<Calendar className="w-4 h-4" />} label="Issue Date" value={fmtDate(student?.passportIssueDate, dateFormat) || undefined} />
                      <InfoRow icon={<Calendar className="w-4 h-4" />} label="Expiry Date" value={fmtDate(student?.passportExpiry, dateFormat) || undefined} />
                    </div>
                  )}
                </div>

                <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
                  <h2 className="font-semibold text-foreground">{t("studentAcademic.studentInformation")}</h2>
                  {isLoading ? (
                    <div className="space-y-3">
                      {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm">
                      <InfoRow icon={<User className="w-4 h-4" />} label={t("studentAcademic.transferStudent")} value={student?.transferStudent ? t("studentAcademic.yes") : t("studentAcademic.no")} />
                      <InfoRow icon={<FileText className="w-4 h-4" />} label={t("studentAcademic.haveTcId")} value={student?.hasTcId ? t("studentAcademic.yes") : t("studentAcademic.no")} />
                      <InfoRow icon={<FileText className="w-4 h-4" />} label={t("studentAcademic.blueCard")} value={student?.hasBlueCard ? t("studentAcademic.yes") : t("studentAcademic.no")} />
                    </div>
                  )}
                </div>

                <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
                  <h2 className="font-semibold text-foreground flex items-center gap-2">
                    <User className="w-4 h-4" />
                    {t("studentDetailPage.assignedTo")}
                  </h2>
                  {isLoading ? (
                    <Skeleton className="h-8 w-32" />
                  ) : canManageAssignment ? (
                    <Select
                      value={student?.assignedToId ? String(student.assignedToId) : "unassigned"}
                      onValueChange={(val) => handleAssign(val === "unassigned" ? null : Number(val))}
                      disabled={assigning}
                    >
                      <SelectTrigger className="w-full h-8 text-sm">
                        <SelectValue placeholder={t("studentDetailPage.selectAssignee")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unassigned">{t("studentDetailPage.unassigned")}</SelectItem>
                        {assigneeOptions.map((u: any) => (
                          <SelectItem key={u.id} value={String(u.id)}>
                            {u.id === user?.id ? `${u.firstName || ''} ${u.lastName || ''} (You)`.trim() : `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : canSelfAssign ? (
                    <button
                      onClick={() => handleAssign(user!.id)}
                      disabled={assigning}
                      className="text-sm text-primary hover:underline font-medium flex items-center gap-1 disabled:opacity-50"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      {assigning ? t("studentDetailPage.assigning") : t("studentDetailPage.assignToMe")}
                    </button>
                  ) : student?.assignedToId ? (
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span className="text-sm font-medium">{getAssignedUserName(student.assignedToId) || "—"}</span>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("studentDetailPage.unassigned")}</p>
                  )}
                </div>

                {!isAgent && (
                <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
                  <h2 className="font-semibold text-foreground flex items-center gap-2">
                    <Globe className="w-4 h-4" />
                    Origin
                  </h2>
                  {isLoading ? (
                    <Skeleton className="h-8 w-32" />
                  ) : (
                    <div className="space-y-2">
                      <OriginBadge originType={student?.originType || "direct"} originDisplayName={student?.originDisplayName} className="text-xs" />
                      {isAdmin && (
                        <Select
                          value={student?.originType || "direct"}
                          onValueChange={(val) => {
                            customFetch(`/api/students/${id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                originType: val,
                                originDisplayName: val === "direct" ? "Find And Study" : null,
                              }),
                            }).then(() => {
                              qc.invalidateQueries({ queryKey: [`/api/students/${id}`] });
                              toast({ title: "Origin updated" });
                            });
                          }}
                        >
                          <SelectTrigger className="w-full h-8 text-sm">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="direct">{t("studentDetailPage.direct")}</SelectItem>
                            <SelectItem value="agent">{t("studentDetailPage.agentLabel")}</SelectItem>
                            <SelectItem value="sub_agent">Sub-Agent</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}
                </div>
                )}
              </div>
            </div>

            {student?.notes && (
              <div className="mt-4 bg-card rounded-2xl border shadow-sm p-6">
                <h2 className="font-semibold text-foreground mb-2">Notes</h2>
                <p className="text-sm text-foreground">{student.notes}</p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="notes" className="mt-4">
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold text-foreground">Notes</h2>
              </div>

              <div className="flex gap-1 border-b">
                <button
                  onClick={() => setNoteTab("general")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${noteTab === "general" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  General ({generalNotes.length})
                </button>
                {isStaffUser && (
                  <button
                    onClick={() => setNoteTab("internal")}
                    className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${noteTab === "internal" ? "border-orange-500 text-orange-600" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    🔒 Private ({internalNotes.length})
                  </button>
                )}
              </div>

              <div className="space-y-3 max-h-80 overflow-y-auto">
                {activeNotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No notes yet.</p>
                ) : (
                  activeNotes.map((note: any) => (
                    <div key={note.id} className={`group relative rounded-xl p-3 ${noteTab === "internal" ? "bg-orange-50 border border-orange-200" : "bg-secondary/50"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground whitespace-pre-wrap break-words">{note.content}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {note.authorName || "Team"} · {new Date(note.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        {isStaffUser && (
                          <button
                            type="button"
                            onClick={() => handleDeleteNote(note.id)}
                            disabled={deleteNote.isPending}
                            className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50"
                            aria-label="Delete note"
                            title="Delete note"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {!isStudent && (noteTab === "general" || isStaffUser) && (
                <div className="flex gap-2 pt-2 border-t">
                  <textarea
                    placeholder={noteTab === "internal" ? "Add a private note (only visible to staff)..." : "Add a note..."}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    className={`flex-1 resize-none min-h-[72px] rounded-md border px-3 py-2 text-sm ${noteTab === "internal" ? "border-orange-300 focus:ring-orange-400" : "border-input"}`}
                  />
                  <Button
                    onClick={handleAddNote}
                    disabled={!noteText.trim()}
                    className={`self-end ${noteTab === "internal" ? "bg-orange-500 hover:bg-orange-600" : ""}`}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="applications" className="mt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-muted-foreground">{applications.length} application{applications.length !== 1 ? "s" : ""}</p>
              <Button size="sm" onClick={() => setShowNewApp(!showNewApp)}>
                <Plus className="w-4 h-4 mr-1" />
                New Application
              </Button>
            </div>

            {showNewApp && (
              <div className="bg-card rounded-2xl border shadow-sm p-4 mb-4">
                <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 2fr 1fr" }}>
                  <div>
                    <Label className="text-xs font-medium mb-1 block">Country</Label>
                    <SearchableSelect
                      value={appCountry}
                      onChange={setAppCountry}
                      options={(countriesList || []).map((c: string) => ({ value: c, label: c }))}
                      placeholder="Select Country"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium mb-1 block">University</Label>
                    <SearchableSelect
                      value={appUniversityId}
                      onChange={setAppUniversityId}
                      options={filteredUniversities.map((u: any) => ({ value: String(u.id), label: u.name }))}
                      placeholder={!appCountry ? "Select country first" : "Select University"}
                      disabled={!appCountry}
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium mb-1 block">Course</Label>
                    <SearchableSelect
                      value={appProgramId}
                      onChange={setAppProgramId}
                      options={filteredPrograms.map((p: any) => ({ value: String(p.id), label: p.name }))}
                      placeholder={!appUniversityId ? "Select university first" : "Select Course"}
                      disabled={!appUniversityId}
                      minDropdownWidth={560}
                      wrapItems
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium mb-1 block">Intake</Label>
                    <SearchableSelect
                      value={appIntake}
                      onChange={setAppIntake}
                      options={availableIntakes.map((i: string) => ({ value: i, label: i }))}
                      placeholder={availableIntakes.length === 0 ? "Select course first" : "Select Intake"}
                      disabled={availableIntakes.length === 0}
                    />
                  </div>
                </div>
                {hasExistingAppAtSameLevel && appProgramId && (
                  <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm font-medium text-blue-700">Documents already on file from a previous application at the same level.</p>
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-3">
                  <Button variant="outline" size="sm" onClick={() => { setShowNewApp(false); setAppCountry(""); setAppUniversityId(""); setAppProgramId(""); setAppIntake(""); }}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={!appProgramId || appSubmitting} onClick={handleQuickApply}>
                    {appSubmitting && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    Create Application
                  </Button>
                </div>
              </div>
            )}

            {applications.length === 0 ? (
              <div className="bg-card rounded-2xl border shadow-sm">
                <div className="px-6 py-14 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <GraduationCap className="w-7 h-7 text-primary" />
                  </div>
                  <p className="font-medium text-foreground">No applications yet</p>
                  <p className="text-sm text-muted-foreground mt-1">Create the first application for this student to get started.</p>
                  <Button size="sm" className="mt-5" onClick={() => setShowNewApp(true)}>
                    <Plus className="w-4 h-4 mr-1" />
                    New Application
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {stageSummary.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {stageSummary.map(([stage, count]) => (
                      <div key={stage} className="bg-card rounded-xl border shadow-sm px-4 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-2xl font-semibold tabular-nums text-foreground">{count}</span>
                          <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${(STAGE_COLORS[stage] ?? "bg-gray-300 text-gray-600").split(" ")[0]}`} />
                        </div>
                        <p className="mt-1 text-xs font-medium text-muted-foreground">{getApplicationStageLabel(stage)}</p>
                      </div>
                    ))}
                  </div>
                )}

                {applicationGroups.map((group) => (
                    <div key={group.key} className="space-y-2">
                      <div className="flex items-center gap-2 px-1">
                        <h3 className="text-sm font-semibold text-foreground">{t(group.titleKey)}</h3>
                        <span className="text-xs font-medium text-muted-foreground tabular-nums bg-muted rounded-full px-2 py-0.5">
                          {group.items.length}
                        </span>
                      </div>
                      <div className="bg-card rounded-2xl border shadow-sm divide-y overflow-hidden">
                        {group.items.map((app: any) => (
                          <div
                            key={app.id}
                            className="flex items-center gap-3 sm:gap-4 px-4 py-3 hover:bg-primary/5 transition-colors"
                          >
                            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                              <GraduationCap className="w-5 h-5 text-primary" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-foreground truncate">{app.universityName ?? app.universityId ?? "\u2014"}</p>
                              <p className="text-sm text-muted-foreground truncate">{app.programName ?? app.programId ?? "\u2014"}</p>
                            </div>
                            <Badge
                              className={`capitalize text-xs px-2 py-0.5 border-0 rounded-full shrink-0 ${STAGE_COLORS[app.stage] ?? "bg-gray-100 text-gray-600"}`}
                            >
                              {getApplicationStageLabel(app.stage)}
                            </Badge>
                            <div className="hidden md:block w-24 text-right text-xs text-muted-foreground shrink-0">
                              {new Date(app.createdAt).toLocaleDateString()}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setLocation(`${basePath}/applications/${app.id}`)}
                              >
                                View
                              </Button>
                              {canDeleteApplication && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                  disabled={deletingAppId === app.id}
                                  title="Delete application"
                                  aria-label="Delete application"
                                  onClick={() => handleDeleteApplication(app)}
                                >
                                  {deletingAppId === app.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-4 h-4" />
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="documents" className="mt-4 space-y-4">
            <StudentDocumentsSection
              studentId={id}
              student={student}
              documents={documents}
              applications={applications}
              basePath={basePath}
              openUpload={openUpload}
              canUpload={canUploadStudentDocuments}
              qc={qc}
            />
            <ApplicationStageDocumentsSection studentId={id} basePath={basePath} />
          </TabsContent>

          {isStaffUser && (
            <TabsContent value="followups" className="mt-4">
              <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CalendarClock className="w-4 h-4 text-primary" />
                    <h2 className="font-semibold text-foreground">Follow-ups</h2>
                    <span className="text-xs text-muted-foreground">({(followUps as any[]).length})</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => { resetFollowUpForm(); setShowFollowUpForm(!showFollowUpForm); }}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add
                  </Button>
                </div>

                {showFollowUpForm && (
                  <div className="bg-secondary/30 rounded-xl p-4 space-y-3 border">
                    <Input
                      placeholder={t("studentDetailPage.followUpTitlePlaceholder")}
                      value={fuTitle}
                      onChange={e => setFuTitle(e.target.value)}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <Input
                        type="date"
                        value={fuDate}
                        onChange={e => setFuDate(e.target.value)}
                        min={new Date().toISOString().slice(0, 10)}
                      />
                      <Input
                        type="time"
                        value={fuTime}
                        onChange={e => setFuTime(e.target.value)}
                      />
                    </div>
                    <Textarea
                      placeholder={t("studentDetailPage.notesOptional")}
                      value={fuNotes}
                      onChange={e => setFuNotes(e.target.value)}
                      className="resize-none min-h-[60px]"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" onClick={resetFollowUpForm}>{t("studentDetailPage.cancel")}</Button>
                      <Button
                        size="sm"
                        onClick={handleCreateFollowUp}
                        disabled={(editingFuId ? editFollowUp.isPending : createFollowUp.isPending) || !fuTitle.trim() || !fuDate}
                      >
                        {editingFuId ? "Save" : "Schedule"}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {(followUps as any[]).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No follow-ups scheduled.</p>
                  ) : (
                    (followUps as any[]).map((fu: any) => (
                      <div
                        key={fu.id}
                        className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                          fu.completed
                            ? "bg-green-50/50 border-green-200"
                            : isOverdue(fu.scheduledAt)
                            ? "bg-red-50/50 border-red-200"
                            : "bg-secondary/30 border-border"
                        }`}
                      >
                        <button
                          onClick={() => toggleFollowUp.mutate({ fuId: fu.id, completed: !fu.completed })}
                          className={`mt-0.5 shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                            fu.completed
                              ? "bg-green-500 border-green-500 text-white"
                              : "border-muted-foreground/40 hover:border-primary"
                          }`}
                        >
                          {fu.completed && <CheckCircle2 className="w-3 h-3" />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <p className={`text-sm font-medium ${fu.completed ? "line-through text-muted-foreground" : "text-foreground"}`}>
                              {fu.title}
                            </p>
                            {!fu.completed && (
                              <button
                                onClick={() => startEditFollowUp(fu)}
                                className="shrink-0 p-1 rounded hover:bg-secondary transition-colors"
                              >
                                <Pencil className="w-3 h-3 text-muted-foreground" />
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Clock className="w-3 h-3 text-muted-foreground" />
                            <span className={`text-xs ${
                              fu.completed ? "text-muted-foreground" : isOverdue(fu.scheduledAt) ? "text-red-600 font-semibold" : "text-muted-foreground"
                            }`}>
                              {fmtDate(fu.scheduledAt, dateFormat)}
                              {" "}
                              {new Date(fu.scheduledAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}
                              {!fu.completed && isOverdue(fu.scheduledAt) && " — Overdue"}
                            </span>
                          </div>
                          {fu.notes && <p className="text-xs text-muted-foreground mt-1">{fu.notes}</p>}
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            {fu.createdByName && (
                              <span className="text-xs text-muted-foreground/60" data-testid="fu-created-by">by {fu.createdByName}</span>
                            )}
                            {fu.createdAt && (
                              <span className="text-xs text-muted-foreground/50">
                                {fmtDate(fu.createdAt, dateFormat)}
                                {" "}
                                {new Date(fu.createdAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            )}
                            {fu.updatedAt && fu.createdAt && new Date(fu.updatedAt).getTime() - new Date(fu.createdAt).getTime() > 2000 && (
                              <span className="text-xs text-amber-500/70" data-testid="fu-edited-by">
                                (edited{fu.updatedByName ? ` by ${fu.updatedByName}` : ""} {fmtDate(fu.updatedAt, dateFormat)}
                                {" "}
                                {new Date(fu.updatedAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </TabsContent>
          )}

          <TabsContent value="messaging" className="mt-4">
            <AllMessagingHistory type="student" id={Number(id)} />
          </TabsContent>

        </Tabs>
        {student && <div className="mt-4"><AuditLogSection resource="student" resourceId={student.id} /></div>}
      </div>

      <Dialog open={uploadOpen} onOpenChange={o => { if (!uploading) setUploadOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("studentDetailPage.uploadDocument")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs font-medium text-muted-foreground">Document Type</Label>
              <SearchableSelect
                value={uploadType}
                onValueChange={v => {
                  setUploadType(v);
                  setUploadFile(null);
                  const type = (documentTypeOptions.find(d => d.key === v)?.label ?? "document").toLowerCase();
                  const first = (student?.firstName ?? "").toLowerCase();
                  const last = (student?.lastName ?? "").toLowerCase();
                  setUploadName(`${type}-${first}-${last}`);
                }}
                options={documentTypeOptions.map(d => ({ value: d.key, label: d.label }))}
                placeholder="Select document type"
                searchPlaceholder="Search document types..."
                className="mt-1"
                minDropdownWidth={320}
              />
            </div>

            <div>
              <Label className="text-xs font-medium text-muted-foreground">Document Name</Label>
              <Input
                className="mt-1"
                value={uploadName}
                onChange={e => setUploadName(e.target.value)}
                placeholder={`passport-${(student?.firstName ?? "").toLowerCase()}-${(student?.lastName ?? "").toLowerCase()}`}
              />
            </div>

            <div>
              <Label className="text-xs font-medium text-muted-foreground">File</Label>
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
                    <p className="text-sm font-medium text-muted-foreground">Drag & drop or click</p>
                    <p className="text-xs text-muted-foreground mt-1">PDF, JPG, JPEG, PNG — max 5 MB</p>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={getAcceptForType(uploadType)}
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading}>{t("studentDetailPage.cancel")}</Button>
            <Button onClick={handleUpload} disabled={!uploadFile || uploading}>
              {uploading ? "Uploading\u2026" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {student && (
        <EditStudentDetailDialog
          open={showEditDialog}
          onClose={() => setShowEditDialog(false)}
          student={student}
          studentId={id}
        />
      )}
    </>
  );
}


const GRADING_SYSTEMS = [
  { value: "4", label: "/ 4", max: 4, placeholder: "e.g. 3.8" },
  { value: "5", label: "/ 5", max: 5, placeholder: "e.g. 4.5" },
  { value: "10", label: "/ 10", max: 10, placeholder: "e.g. 8.5" },
  { value: "100", label: "/ 100", max: 100, placeholder: "e.g. 85" },
];


function NationalityCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [searchVal, setSearchVal] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Server-side (AJAX) debounced search over the country catalog.
  const { data: filtered = [] } = useCountrySearch(searchVal);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearchVal("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <>
    <div className="relative" ref={containerRef}>
      <Input
        value={open ? searchVal : value}
        onChange={e => { setSearchVal(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setSearchVal(""); setOpen(true); }}
        placeholder={value || "Select or type..."}
        autoComplete="off"
        className="rounded-xl h-9"
      />
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{searchVal ? "No match — custom value OK" : "No countries loaded"}</div>}
          {filtered.map(c => (
            <button key={c.id} type="button" className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${c.name === value ? "bg-primary/10 font-medium" : ""}`}
              onMouseDown={e => { e.preventDefault(); onChange(c.name); setSearchVal(""); setOpen(false); }}>
              {c.code && <CountryFlag code={c.code} size="sm" />}
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

function F({ label, value, onChange, type = "text", placeholder = "", required = false, className = "", latinUppercase = false }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean; className?: string; latinUppercase?: boolean;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label className="font-semibold text-sm">{label}{required && <span className="text-destructive ml-0.5">*</span>}</Label>
      <Input type={type} value={value} onChange={e => { let v = e.target.value; if (latinUppercase) v = toLatinUpper(v); onChange(v); }} placeholder={placeholder} className={`rounded-xl h-9 ${latinUppercase ? "uppercase" : ""}`} />
    </div>
  );
}

function EditStudentDetailDialog({ open, onClose, student, studentId }: {
  open: boolean; onClose: () => void; student: any; studentId: number;
}) {
  const { t } = useI18n();
  const { levels: studyLevels } = useStudyLevels();
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    nationality: "", dateOfBirth: "", gender: "",
    passportNumber: "", passportIssueDate: "", passportExpiry: "",
    motherName: "", fatherName: "", address: "",
    cityOfBirth: "", addressCity: "", postalCode: "", needsVisaSupport: "",
    highSchool: "", graduationYear: "", gpa: "", gradingSystem: "4",
    universityBachelor: "", universityMaster: "",
    languageScore: "", notes: "", interestedLevel: "",
    transferStudent: false, hasTcId: false, hasBlueCard: false,
  });
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (open && student) {
      const gpaRaw = student.gpa || "";
      let gpaVal = gpaRaw;
      let gradingSys = "4";
      const gpaMatch = gpaRaw.match(/^([\d.]+)\s*\/\s*(\d+)$/);
      if (gpaMatch) {
        gpaVal = gpaMatch[1];
        const ms = GRADING_SYSTEMS.find(g => g.value === gpaMatch[2]);
        if (ms) gradingSys = ms.value;
      }
      setForm({
        firstName: student.firstName || "", lastName: student.lastName || "",
        email: student.email || "", phone: toPhoneFieldValue(student.phoneE164 || student.phone),
        nationality: student.nationality || "", dateOfBirth: student.dateOfBirth || "",
        gender: student.gender || "",
        passportNumber: student.passportNumber || "",
        passportIssueDate: student.passportIssueDate || "",
        passportExpiry: student.passportExpiry || "",
        motherName: student.motherName || "", fatherName: student.fatherName || "",
        address: student.address || "",
        cityOfBirth: student.cityOfBirth || "",
        addressCity: student.addressCity || "",
        postalCode: student.postalCode || "",
        needsVisaSupport:
          student.needsVisaSupport == null
            ? ""
            : student.needsVisaSupport ? "yes" : "no",
        highSchool: student.highSchool || "",
        graduationYear: student.graduationYear?.toString() || "",
        gpa: gpaVal, gradingSystem: gradingSys,
        universityBachelor: student.universityBachelor || "",
        universityMaster: student.universityMaster || "",
        languageScore: student.languageScore || "",
        notes: student.notes || "",
        interestedLevel: student.interestedLevel || "",
        transferStudent: !!student.transferStudent,
        hasTcId: !!student.hasTcId,
        hasBlueCard: !!student.hasBlueCard,
      });
    }
  }, [open, student]);

  function field(name: string) {
    return (val: string) => setForm(f => ({ ...f, [name]: val }));
  }

  async function handleSave() {
    if (!form.firstName || !form.lastName || !isPhoneFieldValid(form.phone)) return;
    setSaving(true);
    try {
      const phone = form.phone || "";
      const gpa = form.gpa ? (form.gradingSystem !== "4" ? `${form.gpa}/${form.gradingSystem}` : form.gpa) : "";
      const res = await fetch(`${BASE_URL}/api/students/${studentId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName, lastName: form.lastName,
          email: form.email, phone,
          nationality: form.nationality,
          dateOfBirth: form.dateOfBirth,
          gender: form.gender || null,
          passportNumber: form.passportNumber,
          passportIssueDate: form.passportIssueDate,
          passportExpiry: form.passportExpiry,
          motherName: form.motherName, fatherName: form.fatherName,
          address: form.address,
          cityOfBirth: form.cityOfBirth || null,
          addressCity: form.addressCity || null,
          postalCode: form.postalCode || null,
          needsVisaSupport:
            form.needsVisaSupport === "" ? null : form.needsVisaSupport === "yes",
          highSchool: form.highSchool,
          graduationYear: form.graduationYear ? parseInt(form.graduationYear) : null,
          gpa, universityBachelor: form.universityBachelor,
          universityMaster: form.universityMaster,
          languageScore: form.languageScore, notes: form.notes,
          interestedLevel: form.interestedLevel || null,
          transferStudent: form.transferStudent,
          hasTcId: form.hasTcId,
          hasBlueCard: form.hasBlueCard,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Student updated" });
      qc.invalidateQueries({ queryKey: [`/api/students/${studentId}`] });
      qc.invalidateQueries({ queryKey: ["/api/students"] });
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to update", variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader><DialogTitle>{t("studentDetailPage.editStudent")}</DialogTitle></DialogHeader>
        <div className="overflow-y-auto flex-1 space-y-6 pr-1 py-2">
          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <User className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Personal Information</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F required label={t("studentDetailPage.firstName")} value={form.firstName} onChange={field("firstName")} placeholder={t("studentDetailPage.firstNamePh")} latinUppercase />
              <F required label={t("studentDetailPage.lastName")} value={form.lastName} onChange={field("lastName")} placeholder={t("studentDetailPage.lastNamePh")} latinUppercase />
              <F label="Email" value={form.email} onChange={field("email")} type="email" placeholder="email@example.com" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Phone</Label>
                <PhoneField value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
              </div>
              <F label="Date of Birth" value={form.dateOfBirth} onChange={field("dateOfBirth")} type="date" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Gender</Label>
                <select
                  value={form.gender}
                  onChange={(e) => field("gender")(e.target.value)}
                  className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select…</option>
                  <option value="female">{t("studentDetailPage.female")}</option>
                  <option value="male">{t("studentDetailPage.male")}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Nationality</Label>
                <NationalityCombobox value={form.nationality} onChange={field("nationality")} />
              </div>
              <F label={t("studentDetailPage.mothersName")} value={form.motherName} onChange={field("motherName")} placeholder={t("studentDetailPage.mothersNamePh")} latinUppercase />
              <F label={t("studentDetailPage.fathersName")} value={form.fatherName} onChange={field("fatherName")} placeholder={t("studentDetailPage.fathersNamePh")} latinUppercase />
              <F label="Address" value={form.address} onChange={field("address")} placeholder="Full home address" className="col-span-2" />
              <F label="Residence City" value={form.addressCity} onChange={field("addressCity")} placeholder="e.g. Khujand" />
              <F label="Postal Code" value={form.postalCode} onChange={field("postalCode")} placeholder="e.g. 735700" />
              <F label="City of Birth (optional)" value={form.cityOfBirth} onChange={field("cityOfBirth")} placeholder="e.g. Khujand" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Needs Visa Support</Label>
                <select
                  value={form.needsVisaSupport}
                  onChange={(e) => field("needsVisaSupport")(e.target.value)}
                  className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Not specified</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <FileText className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Passport / Identity</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F label="Passport Number" value={form.passportNumber} onChange={field("passportNumber")} placeholder="e.g. AB1234567" className="col-span-2" />
              <F label="Issue Date" value={form.passportIssueDate} onChange={field("passportIssueDate")} type="date" />
              <F label="Expiry Date" value={form.passportExpiry} onChange={field("passportExpiry")} type="date" />
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <GraduationCap className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Education</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5 col-span-2">
                <Label className="font-semibold text-sm">Interested Level</Label>
                <Select value={form.interestedLevel} onValueChange={field("interestedLevel")}>
                  <SelectTrigger className="rounded-xl h-9">
                    <SelectValue placeholder={t("studentDetailPage.selectLevel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <F label="High School" value={form.highSchool} onChange={field("highSchool")} placeholder="e.g. ANKARA FEN LISESI" className="col-span-2" latinUppercase />
              <F label="University (Bachelor)" value={form.universityBachelor} onChange={field("universityBachelor")} placeholder="e.g. ISTANBUL UNIVERSITY" className="col-span-2" latinUppercase />
              <F label="University (Master)" value={form.universityMaster} onChange={field("universityMaster")} placeholder="e.g. BOGAZICI UNIVERSITY" className="col-span-2" latinUppercase />
              <F label="Graduation Year" value={form.graduationYear} onChange={field("graduationYear")} placeholder="e.g. 2022" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">GPA</Label>
                <div className="flex gap-1.5">
                  <Input
                    type="number" step="0.01" min="0"
                    max={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.max ?? 4}
                    value={form.gpa}
                    onChange={e => setForm(f => ({ ...f, gpa: e.target.value }))}
                    placeholder={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.placeholder ?? "e.g. 3.8"}
                    className="rounded-xl flex-1 h-9"
                  />
                  <Select value={form.gradingSystem} onValueChange={v => setForm(f => ({ ...f, gradingSystem: v, gpa: "" }))}>
                    <SelectTrigger className="w-[110px] h-9 text-sm rounded-xl shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GRADING_SYSTEMS.map(gs => (
                        <SelectItem key={gs.value} value={gs.value}>/ {gs.value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <F label="Language Score" value={form.languageScore} onChange={field("languageScore")} placeholder="e.g. IELTS 7.0, TOEFL 100" className="col-span-2" />
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <User className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">{t("studentAcademic.studentInformation")}</h3>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {([
                ["transferStudent", t("studentAcademic.transferStudent")],
                ["hasTcId", t("studentAcademic.haveTcId")],
                ["hasBlueCard", t("studentAcademic.blueCard")],
              ] as const).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3">
                  <Label className="font-semibold text-sm">{label}</Label>
                  <Select
                    value={form[key] ? "yes" : "no"}
                    onValueChange={(v) => setForm(f => ({ ...f, [key]: v === "yes" }))}
                  >
                    <SelectTrigger className="w-[110px] h-9 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">{t("studentAcademic.yes")}</SelectItem>
                      <SelectItem value="no">{t("studentAcademic.no")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </section>

          <div className="space-y-1.5">
            <Label className="font-semibold text-sm">Notes</Label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder={t("studentDetailPage.additionalNotesPh")}
              rows={2}
              className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
            />
          </div>
        </div>
        <DialogFooter className="pt-3 border-t border-border/50">
          <Button variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          <Button onClick={handleSave} disabled={!form.firstName || !form.lastName || saving} className="rounded-xl">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving...</> : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string | null;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const hasValue = !!(value && value.trim());

  const handleCopy = async () => {
    if (!hasValue) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value!);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value!;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      toast({ title: `${label} kopyalandı`, description: value! });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Kopyalanamadı", variant: "destructive" });
    }
  };

  return (
    <>
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        {hasValue ? (
          <button
            type="button"
            onClick={handleCopy}
            title={`Kopyala: ${value}`}
            className="group inline-flex items-center gap-1.5 max-w-full text-left font-medium text-foreground rounded px-1 -mx-1 py-0.5 hover:bg-muted/60 active:bg-muted transition-colors cursor-pointer"
            data-testid={`copy-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
          >
            <span className="truncate">{value}</span>
            {copied ? (
              <Check className="w-3 h-3 shrink-0 text-green-600" />
            ) : (
              <Copy className="w-3 h-3 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors" />
            )}
          </button>
        ) : (
          <p className="font-medium text-foreground">{"\u2014"}</p>
        )}
      </div>
    </div>
    </>
  );
}

const DETAIL_DOC_TYPE_LABELS: Record<string, string> = {
  high_school_diploma_translation: "High School Diploma (Translation)",
  class_10th_ssc_marks_sheet: "Class 10th/SSC Marks Sheet",
  class_12th_hsc_certificate: "Class 12th/+2/HSC Certificate",
  class_12th_hsc_marks_sheet: "Class 12th/+2/HSC Marks Sheet",
  diploma_certificate: "Diploma Certificate",
  diploma_transcript: "Diploma Transcript",
  bachelors_certificate: "Bachelors Certificate",
  bachelors_transcript: "Bachelors Transcript",
  bachelors_provisional_certificate: "Bachelors Provisional Certificate",
  bachelors_transcript_all_semesters: "Bachelors Transcript (All Semesters)",
  masters_certificate: "Masters Certificate",
  masters_transcript: "Masters Transcript",
  masters_provisional_certificate: "Masters Provisional Certificate",
  masters_transcript_all_semesters: "Masters Transcript (All Semesters)",
  passport: "Passport",
  cv: "CV",
  lor: "LOR",
  sop: "SOP",
  essay: "Essay",
  experience_letters: "Experience Letters",
  other_certificates_documents: "Other Certificates/Documents",
  ielts_pte_gre_gmat_toefl_duolingo: "IELTS/PTE/GRE/GMAT/TOEFL/Duolingo",
  photo: "Photo",
  diploma_recognition: "Diploma Recognition",
};

function StudentDocumentsSection({ studentId, student, documents, applications, basePath, openUpload, canUpload, qc }: {
  studentId: number;
  student: any;
  documents: any[];
  applications: any[];
  basePath: string;
  openUpload: () => void;
  canUpload: boolean;
  qc: any;
}) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const [appZipDownloading, setAppZipDownloading] = useState<number | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [mergingPdf, setMergingPdf] = useState(false);
  const [selectedForMerge, setSelectedForMerge] = useState<number[]>([]);

  const { getTriggerProps: getPreviewTriggerProps, dialog: previewDialog } = useDocumentPreview();

  // Build the in-app preview target for a document. Student documents are
  // student-scoped, so the inline download endpoint renders them directly.
  const previewTargetFor = (d: any) => ({
    href: (d.fileKey || d.fileData)
      ? `${BASE_URL}/api/documents/${d.id}/download?disposition=inline`
      : d.fileUrl,
    downloadHref: (d.fileKey || d.fileData)
      ? `${BASE_URL}/api/documents/${d.id}/download`
      : d.fileUrl,
    kind: getPreviewKind(d.mimeType),
    name: d.name,
  });

  const downloadDoc = (d: any) => {
    if (d.fileKey || d.fileData) {
      const mimeType = d.mimeType || "application/octet-stream";
      const filename = buildDownloadFilename(d.type, student?.firstName ?? "", student?.lastName ?? "", mimeType);
      const link = document.createElement("a");
      link.href = `${BASE_URL}/api/documents/${d.id}/download`;
      link.download = filename;
      link.click();
    } else if (d.fileUrl) {
      window.open(d.fileUrl, "_blank", "noopener,noreferrer");
    }
  };

  // Degree-level required-document indicator has been retired — the
  // authoritative list now lives on the program editor and is shown
  // on each application's detail page.

  const handleZipDownload = async () => {
    setDownloadingZip(true);
    try {
      const resp = await fetch(`${BASE_URL}/api/documents/download-zip/${studentId}?profileOnly=true`, { credentials: "include" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Download failed" }));
        toast({ title: "Error", description: err.error || "Download failed", variant: "destructive" });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${student?.firstName || "student"}_${student?.lastName || "docs"}_documents.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Error", description: "Failed to download ZIP", variant: "destructive" });
    } finally {
      setDownloadingZip(false);
    }
  };

  const handleAppZipDownload = async (appId: number, label: string) => {
    setAppZipDownloading(appId);
    try {
      const resp = await fetch(`${BASE_URL}/api/documents/download-zip/${studentId}?applicationId=${appId}`, { credentials: "include" });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Download failed" }));
        toast({ title: "Error", description: err.error || "Download failed", variant: "destructive" });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeLabel = label.replace(/[\\/:*?"<>|]/g, "_");
      a.download = `${safeLabel}_documents.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Error", description: "Failed to download ZIP", variant: "destructive" });
    } finally {
      setAppZipDownloading(null);
    }
  };

  const handleMergePdf = async () => {
    if (selectedForMerge.length < 2) {
      toast({ title: "Select PDFs", description: "Select at least 2 PDF documents to merge.", variant: "destructive" });
      return;
    }
    setMergingPdf(true);
    try {
      const resp = await fetch(`${BASE_URL}/api/documents/merge-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ documentIds: selectedForMerge, studentId }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Merge failed" }));
        toast({ title: "Error", description: err.error || "Merge failed", variant: "destructive" });
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "merged_documents.pdf";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Success", description: "PDFs merged and downloaded." });
      setSelectedForMerge([]);
    } catch {
      toast({ title: "Error", description: "Failed to merge PDFs", variant: "destructive" });
    } finally {
      setMergingPdf(false);
    }
  };

  const toggleMergeSelection = (docId: number) => {
    setSelectedForMerge(prev =>
      prev.includes(docId) ? prev.filter(id => id !== docId) : [...prev, docId]
    );
  };

  // Bug fix: keep the student's own (profile-level) documents separate from
  // documents uploaded against a specific application. Profile docs have no
  // applicationId; application-scoped docs are grouped in their own section
  // below so the two no longer mix in this list.
  const profileDocs = documents.filter((d: any) => !d.applicationId);
  const appDocs = documents.filter((d: any) => d.applicationId);
  const appDocGroups = Array.from(
    appDocs.reduce((map: Map<number, any[]>, d: any) => {
      const arr = map.get(d.applicationId) ?? [];
      arr.push(d);
      map.set(d.applicationId, arr);
      return map;
    }, new Map<number, any[]>()).entries()
  ) as [number, any[]][];
  const pdfDocs = profileDocs.filter((d: any) => d.mimeType === "application/pdf" && (d.fileKey || d.fileData || d.fileUrl));

  // Map applicationId -> { university, program } so each application-specific
  // document group can show a human-readable heading instead of a bare id.
  const appInfoById = new Map<number, { universityName?: string | null; programName?: string | null }>();
  for (const app of applications) {
    appInfoById.set(app.id, { universityName: app.universityName, programName: app.programName });
  }

  return (
    <>
    <>
      {previewDialog}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">{t("common.documentsCount", { n: profileDocs.length })}</p>
        <div className="flex items-center gap-2 flex-wrap">
          {profileDocs.length > 0 && (
            <Button size="sm" variant="outline" onClick={handleZipDownload} disabled={downloadingZip}>
              {downloadingZip ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
              {t("common.downloadZip")}
            </Button>
          )}
          {pdfDocs.length >= 2 && (
            <Button size="sm" variant="outline" onClick={handleMergePdf} disabled={mergingPdf || selectedForMerge.length < 2}>
              {mergingPdf ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
              {t("studentDetailPage.mergePdfs")} ({selectedForMerge.length})
            </Button>
          )}
          {canUpload && (
            <Button size="sm" onClick={openUpload}>
              <Upload className="w-4 h-4 mr-2" />
              {t("studentDetailPage.uploadDocs")}
            </Button>
          )}
        </div>
      </div>

      <div className="bg-card rounded-2xl border shadow-sm overflow-hidden">
        {profileDocs.length === 0 ? (
          <div
            className={`p-16 text-center text-muted-foreground transition-colors ${canUpload ? "cursor-pointer hover:bg-secondary/30" : ""}`}
            onClick={canUpload ? openUpload : undefined}
          >
            <Upload className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">{t("studentDetailPage.noDocsYet")}</p>
            {canUpload && <p className="text-xs mt-1">{t("studentDetailPage.clickToUpload")}</p>}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-secondary/50">
              <tr>
                {pdfDocs.length >= 2 && (
                  <th className="text-center px-2 py-3 w-8">
                    <span className="text-xs text-muted-foreground">PDF</span>
                  </th>
                )}
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("studentDetailPage.tableName")}</th>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("studentDetailPage.tableStatus")}</th>
                <th className="text-left px-4 py-3 font-semibold text-foreground">{t("studentDetailPage.tableUploaded")}</th>
                <th className="text-right px-4 py-3 font-semibold text-foreground">{t("studentDetailPage.tableFile")}</th>
              </tr>
            </thead>
            <tbody>
              {profileDocs.map((doc: any) => (
                <tr key={doc.id} className="border-t hover:bg-primary/5 transition-colors">
                  {pdfDocs.length >= 2 && (
                    <td className="px-2 py-3 text-center">
                      {(doc.mimeType === "application/pdf" && (doc.fileKey || doc.fileData || doc.fileUrl)) && (
                        <input
                          type="checkbox"
                          checked={selectedForMerge.includes(doc.id)}
                          onChange={() => toggleMergeSelection(doc.id)}
                          className="rounded border-gray-300"
                        />
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <p className="font-medium">{doc.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{DETAIL_DOC_TYPE_LABELS[doc.type] || doc.type}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="capitalize text-xs px-2 py-0.5 border-0 rounded-full bg-secondary text-secondary-foreground">
                      {doc.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      {(doc.fileKey || doc.fileData || doc.fileUrl) && getPreviewKind(doc.mimeType) !== "other" && (
                        <a
                          {...getPreviewTriggerProps(previewTargetFor(doc))}
                          className="flex items-center gap-1.5 text-xs text-foreground/80 hover:text-primary font-medium transition-colors"
                          title="Preview"
                          aria-label={`Preview ${doc.name}`}
                          data-testid={`btn-preview-${doc.id}`}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          {t("studentDetailPage.preview")}
                        </a>
                      )}
                      {(doc.fileKey || doc.fileData) && (
                        <button
                          onClick={() => downloadDoc(doc)}
                          className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {t("studentDetailPage.download")}
                        </button>
                      )}
                      {doc.fileUrl && !doc.fileKey && !doc.fileData && (
                        <a href={doc.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium">
                          {t("studentDetailPage.view")}
                        </a>
                      )}
                      <button
                        onClick={async () => {
                          if (!confirm(t("studentDetailPage.deleteConfirm"))) return;
                          const resp = await apiFetch(`${BASE_URL}/api/documents/${doc.id}`, { method: "DELETE" });
                          if (resp.ok) {
                            await qc.invalidateQueries({ predicate: (q: any) => q.queryKey.some((k: any) => typeof k === "string" && (k.includes("document") || k.includes("student"))) });
                          }
                        }}
                        className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors"
                        title={t("studentDetailPage.deleteTooltip")}
                        aria-label={`Delete ${doc.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {appDocGroups.length > 0 && (
        <div className="mt-4 bg-card rounded-2xl border shadow-sm p-4 space-y-3">
          <div>
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <FileText className="w-4 h-4 text-muted-foreground" />
              {t("common.applicationSpecificDocuments")}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">{t("common.applicationSpecificDocumentsHint")}</p>
          </div>
          <div className="space-y-3">
            {appDocGroups.map(([appId, groupDocs]) => {
              const info = appInfoById.get(appId);
              const uni = info?.universityName ?? "—";
              const prog = info?.programName ?? "—";
              const groupLabel = info?.universityName ? `${uni} · ${prog}` : t("common.applicationNumber", { id: appId });
              return (
              <div key={appId} className="border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between gap-2 p-3 bg-secondary/40">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {uni} <span className="text-muted-foreground">·</span> {prog}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("common.applicationNumber", { id: appId })}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full"
                      disabled={appZipDownloading === appId}
                      onClick={() => handleAppZipDownload(appId, groupLabel)}
                      title={t("studentDetailPage.downloadAllDocuments")}
                    >
                      {appZipDownloading === appId
                        ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                        : <Download className="w-4 h-4 mr-1.5" />}
                      {t("studentDetailPage.downloadAllDocuments")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="rounded-full"
                      onClick={() => setLocation(`${basePath}/applications/${appId}`)}
                    >
                      {t("common.openApplication")}
                    </Button>
                  </div>
                </div>
                <div className="divide-y">
                  {groupDocs.map((doc: any) => (
                    <div key={doc.id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                      <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{doc.name}</p>
                        <p className="text-xs text-muted-foreground">
                          <span className="inline-block px-1.5 py-0 rounded-full bg-secondary text-foreground/80 mr-1.5 capitalize">
                            {DETAIL_DOC_TYPE_LABELS[doc.type] || doc.type}
                          </span>
                          {new Date(doc.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      {(doc.fileKey || doc.fileData || doc.fileUrl) && getPreviewKind(doc.mimeType) !== "other" && (
                        <Button asChild variant="ghost" size="icon" className="h-8 w-8" title={t("studentDetailPage.preview")}>
                          <a {...getPreviewTriggerProps(previewTargetFor(doc))} aria-label={`Preview ${doc.name}`}>
                            <Eye className="w-4 h-4" />
                          </a>
                        </Button>
                      )}
                      {(doc.fileKey || doc.fileData || doc.fileUrl) && (
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => downloadDoc(doc)} title={t("studentDetailPage.download")}>
                          <Download className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </>
    </>
  );
}

function ApplicationStageDocumentsSection({ studentId, basePath }: { studentId: number; basePath: string }) {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const { data: docs = [], isLoading } = useQuery<any[]>({
    queryKey: [`/api/students/${studentId}/application-documents`],
    queryFn: () => customFetch(`${BASE_URL}/api/students/${studentId}/application-documents`),
    staleTime: 15_000,
  });

  const grouped = useMemo(() => {
    const map = new Map<number, { applicationId: number; universityName?: string; programName?: string; docs: any[] }>();
    for (const d of docs) {
      const key = d.applicationId;
      if (!map.has(key)) {
        map.set(key, {
          applicationId: d.applicationId,
          universityName: d.universityName,
          programName: d.programName,
          docs: [],
        });
      }
      map.get(key)!.docs.push(d);
    }
    return Array.from(map.values());
  }, [docs]);

  const handleDownload = (d: any) => {
    const link = document.createElement("a");
    link.href = `${BASE_URL}/api/applications/${d.applicationId}/stage-documents/${d.id}/download`;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
  };

  // Hide this whole section when there are no stage documents so the
  // page doesn't show an empty placeholder block.
  if (!isLoading && docs.length === 0) return null;

  return (
    <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t("common.applicationDocuments")}</h2>
        {docs.length > 0 && (
          <Badge variant="secondary" className="text-xs px-1.5 py-0">{docs.length}</Badge>
        )}
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("common.noStudentDocsUploaded")}</p>
      ) : (
        <div className="space-y-4">
          {grouped.map((g) => (
            <div key={g.applicationId} className="border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between p-3 bg-secondary/40">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {g.universityName ?? "—"} <span className="text-muted-foreground">·</span> {g.programName ?? "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("common.applicationNumber", { id: g.applicationId })}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setLocation(`${basePath}/applications/${g.applicationId}`)}
                >
                  {t("common.openApplication")}
                </Button>
              </div>
              <div className="divide-y">
                {g.docs.map((d: any) => (
                  <div key={d.id} className="flex items-center gap-3 p-3 hover:bg-secondary/20 transition-colors">
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{d.fileName}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="inline-block px-1.5 py-0 rounded-full bg-secondary text-foreground/80 mr-1.5">
                          {d.stageLabel || humanizePipelineStageKey(d.stage) || "—"}
                        </span>
                        {new Date(d.createdAt).toLocaleString()}
                        {d.uploadedByName && <> · {d.uploadedByName}</>}
                        {d.sizeBytes ? ` · ${(d.sizeBytes / 1024).toFixed(0)} KB` : ""}
                        {d.validUntil && <> · Geçerlilik: {new Date(d.validUntil).toLocaleDateString()}</>}
                      </p>
                    </div>
                    {(d.hasFileData || d.fileUrl) && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDownload(d)} title="İndir">
                        <Download className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
