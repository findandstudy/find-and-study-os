import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { applicationCreationErrorToast } from "@/components/ApplicationCreationErrorToast";
import type { InboxConversationDetailResponse } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Plus,
  GraduationCap,
  Trash2,
  UserPlus,
  Lock,
  FileText,
  Send,
} from "lucide-react";
import { InboxStatusControl } from "./InboxStatusControl";
import {
  readLeadInterest,
  uniqueExactInterestMatch,
} from "./studentDraftInterest";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UniRow {
  id: number;
  name: string;
}

interface ProgRow {
  id: number;
  name: string;
  degree?: string | null;
}

interface AppRow {
  id: number;
  programName?: string | null;
  universityName?: string | null;
  country?: string | null;
  stage?: string | null;
  season?: string | null;
}

interface StageDocumentRow {
  id: number;
  fileName: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  isMissingDocNote?: boolean;
  hasFileData?: boolean;
  fileUrl?: string | null;
}

interface SendableApplicationDocument {
  applicationId: number;
  documentId: number;
  fileName: string;
  mimeType?: string | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface DocPreflight {
  missingDocTypes: string[];
  missingDocs: Array<{ type: string; label: string }>;
  mandatoryCount: number;
}

interface InboxApplicationTabProps {
  detail: InboxConversationDetailResponse;
  conversationId: number;
  overrideStudentId?: number;
  onUpdated?: () => void;
  onProgramSelected?: (p: { id: number; name: string } | null) => void;
  onSendDocument?: (document: SendableApplicationDocument) => Promise<void>;
  documentSendingDisabled?: boolean;
}

function ApplicationStageDocuments({
  application,
  onSendDocument,
  sendingDisabled,
}: {
  application: AppRow;
  onSendDocument?: (document: SendableApplicationDocument) => Promise<void>;
  sendingDisabled?: boolean;
}) {
  const [sendingId, setSendingId] = useState<number | null>(null);
  const { data, isLoading } = useQuery<StageDocumentRow[]>({
    queryKey: ["inbox-application-stage-documents", application.id, application.stage],
    queryFn: () =>
      customFetch(
        `${BASE_URL}/api/applications/${application.id}/stage-documents?stage=${encodeURIComponent(application.stage || "inquiry")}`,
      ),
    enabled: Boolean(application.id && application.stage),
    staleTime: 15_000,
  });
  const documents = (data ?? []).filter(
    (document) =>
      !document.isMissingDocNote && Boolean(document.fileUrl || document.hasFileData),
  );

  if (isLoading || documents.length === 0) return null;

  return (
    <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
      {documents.map((document) => (
        <div key={document.id} className="flex min-w-0 items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="min-w-0 flex-1 truncate text-[10px]" title={document.fileName}>
            {document.fileName}
          </span>
          {onSendDocument && (
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
              title={sendingDisabled ? "The 24-hour reply window is closed" : "Send document to chat"}
              aria-label={`Send ${document.fileName} to chat`}
              disabled={sendingDisabled || sendingId !== null}
              onClick={async () => {
                setSendingId(document.id);
                try {
                  await onSendDocument({
                    applicationId: application.id,
                    documentId: document.id,
                    fileName: document.fileName,
                    mimeType: document.mimeType,
                  });
                } finally {
                  setSendingId(null);
                }
              }}
            >
              {sendingId === document.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function InboxApplicationTab({
  detail,
  conversationId,
  overrideStudentId,
  onUpdated,
  onProgramSelected,
  onSendDocument,
  documentSendingDisabled,
}: InboxApplicationTabProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── All hooks unconditional ───────────────────────────────────────────────
  const [selectedCountry, setSelectedCountry] = useState("");
  const [selectedUniversityId, setSelectedUniversityId] = useState("");
  const [selectedUniversityName, setSelectedUniversityName] = useState("");
  const [selectedProgramId, setSelectedProgramId] = useState("");
  const [selectedProgramName, setSelectedProgramName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Student from detail (may be null if not yet linked; use override while detail refreshes)
  const student = (detail as any).student as
    | {
        id: number;
        interestedLevel?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      }
    | null
    | undefined;
  const studentId = student?.id ?? overrideStudentId;

  // Countries — only countries that have universities in the system
  const { data: cfFilters, isFetched: countriesFetched } = useQuery<{
    countries?: string[];
  }>({
    queryKey: ["course-finder-countries"],
    queryFn: () =>
      fetch(`${BASE_URL}/api/course-finder/filters`, {
        credentials: "include",
      }).then((r) => (r.ok ? r.json() : { countries: [] })),
    staleTime: 60_000,
  });
  const countries = cfFilters?.countries ?? [];

  // Universities — server-side, enabled when country selected
  const {
    data: uniData,
    isLoading: unisLoading,
    isFetched: unisFetched,
  } = useQuery<{ data: UniRow[] }>({
    queryKey: ["inbox-app-universities", selectedCountry],
    queryFn: () =>
      fetch(
        `${BASE_URL}/api/universities?country=${encodeURIComponent(selectedCountry)}&limit=500`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: !!selectedCountry,
    staleTime: 30_000,
  });

  // Study level comes from the student and is locked in the UI — programs
  // must be filtered to that level (server-side via the `degree` param).
  const level = student?.interestedLevel ?? "";

  // Programs — server-side, enabled when university selected
  const {
    data: progData,
    isLoading: progsLoading,
    isFetched: progsFetched,
  } = useQuery<{ data: ProgRow[] }>({
    queryKey: ["inbox-app-programs", selectedUniversityId, level],
    queryFn: () =>
      fetch(
        `${BASE_URL}/api/programs?universityId=${selectedUniversityId}&limit=500${
          level ? `&degree=${encodeURIComponent(level)}` : ""
        }`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: !!selectedUniversityId,
    staleTime: 30_000,
  });

  // Existing applications for this student
  const { data: appsData, isLoading: appsLoading } = useQuery<{
    data: AppRow[];
  }>({
    queryKey: ["inbox-student-apps", studentId],
    queryFn: () =>
      fetch(`${BASE_URL}/api/applications?studentId=${studentId}&limit=100`, {
        credentials: "include",
      }).then((r) => r.json()),
    enabled: !!studentId,
    staleTime: 15_000,
  });

  // ── Mandatory-document preflight — mirrors the POST /applications gate so
  // staff see the block BEFORE hitting the 422 (includes adoptable lead docs).
  const { data: preflight, isLoading: preflightLoading } =
    useQuery<DocPreflight>({
      queryKey: [
        "app-doc-preflight",
        studentId,
        selectedProgramId || null,
        level,
      ],
      queryFn: () => {
        const params = new URLSearchParams();
        if (selectedProgramId) params.set("programId", selectedProgramId);
        if (level) params.set("level", level);
        return fetch(
          `${BASE_URL}/api/students/${studentId}/application-doc-preflight?${params.toString()}`,
          { credentials: "include" },
        ).then((r) =>
          r.ok
            ? r.json()
            : { missingDocTypes: [], missingDocs: [], mandatoryCount: 0 },
        );
      },
      enabled: !!studentId && (!!selectedProgramId || !!level),
      staleTime: 15_000,
    });
  const missingDocs = preflight?.missingDocs ?? [];
  const docsBlocked = missingDocs.length > 0;

  // ── Derived ───────────────────────────────────────────────────────────────
  const universities: UniRow[] = uniData?.data ?? [];
  const programs: ProgRow[] = progData?.data ?? [];
  const apps: AppRow[] = appsData?.data ?? [];

  const countryOptions = countries.map((c) => ({ value: c, label: c }));
  const uniOptions = universities.map((u) => ({
    value: String(u.id),
    label: u.name,
  }));
  const progOptions = programs.map((p) => ({
    value: String(p.id),
    label: p.name,
  }));
  const leadInterest = readLeadInterest(detail);
  const prefillKey = `${conversationId}:${studentId ?? "none"}`;
  const prefillStateRef = useRef({
    key: prefillKey,
    country: false,
    university: false,
    program: false,
  });

  const canAdd =
    !!selectedCountry && !!studentId && !submitting && !docsBlocked;

  // Preserve the original lead intent after lead -> student conversion. Each
  // selector is prefilled only when the catalog contains exactly one canonical
  // match. Ambiguous/fuzzy matches remain empty so the wrong application can
  // never be created silently.
  useEffect(() => {
    if (prefillStateRef.current.key === prefillKey) return;
    prefillStateRef.current = {
      key: prefillKey,
      country: false,
      university: false,
      program: false,
    };
    setSelectedCountry("");
    setSelectedUniversityId("");
    setSelectedUniversityName("");
    setSelectedProgramId("");
    setSelectedProgramName("");
    onProgramSelected?.(null);
  }, [onProgramSelected, prefillKey]);

  useEffect(() => {
    const state = prefillStateRef.current;
    if (state.key !== prefillKey || state.country || !countriesFetched) return;
    state.country = true;
    const match = uniqueExactInterestMatch(
      countries,
      leadInterest.country,
      (country) => country,
    );
    if (match) setSelectedCountry(match);
  }, [countries, countriesFetched, leadInterest.country, prefillKey]);

  useEffect(() => {
    const state = prefillStateRef.current;
    if (
      state.key !== prefillKey ||
      state.university ||
      !selectedCountry ||
      !unisFetched
    ) {
      return;
    }
    state.university = true;
    const match = uniqueExactInterestMatch(
      universities,
      leadInterest.university,
      (university) => university.name,
    );
    if (!match) return;
    setSelectedUniversityId(String(match.id));
    setSelectedUniversityName(match.name);
  }, [
    leadInterest.university,
    prefillKey,
    selectedCountry,
    universities,
    unisFetched,
  ]);

  useEffect(() => {
    const state = prefillStateRef.current;
    if (
      state.key !== prefillKey ||
      state.program ||
      !selectedUniversityId ||
      !progsFetched
    ) {
      return;
    }
    state.program = true;
    const match = uniqueExactInterestMatch(
      programs,
      leadInterest.program,
      (program) => program.name,
    );
    if (!match) return;
    setSelectedProgramId(String(match.id));
    setSelectedProgramName(match.name);
    onProgramSelected?.({ id: match.id, name: match.name });
  }, [
    leadInterest.program,
    onProgramSelected,
    prefillKey,
    programs,
    progsFetched,
    selectedUniversityId,
  ]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleCountryChange(v: string) {
    prefillStateRef.current.country = true;
    prefillStateRef.current.university = true;
    prefillStateRef.current.program = true;
    setSelectedCountry(v);
    setSelectedUniversityId("");
    setSelectedUniversityName("");
    setSelectedProgramId("");
    setSelectedProgramName("");
    onProgramSelected?.(null);
  }

  function handleUniversityChange(v: string) {
    prefillStateRef.current.university = true;
    prefillStateRef.current.program = true;
    const uni = universities.find((u) => String(u.id) === v);
    setSelectedUniversityId(v);
    setSelectedUniversityName(uni?.name ?? "");
    setSelectedProgramId("");
    setSelectedProgramName("");
    onProgramSelected?.(null);
  }

  function handleProgramChange(v: string) {
    prefillStateRef.current.program = true;
    const prog = programs.find((p) => String(p.id) === v);
    setSelectedProgramId(v);
    setSelectedProgramName(prog?.name ?? "");
    onProgramSelected?.(v && prog ? { id: prog.id, name: prog.name } : null);
  }

  async function handleAdd() {
    if (!studentId || !selectedCountry) return;
    setSubmitting(true);
    try {
      const season = String(new Date().getFullYear());
      await customFetch(`${BASE_URL}/api/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          stage: "inquiry",
          season,
          country: selectedCountry || null,
          universityId: selectedUniversityId
            ? parseInt(selectedUniversityId, 10)
            : null,
          universityName: selectedUniversityName || null,
          programId: selectedProgramId ? parseInt(selectedProgramId, 10) : null,
          programName: selectedProgramName || null,
          level: level || null,
        }),
      });
      toast({ title: t("inbox.applicationTab.added") });
      await queryClient.invalidateQueries({
        queryKey: ["inbox-student-apps", studentId],
      });
      // Reset selectors
      setSelectedCountry("");
      setSelectedUniversityId("");
      setSelectedUniversityName("");
      setSelectedProgramId("");
      setSelectedProgramName("");
      prefillStateRef.current.country = true;
      prefillStateRef.current.university = true;
      prefillStateRef.current.program = true;
      onProgramSelected?.(null);
      onUpdated?.();
    } catch (err: any) {
      toast(applicationCreationErrorToast(
        err,
        t("inbox.applicationTab.addFailed"),
      ));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(appId: number) {
    setDeletingId(appId);
    try {
      await customFetch(`${BASE_URL}/api/applications/${appId}`, {
        method: "DELETE",
      });
      await queryClient.invalidateQueries({
        queryKey: ["inbox-student-apps", studentId],
      });
      toast({ title: t("inbox.applicationTab.deleted") });
    } catch {
      toast({
        title: t("inbox.applicationTab.deleteFailed"),
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  }

  // ── No-student guard (after all hooks) ───────────────────────────────────
  if (!studentId) {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6 text-center gap-3">
        <UserPlus className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm font-medium">
          {t("inbox.applicationTab.noStudent")}
        </p>
        <p className="text-xs text-muted-foreground max-w-[200px]">
          {t("inbox.applicationTab.noStudentDesc")}
        </p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Form section ─────────────────────────────────────────────────── */}
      <div className="px-3 pt-3 pb-3 border-b space-y-2.5 shrink-0">
        {/* Country */}
        <div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
            {t("inbox.applicationTab.country")}
          </div>
          <SearchableSelect
            value={selectedCountry}
            onChange={handleCountryChange}
            options={countryOptions}
            placeholder={t("inbox.applicationTab.selectCountry")}
            searchPlaceholder={t("inbox.applicationTab.searchCountry")}
            clearable
          />
        </div>

        {/* University */}
        <div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
            {t("inbox.applicationTab.university")}
          </div>
          {unisLoading && selectedCountry ? (
            <div className="h-10 flex items-center px-3 rounded-md border border-input bg-muted/30 gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">…</span>
            </div>
          ) : (
            <SearchableSelect
              value={selectedUniversityId}
              onChange={handleUniversityChange}
              options={uniOptions}
              placeholder={
                !selectedCountry
                  ? t("inbox.applicationTab.selectCountryFirst")
                  : uniOptions.length === 0
                    ? t("inbox.applicationTab.noUniversities")
                    : t("inbox.applicationTab.selectUniversity")
              }
              searchPlaceholder={t("inbox.applicationTab.searchUniversity")}
              disabled={!selectedCountry || uniOptions.length === 0}
              clearable
            />
          )}
        </div>

        {/* Level — read-only, from student */}
        <div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
            {t("inbox.applicationTab.level")}
            <Lock className="w-2.5 h-2.5 text-muted-foreground/60" />
          </div>
          <div className="h-10 px-3 flex items-center gap-2 rounded-md border border-input bg-muted/40 cursor-default">
            <span className="text-sm flex-1 truncate text-muted-foreground">
              {level || t("inbox.applicationTab.levelNotSet")}
            </span>
            <span className="text-[10px] text-muted-foreground/60 bg-muted rounded px-1.5 py-0.5 shrink-0">
              {t("inbox.applicationTab.levelAuto")}
            </span>
          </div>
        </div>

        {/* Program */}
        <div>
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
            {t("inbox.applicationTab.program")}
          </div>
          {progsLoading && selectedUniversityId ? (
            <div className="h-10 flex items-center px-3 rounded-md border border-input bg-muted/30 gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">…</span>
            </div>
          ) : (
            <SearchableSelect
              value={selectedProgramId}
              onChange={handleProgramChange}
              options={progOptions}
              placeholder={
                !selectedUniversityId
                  ? t("inbox.applicationTab.selectUniversityFirst")
                  : progOptions.length === 0
                    ? t("inbox.applicationTab.noPrograms")
                    : t("inbox.applicationTab.selectProgram")
              }
              searchPlaceholder={t("inbox.applicationTab.searchProgram")}
              disabled={!selectedUniversityId || progOptions.length === 0}
              clearable
            />
          )}
        </div>

        {/* Missing mandatory documents pre-warning */}
        {docsBlocked && !preflightLoading && (
          <div
            className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2 space-y-0.5"
            data-testid="app-missing-docs-warning"
          >
            <p className="text-[11px] font-semibold text-rose-700">
              {t("inbox.applicationTab.missingDocsBlocked")}
            </p>
            <p className="text-[11px] text-rose-600">
              {t("inbox.applicationTab.missingDocsWarning", {
                docs: missingDocs.map((d) => d.label).join(", "),
              })}
            </p>
          </div>
        )}

        {/* Add button */}
        <Button
          className="w-full h-8 text-xs gap-1.5"
          onClick={() => {
            void handleAdd();
          }}
          disabled={!canAdd}
        >
          {submitting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5" />
          )}
          {t("inbox.applicationTab.addBtn")}
        </Button>
      </div>

      {/* ── Applications list ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-3 space-y-2">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
          {t("inbox.applicationTab.applications")}
          {apps.length > 0 && (
            <span className="ms-1.5 text-[10px] bg-muted rounded-full px-1.5 py-0.5">
              {apps.length}
            </span>
          )}
        </div>

        {appsLoading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>…</span>
          </div>
        ) : apps.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">
            {t("inbox.applicationTab.noApps")}
          </p>
        ) : (
          apps.map((app) => (
            <div
              key={app.id}
              className="flex items-start gap-2 p-2.5 rounded-lg border bg-muted/20 group"
            >
              <GraduationCap className="w-4 h-4 text-primary/60 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate leading-tight">
                  {app.programName ??
                    app.universityName ??
                    t("inbox.applicationTab.unknownProgram")}
                </p>
                {(app.universityName || app.country) && (
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {[app.universityName, app.country]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {app.season && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {app.season}
                  </p>
                )}
                <div className="mt-2">
                  <InboxStatusControl
                    entityType="application"
                    entityId={app.id}
                    status={app.stage ?? "inquiry"}
                    label={t("common.status")}
                    onUpdated={async () => {
                      await queryClient.invalidateQueries({
                        queryKey: ["inbox-student-apps", studentId],
                      });
                      onUpdated?.();
                    }}
                  />
                </div>
                <ApplicationStageDocuments
                  application={app}
                  onSendDocument={onSendDocument}
                  sendingDisabled={documentSendingDisabled}
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  void handleDelete(app.id);
                }}
                disabled={deletingId === app.id}
                className="shrink-0 text-muted-foreground hover:text-destructive transition-colors mt-0.5 opacity-0 group-hover:opacity-100"
                aria-label="Delete"
              >
                {deletingId === app.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
