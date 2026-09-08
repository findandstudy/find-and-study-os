import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useEntityViewTracker } from "@/hooks/use-entity-view-tracker";
import {
  customFetch,
  useSummarizeInboxConversation,
  useAddInboxConversationNote,
  useAddInboxConversationTask,
  type InboxConversationDetailResponse,
  type ConversationAiSummary,
} from "@workspace/api-client-react";
import { LeadDetailSidebar } from "@/components/inbox/LeadDetailSidebar";
import { AiSummaryCard } from "@/components/inbox/AiSummaryCard";
import {
  ChatNoteTaskTabs,
  type ComposeTab,
  type TaskDraft,
} from "@/components/inbox/ChatNoteTaskTabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { invalidateAssignmentWorkspaceQueries } from "@/lib/workspaceQueryInvalidation";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { useOggVoiceRecorder } from "@/hooks/use-ogg-voice-recorder";
import {
  Search, Send, MessageCircle, Plus, Users, Megaphone, Mail,
  MessageSquare, Smartphone, Hash, ArrowLeft, Paperclip, ChevronDown, Star, Bell,
  FileText, Edit, Trash2, Copy, Check, CheckCheck, X, Loader2, Eye, EyeOff, Globe, Download,
  Inbox as InboxIcon, AlertTriangle, UserCheck, Link2, Clock, FormInput, RefreshCw, Info, Filter, Bot,
  Facebook, Instagram, Archive, ArchiveRestore, ArrowDown, ArrowUpDown, ListChecks, FlaskConical,
  UserPlus, FilePlus2, SmilePlus, CornerUpLeft, Pin, Forward, Mic, Square, Ban, ShieldCheck,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useI18n } from "@/hooks/use-i18n";
import { AddStudentModal } from "@/components/AddStudentModal";
import type { AddDocTarget } from "@/components/inbox/AddAsDocumentModal";
import { AssignDocumentFromMessageModal } from "@/components/inbox/AssignDocumentFromMessageModal";
import PdfAttachmentCard from "@/components/inbox/PdfAttachmentCard";
import {
  getInboxAttachmentPreviewKind,
  inboxAttachmentMediaUrl,
  normalizeInboxDownloadFilename,
  shouldProxyInboxAttachment,
} from "@/components/inbox/attachmentMediaUrl";
import { WhatsAppTemplatePicker } from "@/components/inbox/WhatsAppTemplatePicker";
import { SYSTEM_LANGUAGE_OPTIONS } from "@/lib/i18n";

interface Conversation {
  id: number;
  type: string;
  title: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  participants: Array<{ userId: number; firstName: string; lastName: string; avatarUrl: string | null; role: string; lastReadAt?: string | null }>;
  unreadCount: number;
  readReceiptsEnabled?: boolean;
  botEnabled?: boolean;
  needsHuman?: boolean;
}

interface MessageAttachment {
  fileName?: string;
  fileUrl?: string;
  fileType?: string;
  fileSize?: number;
  url?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  voiceNote?: boolean;
}

const TRANSIENT_MEDIA_STATUSES = new Set([502, 503, 504]);
const WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS = 1024;

class TransientMediaUploadError extends Error {
  constructor() {
    super("Temporary media upload failure");
    this.name = "TransientMediaUploadError";
  }
}

function isTransientMediaRequestError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status = Number((error as { status?: unknown } | null)?.status);
  return TRANSIENT_MEDIA_STATUSES.has(status);
}

function mediaRetryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 400 * (2 ** attempt)));
}

async function retryMediaPreparation<T>(operation: () => Promise<T>): Promise<T> {
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientMediaRequestError(error)) throw error;
      if (attempt === attempts - 1) throw new TransientMediaUploadError();
      await mediaRetryDelay(attempt);
    }
  }
  throw new TransientMediaUploadError();
}

async function uploadInboxObject(uploadURL: string, file: File): Promise<void> {
  await retryMediaPreparation(async () => {
    const response = await fetch(uploadURL, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (TRANSIENT_MEDIA_STATUSES.has(response.status)) {
      const error = new Error(`Temporary upload failure (${response.status})`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status})`);
  });
}

interface Message {
  id: number;
  conversationId: number;
  senderId: number | null;
  content: string;
  channel: string;
  status: string;
  direction?: string;
  createdAt: string;
  metadata?: {
    attachment?: MessageAttachment;
    attachments?: MessageAttachment[];
    botSent?: boolean;
    model?: string;
    language?: string;
  };
  senderFirstName: string | null;
  senderLastName: string | null;
  senderAvatarUrl: string | null;
  senderRole: string | null;
}

interface UserResult {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  avatarUrl: string | null;
}

interface ComposerTemplate {
  id: number;
  name: string;
  category: string;
  content: string;
  channel: string;
  language: string;
  isActive: boolean;
  externalTemplateName?: string | null;
  approvalStatus?: string | null;
}

const INBOX_MEDIA_ACCEPT = [
  "image/jpeg", "image/png", "image/webp",
  "video/mp4", "video/webm", "video/quicktime", "video/3gpp",
  "audio/mpeg", "audio/ogg", "audio/webm", "audio/wav", "audio/amr", "audio/aac", "audio/mp4",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
].join(",");

const INBOX_MEDIA_LIMITS: Record<string, number> = {
  "image/jpeg": 5 * 1024 * 1024,
  "image/png": 5 * 1024 * 1024,
  "video/mp4": 16 * 1024 * 1024,
  "video/3gpp": 16 * 1024 * 1024,
  "audio/mpeg": 16 * 1024 * 1024,
  "audio/ogg": 16 * 1024 * 1024,
  "audio/webm": 16 * 1024 * 1024,
  "audio/amr": 16 * 1024 * 1024,
  "audio/aac": 16 * 1024 * 1024,
  "audio/mp4": 16 * 1024 * 1024,
};

function inboxMediaValidationError(file: File, webChat = false): string | null {
  if (webChat) {
    if (file.size <= 0) return `${file.name}: empty file`;
    if (file.size > 5 * 1024 * 1024) return `${file.name}: maximum 5MB`;
    const allowedMime = new Set([
      "image/jpeg", "image/png", "image/webp",
      "application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4", "audio/wav", "audio/aac",
      "video/mp4", "video/webm", "video/quicktime", "video/3gpp",
    ]);
    return allowedMime.has(file.type.toLowerCase())
      ? null
      : `${file.name}: unsupported file type`;
  }
  const mediaLimit = INBOX_MEDIA_LIMITS[file.type.toLowerCase()];
  if (mediaLimit != null) {
    if (file.size <= 0) return `${file.name}: empty file`;
    if (file.size > mediaLimit) {
      return `${file.name}: maximum ${Math.round(mediaLimit / (1024 * 1024))}MB`;
    }
    return null;
  }
  // The API remains the final authority for document extensions/MIME pairs.
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i.test(file.name)) return null;
  return `${file.name}: unsupported file type`;
}

const channelIcon: Record<string, any> = {
  internal: MessageSquare,
  whatsapp: MessageCircle,
  telegram: Send,
  email: Mail,
  sms: Smartphone,
  web_form: FormInput,
  web_chat: Bot,
  messenger: Facebook,
  instagram: Instagram,
};

const channelColor: Record<string, string> = {
  internal: "bg-blue-500/10 text-blue-600",
  whatsapp: "bg-green-500/10 text-green-600",
  telegram: "bg-sky-500/10 text-sky-600",
  email: "bg-purple-500/10 text-purple-600",
  sms: "bg-amber-500/10 text-amber-600",
  web_form: "bg-indigo-500/10 text-indigo-600",
  web_chat: "bg-cyan-500/10 text-cyan-700",
  messenger: "bg-blue-600/10 text-blue-700",
  instagram: "bg-pink-500/10 text-pink-600",
};

interface InboxChannelAccountSummary {
  id: number;
  displayName: string;
  externalAccountId?: string | null;
  isDefault: boolean;
  provider?: string | null;
  metadata?: {
    brandLabel?: string | null;
    brandColor?: string | null;
  } | null;
}

function isExternalAutoReplyAvailable(
  channel: string | null | undefined,
  account: InboxChannelAccountSummary | null | undefined,
): boolean {
  if (!channel) return false;
  if (channel === "web_chat") return true;
  if (account?.provider === "zernio") return true;
  return channel === "whatsapp" || channel === "messenger" || channel === "instagram";
}

interface WhatsAppLineBrand {
  label: string;
  color: string;
}

function validBrandColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#143591";
}

function whatsappLineBrand(
  channel: string,
  account: InboxChannelAccountSummary | null | undefined,
): WhatsAppLineBrand | null {
  if (channel !== "whatsapp" || !account) return null;
  return {
    label: account.metadata?.brandLabel?.trim() || account.displayName,
    color: validBrandColor(account.metadata?.brandColor),
  };
}

interface InboxConversation {
  id: number;
  type: string;
  title: string | null;
  channel: string;
  channelAccountId: number | null;
  channelAccount: InboxChannelAccountSummary | null;
  externalContactId: number | null;
  unmatched: boolean;
  status: string;
  assignedToId: number | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastInboundAt: string | null;
  botEnabled?: boolean;
  needsHuman?: boolean;
  externalContact: {
    id: number;
    displayName: string | null;
    phone: string | null;
    email: string | null;
    leadId: number | null;
    studentId: number | null;
    agentId: number | null;
  } | null;
  assignedTo: { id: number; firstName: string; lastName: string; avatarUrl: string | null } | null;
  isStarred?: boolean;
  isSubscribed?: boolean;
  unreadCount?: number;
  awaitingReply?: boolean;
}

interface InboxStaffOption {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email?: string | null;
  isActive?: boolean;
}

// If no event/heartbeat arrives within this window, the indicator switches
// from "Live" (green) to "Stalled" (amber) even though the EventSource is
// still technically open. Heartbeats fire every 25s, so 60s gives a 2x+
// safety margin before alerting staff.
const STALE_AFTER_MS = 60_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLastUpdate(lastEventAt: number | null, now: number): string {
  if (!lastEventAt) return "no updates received yet";
  const diffMs = Math.max(0, now - lastEventAt);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "last update just now";
  if (seconds < 60) return `last update ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last update ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `last update ${hours}h ago`;
}

function LiveStatusIndicator({
  status,
  lastEventAt,
  now,
  onReconnect,
}: {
  status: "connecting" | "open" | "offline" | "stale";
  lastEventAt: number | null;
  now: number;
  onReconnect: () => void;
}) {
  const { t } = useI18n();
  const config = {
    open: {
      label: t("messagesPage.live"),
      dotClass: "bg-emerald-500",
      ringClass: "bg-emerald-500/30",
      textClass: "text-emerald-700",
      animate: false,
    },
    connecting: {
      label: t("messagesPage.reconnecting"),
      dotClass: "bg-amber-500",
      ringClass: "bg-amber-500/40",
      textClass: "text-amber-700",
      animate: true,
    },
    stale: {
      label: t("messagesPage.stalled"),
      dotClass: "bg-amber-500",
      ringClass: "bg-amber-500/40",
      textClass: "text-amber-700",
      animate: true,
    },
    offline: {
      label: t("messagesPage.offline"),
      dotClass: "bg-red-500",
      ringClass: "bg-red-500/30",
      textClass: "text-red-700",
      animate: false,
    },
  }[status];

  const lastUpdateText = formatLastUpdate(lastEventAt, now);
  const tooltip = (() => {
    if (status === "open") return `Live · ${lastUpdateText}`;
    if (status === "stale") return `Stalled · ${lastUpdateText} — stream may be stuck`;
    if (status === "connecting") return `Reconnecting… · ${lastUpdateText}`;
    return "Offline — click to retry";
  })();

  const isOffline = status === "offline";

  const content = (
    <button
      type="button"
      onClick={isOffline ? onReconnect : undefined}
      aria-label={tooltip}
      aria-disabled={!isOffline}
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${config.textClass} border-current/20 ${
        isOffline ? "cursor-pointer hover:bg-red-500/10" : "cursor-default"
      }`}
    >
      <span className="relative flex h-2 w-2">
        {config.animate && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${config.ringClass}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${config.dotClass}`} />
      </span>
      <span>{config.label}</span>
      {isOffline && <RefreshCw className="w-3 h-3" />}
    </button>
  );

  return (
    <>
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
    </>
  );
}

type InboxTabKey = "mine" | "unassigned" | "unmatched" | "all" | "open" | "unanswered" | "unread" | "awaiting" | "subscribed" | "starred" | "archived";

const INBOX_TAB_KEYS: InboxTabKey[] = ["mine", "unassigned", "unmatched", "all", "open", "unanswered", "unread", "awaiting", "subscribed", "starred", "archived"];
const PINNED_INBOX_TAB_STORAGE_KEY = "inbox.pinnedTab";

const INBOX_LIST_WIDTH_STORAGE_KEY = "inbox.listWidth";
const INTERNAL_LIST_WIDTH_STORAGE_KEY = "internal.listWidth";
const INBOX_LIST_MIN_WIDTH = 220;
const INBOX_LIST_DEFAULT_WIDTH = 280;
const INBOX_LIST_MAX_WIDTH = 420;

function inboxListMaxWidth(): number {
  return Math.max(
    INBOX_LIST_MIN_WIDTH,
    Math.min(
      INBOX_LIST_MAX_WIDTH,
      Math.floor((typeof window !== "undefined" ? window.innerWidth : 1280) * 0.36),
    ),
  );
}

function readStoredListWidth(storageKey: string): number {
  try {
    const v = Number(localStorage.getItem(storageKey));
    if (!Number.isFinite(v) || v <= 0) return INBOX_LIST_DEFAULT_WIDTH;
    return Math.min(inboxListMaxWidth(), Math.max(INBOX_LIST_MIN_WIDTH, Math.round(v)));
  } catch {
    return INBOX_LIST_DEFAULT_WIDTH;
  }
}

function readInboxListWidth(): number {
  return readStoredListWidth(INBOX_LIST_WIDTH_STORAGE_KEY);
}

function readPinnedInboxTab(): InboxTabKey | null {
  try {
    const v = localStorage.getItem(PINNED_INBOX_TAB_STORAGE_KEY);
    return v && (INBOX_TAB_KEYS as string[]).includes(v) ? (v as InboxTabKey) : null;
  } catch {
    return null;
  }
}

function InboxTab() {
  const { t, isRTL } = useI18n();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canDeleteConversations = ["super_admin", "admin"].includes(user?.role || "");
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<InboxTabKey>(() => readPinnedInboxTab() ?? "mine");
  const [pinnedTab, setPinnedTab] = useState<InboxTabKey | null>(() => readPinnedInboxTab());
  const [listWidth, setListWidth] = useState<number>(() => readInboxListWidth());
  const listResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const clampListWidth = () => {
      setListWidth((width) => Math.min(inboxListMaxWidth(), Math.max(INBOX_LIST_MIN_WIDTH, width)));
    };
    window.addEventListener("resize", clampListWidth);
    return () => {
      window.removeEventListener("resize", clampListWidth);
      if (listResizeCleanupRef.current) listResizeCleanupRef.current();
    };
  }, []);
  const [assignedNotice, setAssignedNotice] = useState(false);
  const [channel, setChannel] = useState<string>("all");
  const [inboxSearch, setInboxSearch] = useState("");
  const [debouncedInboxSearch, setDebouncedInboxSearch] = useState("");
  const [assignedStaffId, setAssignedStaffId] = useState<number | null>(null);
  const [inboxStaff, setInboxStaff] = useState<InboxStaffOption[]>([]);
  const [inboxStaffLoading, setInboxStaffLoading] = useState(true);
  const [convs, setConvs] = useState<InboxConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const inboxRequestSequenceRef = useRef(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<InboxConversationDetailResponse | null>(null);
  const detailRequestSequenceRef = useRef(0);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [blockingContact, setBlockingContact] = useState(false);
  const [composeTab, setComposeTab] = useState<ComposeTab>("chat");
  const [noteDraft, setNoteDraft] = useState("");
  const [taskDraft, setTaskDraft] = useState<TaskDraft>({
    title: "",
    scheduledAt: "",
    notes: "",
  });
  const [matchOpen, setMatchOpen] = useState(false);
  const [forwardMsgId, setForwardMsgId] = useState<number | null>(null);
  const [forwardTargets, setForwardTargets] = useState<Set<number>>(new Set());
  const [forwardSearch, setForwardSearch] = useState("");
  const [forwardSending, setForwardSending] = useState(false);
  const [matchSuggestions, setMatchSuggestions] = useState<any | null>(null);
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false);
  const [createLeadOpen, setCreateLeadOpen] = useState(false);
  const [createLeadLoading, setCreateLeadLoading] = useState(false);
  const [createLeadSubmitting, setCreateLeadSubmitting] = useState(false);
  const [createLeadForm, setCreateLeadForm] = useState({ fullName: "", email: "", phone: "" });
  const [createLeadAiFields, setCreateLeadAiFields] = useState<Set<string>>(new Set());
  const [createLeadDuplicate, setCreateLeadDuplicate] = useState<null | { id: number; firstName: string; lastName: string; email: string | null; phone: string | null; status: string }>(null);
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [addStudentPrefill, setAddStudentPrefill] = useState<{ firstName?: string; lastName?: string; email?: string; phone?: string }>({});
  const [studentSearchOpen, setStudentSearchOpen] = useState(false);
  const [studentSearchQuery, setStudentSearchQuery] = useState("");
  const [studentSearchResults, setStudentSearchResults] = useState<any[]>([]);
  const [studentSearchLoading, setStudentSearchLoading] = useState(false);
  const [studentLinking, setStudentLinking] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplSending, setTplSending] = useState(false);
  const [tplInitialId, setTplInitialId] = useState<number | null>(null);
  const [composerTemplates, setComposerTemplates] = useState<ComposerTemplate[]>([]);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [newWaConvOpen, setNewWaConvOpen] = useState(false);
  const [newWaConvSearch, setNewWaConvSearch] = useState("");
  const [newWaConvResults, setNewWaConvResults] = useState<{ entityType: string; entityId: number; name: string; phone: string }[]>([]);
  const [newWaConvLoading, setNewWaConvLoading] = useState(false);
  const [newWaConvSelected, setNewWaConvSelected] = useState<{ entityType: string; entityId: number; name: string; phone: string } | null>(null);
  const [whatsAppAccounts, setWhatsAppAccounts] = useState<InboxChannelAccountSummary[]>([]);
  const [newWaConvAccountId, setNewWaConvAccountId] = useState<string>("");
  const [newWaConvTplOpen, setNewWaConvTplOpen] = useState(false);
  const [newWaConvSending, setNewWaConvSending] = useState(false);

  useEffect(() => {
    void customFetch("/api/inbox/whatsapp-accounts").then((response: any) => {
      const rows = Array.isArray(response?.accounts) ? response.accounts : [];
      setWhatsAppAccounts(rows);
      setNewWaConvAccountId((current) => current || String(rows.find((row: InboxChannelAccountSummary) => row.isDefault)?.id || rows[0]?.id || ""));
    }).catch(() => setWhatsAppAccounts([]));
  }, []);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "open" | "offline">("connecting");
  const [reconnectKey, setReconnectKey] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [attachPreview, setAttachPreview] = useState<{ url: string; name: string; isImage: boolean; isPdf: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  const [replyToMsg, setReplyToMsg] = useState<{ id: number; snippet: string; senderName: string } | null>(null);
  const [emojiPaletteFor, setEmojiPaletteFor] = useState<number | null>(null);
  const [hoveredMsgId, setHoveredMsgId] = useState<number | null>(null);
  const emojiPaletteRef = useRef<HTMLDivElement>(null);

  const addPendingFiles = useCallback((incoming: File[]) => {
    const accepted: File[] = [];
    const errors: string[] = [];
    for (const file of incoming) {
      const error = inboxMediaValidationError(file, detail?.conversation.channel === "web_chat");
      if (error) errors.push(error);
      else accepted.push(file);
    }
    if (accepted.length > 0) {
      setPendingFiles((prev) => [...prev, ...accepted].slice(0, 10));
    }
    if (errors.length > 0) {
      toast({
        title: "Some files could not be added",
        description: errors.slice(0, 3).join("\n"),
        variant: "destructive",
      });
    }
  }, [detail?.conversation.channel, toast]);

  const voiceRecorder = useOggVoiceRecorder(
    useCallback((file: File) => addPendingFiles([file]), [addPendingFiles]),
    useCallback((message: string) => {
      toast({ title: "Voice message unavailable", description: message, variant: "destructive" });
    }, [toast]),
  );

  const slashQuery = /^\/([^\n]*)$/.exec(reply)?.[1]?.trim().toLowerCase() ?? null;
  const freeFormWindowOpen = !detail || !(
    (detail.conversation.channel === "whatsapp" ||
      detail.conversation.channel === "messenger" ||
      detail.conversation.channel === "instagram") &&
    !detail.withinWindow
  );
  const slashTemplates = useMemo(() => {
    if (slashQuery === null) return [];
    return composerTemplates
      .filter((template) => {
        const isApprovedExternal =
          Boolean(template.externalTemplateName) &&
          String(template.approvalStatus || "").toLowerCase() === "approved";
        const isLocal = !template.externalTemplateName;
        if (!template.isActive || (!isLocal && !isApprovedExternal)) return false;
        if (isLocal && !freeFormWindowOpen) return false;
        if (!slashQuery) return true;
        return [
          template.name,
          template.externalTemplateName || "",
          template.category,
          template.content,
        ].some((value) => value.toLowerCase().includes(slashQuery));
      })
      .slice(0, 8);
  }, [composerTemplates, freeFormWindowOpen, slashQuery]);

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashQuery]);

  function handleChatDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragging(true);
  }
  function handleChatDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  function handleChatDragLeave(e: React.DragEvent) {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }
  function handleChatDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0);
    if (files.length > 0) addPendingFiles(files);
  }
  // Sort order for the conversation list — persisted per user preference.
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">(() => {
    try { return localStorage.getItem("inbox_sort_order") === "asc" ? "asc" : "desc"; } catch { return "desc"; }
  });
  // Test/junk conversations hidden by default; toggle reveals them for cleanup.
  const [showTests, setShowTests] = useState<boolean>(() => {
    try { return localStorage.getItem("inbox_show_tests") === "true"; } catch { return false; }
  });
  // Multi-select actions. Permanent deletion is guarded by two confirmations
  // in the UI and a separate admin-only server authorization check.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState<"archive" | "unarchive" | "delete" | "delete-final" | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // WhatsApp-style thread: windowed history + smart auto-scroll
  const [olderMsgs, setOlderMsgs] = useState<any[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [addDocTarget, setAddDocTarget] = useState<AddDocTarget | null>(null);
  // Study level picked in the "Add as document" modal, remembered per
  // conversation so the second and later files skip the level question.
  const [assignDocLevels, setAssignDocLevels] = useState<Record<number, string>>({});
  const msgScrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevLastMsgIdRef = useRef<number | null>(null);

  useEffect(() => { try { localStorage.setItem("inbox_sort_order", sortOrder); } catch {} }, [sortOrder]);
  useEffect(() => { try { localStorage.setItem("inbox_show_tests", String(showTests)); } catch {} }, [showTests]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedInboxSearch(inboxSearch.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [inboxSearch]);

  useEffect(() => {
    let cancelled = false;
    setInboxStaffLoading(true);
    void customFetch("/api/users?roles=super_admin,admin,manager,staff,consultant,editor,accountant&limit=200")
      .then((res: any) => {
        if (cancelled) return;
        const list = Array.isArray(res?.data) ? res.data : [];
        setInboxStaff(
          list
            .filter((staffUser: InboxStaffOption) => staffUser.isActive !== false)
            .sort((a: InboxStaffOption, b: InboxStaffOption) => {
              const aName = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim() || a.email || `#${a.id}`;
              const bName = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || b.email || `#${b.id}`;
              return aName.localeCompare(bName);
            }),
        );
      })
      .catch(() => {
        if (!cancelled) setInboxStaff([]);
      })
      .finally(() => {
        if (!cancelled) setInboxStaffLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Close the mobile lead-info drawer whenever the selected conversation changes
  useEffect(() => {
    setSidebarSheetOpen(false);
  }, [selectedId]);

  // Deep-link: /staff/messages?conversation=<id> opens the conversation directly
  // (used by quick-contact success toasts and failure notifications).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const convParam = params.get("conversation");
      if (convParam) {
        const id = parseInt(convParam, 10);
        if (Number.isFinite(id) && id > 0) setSelectedId(id);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick once every 5s so the tooltip's "Xs ago" text stays roughly fresh
  // and the derived "stale" status flips after the threshold without needing
  // a separate timer per event.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // Even though the EventSource may be technically open, surface a "Stalled"
  // amber state when no event/heartbeat has arrived in over STALE_AFTER_MS.
  // This catches the "looks live but isn't" failure mode where the push
  // pipeline silently stops emitting but the socket stays connected.
  const effectiveLiveStatus: "connecting" | "open" | "offline" | "stale" =
    liveStatus === "open" && lastEventAt !== null && now - lastEventAt > STALE_AFTER_MS
      ? "stale"
      : liveStatus;

  const fetchInbox = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background === true;
    const requestSequence = ++inboxRequestSequenceRef.current;
    if (!background) setLoading(true);
    try {
      const params = new URLSearchParams({ tab, order: sortOrder });
      if (channel !== "all") params.set("channel", channel);
      if (showTests) params.set("showTests", "true");
      if (debouncedInboxSearch) params.set("search", debouncedInboxSearch);
      if (assignedStaffId !== null) params.set("assignedToId", String(assignedStaffId));
      const url = `/api/inbox/conversations?${params.toString()}`;
      const res = await customFetch(url);
      if (requestSequence === inboxRequestSequenceRef.current) {
        setConvs((res as any)?.data || []);
      }
    } catch {
      // A transient live-refresh failure must not blank an already usable
      // inbox. Explicit/filter-changing loads retain the previous behavior.
      if (!background && requestSequence === inboxRequestSequenceRef.current) setConvs([]);
    } finally {
      if (requestSequence === inboxRequestSequenceRef.current) setLoading(false);
    }
  }, [tab, channel, sortOrder, showTests, debouncedInboxSearch, assignedStaffId]);

  useEffect(() => { fetchInbox(); }, [fetchInbox]);

  const fetchDetail = useCallback(async (id: number) => {
    const requestSequence = ++detailRequestSequenceRef.current;
    try {
      const res = await customFetch(`/api/inbox/conversations/${id}`);
      if (requestSequence === detailRequestSequenceRef.current) {
        setDetail(res as InboxConversationDetailResponse);
        setHasMoreOlder(Boolean((res as any)?.hasMoreMessages));
      }
    } catch {
      if (requestSequence === detailRequestSequenceRef.current) setDetail(null);
    }
  }, []);

  const rememberAssignDocLevel = useCallback((level: string) => {
    if (!selectedId || !level) return;
    setAssignDocLevels((prev) => ({ ...prev, [selectedId]: level }));

    // Persist the choice on the linked CRM record as well as keeping the fast
    // per-conversation UI state. A refresh must not send Documents back to
    // Bachelor after the operator explicitly selected Master in the Add modal.
    const linkedStudent = (detail as any)?.student;
    const linkedLead = (detail as any)?.lead;
    const endpoint = linkedStudent?.id
      ? `/api/students/${linkedStudent.id}`
      : linkedLead?.id
        ? `/api/leads/${linkedLead.id}`
        : null;
    const currentLevel = linkedStudent?.interestedLevel ?? linkedLead?.interestedLevel ?? null;
    if (!endpoint || currentLevel === level) return;

    void customFetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interestedLevel: level }),
    })
      .then(() => fetchDetail(selectedId))
      .catch(() => {
        // The in-memory choice still keeps this session consistent. The next
        // explicit edit can retry persistence without blocking document save.
      });
  }, [selectedId, detail, fetchDetail]);

  useEffect(() => {
    if (selectedId) {
      setDetail(null);
      fetchDetail(selectedId);
      // Opening a conversation marks it read server-side (lastReadAt is
      // bumped by the messages fetch) — zero the badge immediately in the UI.
      setConvs((prev) => prev.map((c) => (c.id === selectedId && (c.unreadCount ?? 0) > 0 ? { ...c, unreadCount: 0 } : c)));
    } else {
      detailRequestSequenceRef.current += 1;
      setDetail(null);
    }
    // Reset compose drafts when switching conversations so a half-written
    // note/task/reply doesn't leak across tickets.
    setComposeTab("chat");
    setReply("");
    setNoteDraft("");
    setTaskDraft({ title: "", scheduledAt: "", notes: "" });
    setPendingFiles([]);
    voiceRecorder.cancel();
    // Reset thread pagination + scroll bookkeeping for the new conversation.
    setOlderMsgs([]);
    setHasMoreOlder(false);
    setNewBelow(0);
    atBottomRef.current = true;
    prevLastMsgIdRef.current = null;
  }, [selectedId, fetchDetail]);

  useEffect(() => {
    if (!selectedId) {
      setComposerTemplates([]);
      return;
    }
    let cancelled = false;
    void customFetch("/api/message-templates?channel=whatsapp&activeOnly=true")
      .then((response: any) => {
        if (!cancelled) setComposerTemplates(response?.data || []);
      })
      .catch(() => {
        if (!cancelled) setComposerTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Live updates via Server-Sent Events. Refs let the long-lived EventSource
  // see the freshest selection / fetchers without churning the connection
  // every time the user switches tabs or opens a conversation.
  const selectedIdRef = useRef<number | null>(selectedId);
  const actorUserIdRef = useRef<number | null>(user?.id ?? null);
  const fetchInboxRef = useRef(fetchInbox);
  const fetchDetailRef = useRef(fetchDetail);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { actorUserIdRef.current = user?.id ?? null; }, [user?.id]);
  useEffect(() => { fetchInboxRef.current = fetchInbox; }, [fetchInbox]);
  useEffect(() => { fetchDetailRef.current = fetchDetail; }, [fetchDetail]);

  useEffect(() => {
    if (emojiPaletteFor === null) return;
    function handleOutside(e: MouseEvent) {
      if (emojiPaletteRef.current && !emojiPaletteRef.current.contains(e.target as Node)) {
        setEmojiPaletteFor(null);
      }
    }
    document.addEventListener("click", handleOutside);
    return () => document.removeEventListener("click", handleOutside);
  }, [emojiPaletteFor]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    setLiveStatus("connecting");
    let failureCount = 0;
    let inboxRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let detailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingDetailConversationId: number | null = null;
    const es = new EventSource("/api/inbox/events", { withCredentials: true });

    // One inbound action can emit message, assignment and read-state events.
    // The inbox list is an enriched query of up to 200 conversations, so
    // coalesce only these live-event refreshes into one request. Explicit user
    // actions continue to refresh immediately.
    const scheduleInboxRefresh = () => {
      if (inboxRefreshTimer !== null) return;
      inboxRefreshTimer = setTimeout(() => {
        inboxRefreshTimer = null;
        void fetchInboxRef.current({ background: true });
      }, 200);
    };

    const scheduleDetailRefresh = (conversationId: number) => {
      pendingDetailConversationId = conversationId;
      if (detailRefreshTimer !== null) return;
      detailRefreshTimer = setTimeout(() => {
        detailRefreshTimer = null;
        const pendingId = pendingDetailConversationId;
        pendingDetailConversationId = null;
        if (pendingId !== null && selectedIdRef.current === pendingId) {
          void fetchDetailRef.current(pendingId);
        }
      }, 200);
    };

    const refresh = (raw: MessageEvent) => {
      setLastEventAt(Date.now());
      let convId: number | null = null;
      try {
        const payload = JSON.parse(raw.data || "{}");
        if (typeof payload.conversationId === "number") convId = payload.conversationId;
      } catch {
        // ignore malformed frames; still refresh the list as a safety net.
      }
      scheduleInboxRefresh();
      if (convId !== null && selectedIdRef.current === convId) {
        scheduleDetailRefresh(convId);
      }
    };

    const refreshReadState = (raw: MessageEvent) => {
      setLastEventAt(Date.now());
      try {
        const payload = JSON.parse(raw.data || "{}");
        // Read cursors are user-specific. Refresh only the actor's other tabs
        // and never refetch the open detail here: GET detail itself marks the
        // thread read and would undo a just-requested "mark as unread".
        if (payload.actorUserId === actorUserIdRef.current) {
          scheduleInboxRefresh();
        }
      } catch {
        // A malformed read-state event cannot safely identify its owner.
      }
    };

    // Heartbeats arrive every ~25s and don't trigger any data refresh — they
    // just keep proxies happy and let the client prove the stream is alive.
    const onHeartbeat = () => {
      setLastEventAt(Date.now());
    };

    es.onopen = () => {
      failureCount = 0;
      setLiveStatus("open");
      // The server emits an initial heartbeat right after connect, but mark
      // "now" too so a freshly opened indicator never shows "no updates yet".
      setLastEventAt(Date.now());
    };

    es.onerror = () => {
      // The browser auto-reconnects EventSource while readyState is CONNECTING.
      // Give it a few attempts before declaring the stream offline and forcing
      // a manual retry, so a single proxy hiccup doesn't scare staff.
      if (es.readyState === EventSource.CLOSED) {
        setLiveStatus("offline");
        return;
      }
      failureCount += 1;
      if (failureCount >= 4) {
        es.close();
        setLiveStatus("offline");
      } else {
        setLiveStatus("connecting");
      }
    };

    es.addEventListener("inbox_message", refresh);
    es.addEventListener("inbox_assigned", refresh);
    es.addEventListener("inbox_read_state", refreshReadState);
    es.addEventListener("heartbeat", onHeartbeat);

    return () => {
      if (inboxRefreshTimer !== null) clearTimeout(inboxRefreshTimer);
      if (detailRefreshTimer !== null) clearTimeout(detailRefreshTimer);
      es.removeEventListener("inbox_message", refresh);
      es.removeEventListener("inbox_assigned", refresh);
      es.removeEventListener("inbox_read_state", refreshReadState);
      es.removeEventListener("heartbeat", onHeartbeat);
      es.close();
    };
  }, [reconnectKey]);

  const reconnectLive = useCallback(() => {
    setLiveStatus("connecting");
    setReconnectKey((k) => k + 1);
  }, []);

  async function loadSuggestions() {
    if (!selectedId) return;
    try {
      const r = await customFetch(`/api/inbox/conversations/${selectedId}/match-suggestions`);
      setMatchSuggestions(r);
      setMatchOpen(true);
    } catch {
      toast({ title: t("messagesPage.failedToLoadSuggestions"), variant: "destructive" });
    }
  }

  async function applyMatch(type: "lead" | "student" | "agent", entityId: number) {
    if (!selectedId) return;
    try {
      await customFetch(`/api/inbox/conversations/${selectedId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, entityId }),
      });
      toast({ title: t("messagesPage.linked") });
      setMatchOpen(false);
      fetchInbox();
      fetchDetail(selectedId);
    } catch {
      toast({ title: t("messagesPage.failedToLink"), variant: "destructive" });
    }
  }

  function openAddStudentDialog() {
    // Step 1: search existing students (name/phone/passport) before offering
    // to create a new one. Prefill the search with the contact's phone so
    // potential duplicates surface immediately.
    const currentExt = detail?.externalContact;
    const initialQuery = (currentExt?.phone || currentExt?.displayName || "").trim();
    setStudentSearchQuery(initialQuery);
    setStudentSearchResults([]);
    setMatchOpen(false);
    setStudentSearchOpen(true);
  }

  function openCreateStudentModal() {
    const currentExt = detail?.externalContact;
    const currentConv = detail?.conversation;
    const name = (currentExt?.displayName || currentConv?.title || "").trim();
    const parts = name.split(/\s+/);
    setAddStudentPrefill({
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" ") || "",
      email: currentExt?.email || "",
      phone: currentExt?.phone || "",
    });
    setStudentSearchOpen(false);
    setAddStudentOpen(true);
  }

  async function linkExistingStudent(studentId: number) {
    setStudentLinking(true);
    try {
      await applyMatch("student", studentId);
      setStudentSearchOpen(false);
    } finally {
      setStudentLinking(false);
    }
  }

  useEffect(() => {
    if (!studentSearchOpen) return;
    const q = studentSearchQuery.trim();
    if (q.length < 2) {
      setStudentSearchResults([]);
      setStudentSearchLoading(false);
      return;
    }
    setStudentSearchLoading(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r: any = await customFetch(`/api/students?search=${encodeURIComponent(q)}&limit=8`);
        if (!cancelled) setStudentSearchResults(Array.isArray(r?.data) ? r.data : []);
      } catch {
        if (!cancelled) setStudentSearchResults([]);
      } finally {
        if (!cancelled) setStudentSearchLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [studentSearchOpen, studentSearchQuery]);

  async function openCreateLeadDialog() {
    if (!selectedId) return;
    setCreateLeadForm({ fullName: "", email: "", phone: "" });
    setCreateLeadAiFields(new Set());
    setCreateLeadDuplicate(null);
    setCreateLeadOpen(true);
    setMatchOpen(false);
    setCreateLeadLoading(true);
    try {
      const r: any = await customFetch(`/api/inbox/conversations/${selectedId}/lead-suggestion`);
      const s = r?.suggestion || {};
      const aiFields = new Set<string>();
      const form = {
        fullName: "",
        email: "",
        phone: (s.phone as string) || "",
      };
      if (s.displayName && !s.fullName) {
        form.fullName = s.displayName as string;
      }
      if (s.fullName) {
        form.fullName = s.fullName as string;
        if (s.fullNameLowConfidence) aiFields.add("fullName");
      }
      if (s.email) {
        form.email = s.email as string;
        if (s.emailLowConfidence) aiFields.add("email");
      }
      setCreateLeadForm(form);
      setCreateLeadAiFields(aiFields);
    } catch {
      // leave form empty — user can type manually
    } finally {
      setCreateLeadLoading(false);
    }
  }

  async function submitCreateLead() {
    if (!selectedId || !createLeadForm.fullName.trim()) return;
    setCreateLeadSubmitting(true);
    setCreateLeadDuplicate(null);
    try {
      await customFetch(`/api/inbox/conversations/${selectedId}/create-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: createLeadForm.fullName.trim(),
          email: createLeadForm.email.trim() || null,
          phone: createLeadForm.phone.trim() || null,
        }),
      });
      toast({ title: t("messagesPage.newLeadCreated") });
      setCreateLeadOpen(false);
      fetchInbox();
      if (selectedId) fetchDetail(selectedId);
    } catch (err: any) {
      const body = err?.body ?? err?.data;
      if (body?.error === "LEAD_EXISTS" && body?.candidate) {
        setCreateLeadDuplicate(body.candidate);
      } else {
        toast({ title: t("messagesPage.failedToCreateLead"), variant: "destructive" });
      }
    } finally {
      setCreateLeadSubmitting(false);
    }
  }

  async function linkToExistingLead() {
    if (!selectedId || !createLeadDuplicate) return;
    try {
      await customFetch(`/api/inbox/conversations/${selectedId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "lead", entityId: createLeadDuplicate.id }),
      });
      toast({ title: t("messagesPage.linked") });
      setCreateLeadOpen(false);
      fetchInbox();
      if (selectedId) fetchDetail(selectedId);
    } catch {
      toast({ title: t("messagesPage.failedToLink"), variant: "destructive" });
    }
  }

  async function assignTo(userId: number | null) {
    if (!selectedId) return;
    try {
      await customFetch(`/api/inbox/conversations/${selectedId}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      await invalidateAssignmentWorkspaceQueries(queryClient);
      if (userId === user?.id) {
        setAssignedNotice(true);
        setTimeout(() => setAssignedNotice(false), 3000);
      }
    } catch (err: any) {
      const locked = err?.status === 403 && String(err?.data?.error ?? "") === "ASSIGNMENT_LOCKED";
      toast({
        title: locked ? t("messagesPage.assignmentLocked") : t("messagesPage.failedToAssign"),
        variant: "destructive",
      });
    } finally {
      // The API may reconcile a partially-updated CRM chain before returning
      // an error. Always reload so the dropdown reflects the persisted owner.
      fetchInbox();
      fetchDetail(selectedId);
    }
  }

  async function assignToMe() {
    if (!user) return;
    await assignTo(user.id);
  }

  async function toggleBot(enabled: boolean) {
    if (!selectedId) return;
    try {
      await customFetch(`/api/inbox/conversations/${selectedId}/bot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      toast({ title: enabled ? t("messagesPage.aiEnabled") : t("messagesPage.aiDisabled") });
      fetchInbox();
      fetchDetail(selectedId);
    } catch {
      toast({ title: t("messagesPage.aiToggleFailed"), variant: "destructive" });
    }
  }

  async function toggleContactBlock(blocked: boolean) {
    if (!selectedId || blockingContact) return;
    if (!window.confirm(blocked ? t("messagesPage.confirmBlockContact") : t("messagesPage.confirmUnblockContact"))) return;
    setBlockingContact(true);
    try {
      await customFetch(`/api/inbox/conversations/${selectedId}/block`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked }),
      });
      toast({ title: blocked ? t("messagesPage.contactBlocked") : t("messagesPage.contactUnblocked") });
      setPendingFiles([]);
      setReply("");
      await Promise.all([fetchInbox(), fetchDetail(selectedId)]);
    } catch (err: any) {
      toast({ title: err?.data?.error || t("messagesPage.contactBlockFailed"), variant: "destructive" });
    } finally {
      setBlockingContact(false);
    }
  }

  async function uploadFileForInbox(file: File): Promise<{
    url: string;
    type: string;
    name: string;
    mimeType?: string;
    fileType?: string;
    fileSize?: number;
    voiceNote?: boolean;
  } | null> {
    try {
      if (detail?.conversation.channel === "web_chat") {
        if (!selectedId) throw new Error("Conversation is not selected");
        const uploadResp = await fetch(`/api/inbox/conversations/${selectedId}/web-chat-media`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            ...(file.name.startsWith("voice-note-") ? { "X-Voice-Note": "1" } : {}),
          },
          body: file,
        });
        const payload = await uploadResp.json().catch(() => ({}));
        if (!uploadResp.ok || !payload?.attachment) {
          throw new Error(payload?.error || "Upload failed");
        }
        return payload.attachment;
      }
      // This request only prepares a private storage target; it does not send
      // anything to WhatsApp/Meta/Zernio. Retrying a transient gateway failure
      // here is safe and avoids dropping an attachment during a brief API
      // restart. The external message POST below remains non-retried.
      const urlRes = await retryMediaPreparation(() => customFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "inbox", name: file.name, size: file.size, contentType: file.type }),
      })) as any;
      const { uploadURL, objectPath } = urlRes;
      // PUT is idempotent for the same prepared object path, so retrying it
      // cannot create a duplicate outbound message.
      await uploadInboxObject(uploadURL, file);
      const storageKey = String(objectPath)
        .replace(/^\/+/, "")
        .replace(/^(?:objects\/)+/, "");
      const privateUrl = `${window.location.origin}/api/storage/objects/${storageKey}`;
      const type = file.type.startsWith("image/") ? "image"
        : file.type.startsWith("video/") ? "video"
        : file.type.startsWith("audio/") ? "audio"
        : "file";
      const isVoiceNote = type === "audio" && file.name.startsWith("voice-note-");
      return { url: privateUrl, type, name: file.name, ...(isVoiceNote ? { voiceNote: true } : {}) };
    } catch (err: any) {
      toast({
        title: t("inbox.error.sendMediaFailed"),
        description: err instanceof TransientMediaUploadError
          ? t("inbox.error.temporaryMediaUnavailable")
          : err?.message,
        variant: "destructive",
      });
      return null;
    }
  }

  const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

  async function toggleReaction(msgId: number, emoji: string) {
    if (!selectedId) return;
    const convId = selectedId;
    const uid = user?.id ?? -1;
    setEmojiPaletteFor(null);
    // Optimistic toggle: update the bubble immediately instead of waiting for
    // a full conversation refetch (which made reactions feel laggy).
    setDetail((prev: any) => {
      if (!prev?.messages) return prev;
      const messages = prev.messages.map((m: any) => {
        if (m.id !== msgId) return m;
        const reactions: Array<{ emoji: string; count: number; userIds: number[] }> =
          (m.reactions ?? []).map((r: any) => ({ ...r, userIds: [...(r.userIds ?? [])] }));
        const idx = reactions.findIndex((r) => r.emoji === emoji);
        if (idx >= 0 && reactions[idx].userIds.includes(uid)) {
          reactions[idx].userIds = reactions[idx].userIds.filter((u) => u !== uid);
          reactions[idx].count = Math.max(0, reactions[idx].count - 1);
          if (reactions[idx].count === 0) reactions.splice(idx, 1);
        } else if (idx >= 0) {
          reactions[idx].userIds.push(uid);
          reactions[idx].count += 1;
        } else {
          reactions.push({ emoji, count: 1, userIds: [uid] });
        }
        return { ...m, reactions };
      });
      return { ...prev, messages };
    });
    try {
      await customFetch(`/api/inbox/conversations/${convId}/messages/${msgId}/react`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      });
    } catch {
      // Revert to server truth on failure.
      fetchDetail(convId);
      toast({ title: t("inbox.react.failed"), variant: "destructive" });
    }
  }

  async function sendReply() {
    if (!selectedId || contactBlocked || (!reply.trim() && pendingFiles.length === 0)) return;
    setSending(true);
    setUploading(true);
    try {
      const attachments: Array<{ url: string; type: string; name: string; voiceNote?: boolean }> = [];
      for (const file of pendingFiles) {
        const r = await uploadFileForInbox(file);
        if (!r) { setSending(false); setUploading(false); return; }
        attachments.push(r);
      }
      setUploading(false);
      const res: any = await customFetch(`/api/inbox/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: reply.trim(),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(replyToMsg ? { replyToMessageId: replyToMsg.id } : {}),
        }),
      });
      if (res?.simulated) toast({ title: t("messagesPage.sentSimulated"), description: t("messagesPage.outboundSimulated") });
      else toast({ title: t("messagesPage.sent") });
      setReply("");
      setPendingFiles([]);
      setReplyToMsg(null);
      // Optimistic: the newest message is now outbound, so the orange
      // "awaiting reply" dot clears immediately without waiting for a refetch.
      setConvs(prev => prev.map(c => c.id === selectedId ? { ...c, awaitingReply: false } : c));
      fetchDetail(selectedId);
    } catch (err: any) {
      const body = err?.body ?? err?.data;
      if (body?.error === "outside_24h_window") {
        toast({ title: t("messagesPage.outsideWindow"), description: t("messagesPage.useTemplateInstead"), variant: "destructive" });
        await openTemplateDialog();
      } else if (body?.error === "template_variables_missing") {
        toast({
          title: t("messagesPage.failedToSendTemplate"),
          description: body?.message || body?.missingVariables?.join(", "),
          variant: "destructive",
        });
      } else {
        toast({ title: body?.error || "Failed to send", variant: "destructive" });
      }
    } finally {
      setSending(false);
      setUploading(false);
    }
  }

  async function sendApplicationDocument(document: {
    applicationId: number;
    documentId: number;
    fileName: string;
    mimeType?: string | null;
  }) {
    if (!selectedId || contactBlocked || metaReplyWindowClosed) {
      toast({
        title: contactBlocked ? t("messagesPage.contactBlocked") : t("messagesPage.outsideWindow"),
        description: contactBlocked ? t("messagesPage.blockedReplyPlaceholder") : t("messagesPage.useTemplateInstead"),
        variant: "destructive",
      });
      return;
    }

    setSending(true);
    setUploading(true);
    try {
      const response = await fetch(
        `/api/applications/${document.applicationId}/stage-documents/${document.documentId}/download`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("Document could not be downloaded");
      const blob = await response.blob();
      const file = new File([blob], document.fileName, {
        type: document.mimeType || blob.type || "application/octet-stream",
      });
      const attachment = await uploadFileForInbox(file);
      if (!attachment) return;

      const result: any = await customFetch(
        `/api/inbox/conversations/${selectedId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "", attachments: [attachment] }),
        },
      );
      toast({
        title: result?.simulated
          ? t("messagesPage.sentSimulated")
          : t("messagesPage.sent"),
      });
      setConvs((previous) =>
        previous.map((conversation) =>
          conversation.id === selectedId
            ? { ...conversation, awaitingReply: false }
            : conversation,
        ),
      );
      await fetchDetail(selectedId);
    } catch (err: any) {
      const body = err?.body ?? err?.data;
      if (body?.error === "outside_24h_window") {
        toast({
          title: t("messagesPage.outsideWindow"),
          description: t("messagesPage.useTemplateInstead"),
          variant: "destructive",
        });
      } else {
        toast({
          title: body?.error || err?.message || t("messagesPage.failedToSend"),
          variant: "destructive",
        });
      }
    } finally {
      setSending(false);
      setUploading(false);
    }
  }

  async function toggleStar(convId: number, e: React.MouseEvent) {
    e.stopPropagation();
    // Optimistic: flip the star in the list immediately; reconcile with the
    // server response (and roll back on failure).
    setConvs(prev => prev.map(c => c.id === convId ? { ...c, isStarred: !c.isStarred } : c));
    try {
      const res = await customFetch(`/api/inbox/conversations/${convId}/star`, { method: "POST" }) as any;
      setConvs(prev => prev.map(c => c.id === convId ? { ...c, isStarred: Boolean(res.starred) } : c));
      toast({ title: res.starred ? t("inbox.action.star") : t("inbox.action.unstar") });
    } catch {
      setConvs(prev => prev.map(c => c.id === convId ? { ...c, isStarred: !c.isStarred } : c));
      toast({ title: "Failed to update", variant: "destructive" });
    }
  }

  async function toggleSubscribe(convId: number) {
    try {
      const res = await customFetch(`/api/inbox/conversations/${convId}/subscribe`, { method: "POST" }) as any;
      fetchInbox();
      if (selectedId === convId) fetchDetail(convId);
      toast({ title: res.subscribed ? t("inbox.action.subscribe") : t("inbox.action.unsubscribe") });
    } catch {
      toast({ title: "Failed to update", variant: "destructive" });
    }
  }

  async function setConversationReadState(
    convId: number,
    unread: boolean,
    event?: React.MouseEvent,
  ) {
    event?.stopPropagation();
    const previousCount = convs.find((c) => c.id === convId)?.unreadCount ?? 0;
    setConvs((prev) => prev.map((c) =>
      c.id === convId ? { ...c, unreadCount: unread ? Math.max(1, previousCount) : 0 } : c
    ));
    try {
      const response = await customFetch(
        `/api/inbox/conversations/${convId}/read-state`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unread }),
        },
      ) as { unreadCount?: number };
      const unreadCount = Number(response?.unreadCount ?? (unread ? 1 : 0));
      setConvs((prev) => prev.map((c) =>
        c.id === convId ? { ...c, unreadCount } : c
      ));
      toast({
        title: unread
          ? t("inbox.action.markUnread")
          : t("inbox.action.markRead"),
      });

      // Detail GET marks a thread read. Close an open thread after explicitly
      // marking it unread so a live-event detail refetch cannot immediately
      // undo the operator's choice.
      if (unread && selectedId === convId) {
        setSelectedId(null);
        setDetail(null);
      }
      void fetchInbox();
    } catch {
      setConvs((prev) => prev.map((c) =>
        c.id === convId ? { ...c, unreadCount: previousCount } : c
      ));
      toast({
        title: t("inbox.action.readStateFailed"),
        variant: "destructive",
      });
    }
  }

  // Faz 4.2: AI summary + note + task mutations.
  // ApiError (lib/api-client-react custom-fetch.ts) exposes `.status` (number)
  // and `.data` (parsed JSON error body). We re-fetch the detail on summarize
  // success so the sidebar renders the freshly-generated content.
  const summarizeMutation = useSummarizeInboxConversation({
    mutation: {
      onSuccess: (resp) => {
        if (selectedId) fetchDetail(selectedId);
        if (!resp.fromCache) toast({ title: t("inbox.aiSummary.generated") });
      },
      onError: (err: any) => {
        const status: number | undefined = err?.status;
        const errBody = err?.data ?? err?.body;
        const errCode = String(errBody?.error ?? "");
        let msg = t("inbox.aiSummary.errorGeneric");
        if (status === 429) msg = t("inbox.aiSummary.errorRateLimit");
        else if (status === 502) msg = t("inbox.aiSummary.errorService");
        else if (status === 400 && /no.*messages|messages.*summarize/i.test(errCode)) {
          msg = t("inbox.aiSummary.errorNoMessages");
        } else if (status === 400) {
          msg = t("inbox.aiSummary.errorNoLink");
        }
        toast({ variant: "destructive", title: msg });
      },
    },
  });

  const noteMutation = useAddInboxConversationNote({
    mutation: {
      onSuccess: () => {
        toast({ title: t("inbox.compose.noteSaved") });
        setNoteDraft("");
      },
      onError: () => {
        toast({ variant: "destructive", title: t("inbox.compose.noteFailed") });
      },
    },
  });

  const taskMutation = useAddInboxConversationTask({
    mutation: {
      onSuccess: () => {
        toast({ title: t("inbox.compose.taskCreated") });
        setTaskDraft({ title: "", scheduledAt: "", notes: "" });
      },
      onError: () => {
        toast({ variant: "destructive", title: t("inbox.compose.taskFailed") });
      },
    },
  });

  const handleSummarize = () => {
    if (selectedId) summarizeMutation.mutate({ id: selectedId });
  };
  const handleSubmitNote = () => {
    if (!selectedId || !noteDraft.trim()) return;
    noteMutation.mutate({ id: selectedId, data: { content: noteDraft.trim() } });
  };
  const handleSubmitTask = () => {
    if (!selectedId || !taskDraft.title.trim() || !taskDraft.scheduledAt) return;
    const scheduled = new Date(taskDraft.scheduledAt);
    if (Number.isNaN(scheduled.getTime())) return;
    taskMutation.mutate({
      id: selectedId,
      data: {
        title: taskDraft.title.trim(),
        scheduledAt: scheduled.toISOString(),
        notes: taskDraft.notes.trim() || undefined,
      },
    });
  };

  function openTemplateDialog() {
    setTplInitialId(null);
    setTplOpen(true);
  }

  async function chooseComposerTemplate(template: ComposerTemplate) {
    if (template.externalTemplateName) {
      setReply("");
      setTplInitialId(template.id);
      setTplOpen(true);
    } else {
      if (!selectedId) return;
      try {
        const rendered: any = await customFetch(
          `/api/inbox/conversations/${selectedId}/template-preview`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: template.content }),
          },
        );
        setReply(rendered.content);
      } catch (err: any) {
        const body = err?.body ?? err?.data;
        toast({
          title: t("messagesPage.failedToSendTemplate"),
          description: body?.message || body?.missingVariables?.join(", "),
          variant: "destructive",
        });
      }
    }
    setSlashActiveIndex(0);
  }

  async function sendTemplate(templateId: number, parameters: string[]) {
    if (!selectedId) return;
    setTplSending(true);
    try {
      const res: any = await customFetch(`/api/inbox/conversations/${selectedId}/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, parameters }),
      });
      if (res?.simulated) toast({ title: t("messagesPage.templateSentSimulated") });
      else toast({ title: t("messagesPage.templateSent") });
      setTplOpen(false);
      setTplInitialId(null);
      fetchDetail(selectedId);
    } finally {
      setTplSending(false);
    }
  }

  const newWaConvSearchDebounced = useCallback(
    async (q: string) => {
      if (!q.trim()) { setNewWaConvResults([]); return; }
      setNewWaConvLoading(true);
      try {
        const [stuRes, leadRes] = await Promise.all([
          customFetch(`/api/students?search=${encodeURIComponent(q)}&limit=8`).catch(() => null),
          customFetch(`/api/leads?search=${encodeURIComponent(q)}&limit=8`).catch(() => null),
        ]);
        const students: any[] = (stuRes as any)?.data || [];
        const leads: any[] = (leadRes as any)?.data || [];
        const mapped: typeof newWaConvResults = [
          ...students
            .filter(s => s.phoneE164 || s.phone)
            .map(s => ({
              entityType: "student",
              entityId: s.id,
              name: `${s.firstName || ""} ${s.lastName || ""}`.trim() || `#${s.id}`,
              phone: s.phoneE164 || s.phone || "",
            })),
          ...leads
            .filter(l => l.phoneE164 || l.phone)
            .map(l => ({
              entityType: "lead",
              entityId: l.id,
              name: `${l.firstName || ""} ${l.lastName || ""}`.trim() || `#${l.id}`,
              phone: l.phoneE164 || l.phone || "",
            })),
        ];
        setNewWaConvResults(mapped);
      } catch {
        setNewWaConvResults([]);
      } finally {
        setNewWaConvLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const t = setTimeout(() => { newWaConvSearchDebounced(newWaConvSearch); }, 300);
    return () => clearTimeout(t);
  }, [newWaConvSearch, newWaConvSearchDebounced]);

  async function handleNewWaConvSend(templateId: number, parameters: string[]) {
    if (!newWaConvSelected) return;
    setNewWaConvSending(true);
    try {
      const res: any = await customFetch(`/api/inbox/conversations/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType: newWaConvSelected.entityType,
          entityId: newWaConvSelected.entityId,
          templateId,
          parameters,
          channelAccountId: newWaConvAccountId ? Number(newWaConvAccountId) : undefined,
        }),
      });
      toast({ title: t("messagesPage.newConvSent") });
      setNewWaConvTplOpen(false);
      setNewWaConvOpen(false);
      setNewWaConvSelected(null);
      setNewWaConvSearch("");
      setNewWaConvResults([]);
      if (res?.conversationId) {
        setLocation(`/staff/messages?conversation=${res.conversationId}`);
      } else {
        fetchInbox();
      }
    } finally {
      setNewWaConvSending(false);
    }
  }

  function startListResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    if (listResizeCleanupRef.current) listResizeCleanupRef.current();
    const startX = e.clientX;
    const startW = listWidth;
    const maxW = inboxListMaxWidth();
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const delta = isRTL ? startX - ev.clientX : ev.clientX - startX;
      setListWidth(Math.min(maxW, Math.max(INBOX_LIST_MIN_WIDTH, startW + delta)));
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      listResizeCleanupRef.current = null;
    };
    const onEnd = () => {
      cleanup();
      setListWidth((w) => {
        try {
          localStorage.setItem(INBOX_LIST_WIDTH_STORAGE_KEY, String(w));
        } catch {
          // localStorage unavailable — width just won't persist
        }
        return w;
      });
    };
    listResizeCleanupRef.current = cleanup;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  function resetListWidth() {
    if (listResizeCleanupRef.current) listResizeCleanupRef.current();
    setListWidth(INBOX_LIST_DEFAULT_WIDTH);
    try {
      localStorage.setItem(INBOX_LIST_WIDTH_STORAGE_KEY, String(INBOX_LIST_DEFAULT_WIDTH));
    } catch {
      // localStorage unavailable — width just won't persist
    }
  }

  function togglePinnedTab(key: InboxTabKey) {
    setPinnedTab((prev) => {
      const next = prev === key ? null : key;
      try {
        if (next) localStorage.setItem(PINNED_INBOX_TAB_STORAGE_KEY, next);
        else localStorage.removeItem(PINNED_INBOX_TAB_STORAGE_KEY);
      } catch {
        // localStorage unavailable — pin just won't persist
      }
      return next;
    });
  }

  const channelOptions = ["all", "whatsapp", "web_chat", "messenger", "instagram", "web_form", "email", "sms", "telegram"];
  const tabs: Array<{ key: typeof tab; label: string; icon: any }> = [
    { key: "all", label: t("messagesPage.all"), icon: Hash },
    { key: "mine", label: t("messagesPage.mine"), icon: UserCheck },
    { key: "unassigned", label: t("messagesPage.unassigned"), icon: InboxIcon },
    { key: "open", label: t("inbox.tabs.open"), icon: MessageCircle },
    { key: "unanswered", label: t("inbox.tabs.unanswered"), icon: Clock },
    { key: "unread", label: t("inbox.tabs.unread"), icon: MessageSquare },
    { key: "awaiting", label: t("inbox.tabs.awaiting"), icon: CornerUpLeft },
    { key: "subscribed", label: t("inbox.tabs.subscribed"), icon: Bell },
    { key: "starred", label: t("inbox.tabs.starred"), icon: Star },
    { key: "unmatched", label: t("messagesPage.unmatched"), icon: AlertTriangle },
    { key: "archived", label: t("inbox.tabs.archived"), icon: Archive },
  ];
  const selectedStaff = assignedStaffId === null
    ? null
    : inboxStaff.find((staffUser) => staffUser.id === assignedStaffId) ?? null;
  const selectedStaffName = selectedStaff
    ? `${selectedStaff.firstName ?? ""} ${selectedStaff.lastName ?? ""}`.trim() || selectedStaff.email || `#${selectedStaff.id}`
    : null;

  // ── Thread helpers: windowed history, smart auto-scroll, retry ──────────

  // Merge older pages (loaded via `before` cursor) with the live window.
  const allMsgs = useMemo(() => {
    const base = ((detail?.messages || []) as any[]);
    const seen = new Set(base.map((m) => m.id));
    return [...olderMsgs.filter((m) => !seen.has(m.id)), ...base];
  }, [detail, olderMsgs]);

  async function loadOlderMessages() {
    if (!selectedId || loadingOlder) return;
    const oldest = allMsgs[0];
    if (!oldest) return;
    setLoadingOlder(true);
    const el = msgScrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const res: any = await customFetch(`/api/inbox/conversations/${selectedId}?before=${oldest.id}&limit=50`);
      const older = (res?.messages || []) as any[];
      setHasMoreOlder(Boolean(res?.hasMoreMessages));
      setOlderMsgs((prev) => {
        const have = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !have.has(m.id)), ...prev];
      });
      // Keep the viewport anchored on the message the user was reading.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } catch {
      // non-fatal; the button stays available
    } finally {
      setLoadingOlder(false);
    }
  }

  // Smart auto-scroll: stick to bottom when the user is already there;
  // otherwise show a "new messages" jump badge instead of yanking the view.
  useEffect(() => {
    const el = msgScrollRef.current;
    if (!el || allMsgs.length === 0) return;
    const last = allMsgs[allMsgs.length - 1];
    const prevLast = prevLastMsgIdRef.current;
    if (prevLast === last.id) return;
    prevLastMsgIdRef.current = last.id;
    if (prevLast === null || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setNewBelow(0);
    } else {
      setNewBelow((n) => n + 1);
    }
  }, [allMsgs]);

  const handleMsgScroll = () => {
    const el = msgScrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    atBottomRef.current = atBottom;
    if (atBottom) setNewBelow(0);
  };

  const jumpToBottom = () => {
    const el = msgScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setNewBelow(0);
  };

  async function retryMessage(id: number) {
    setRetryingId(id);
    try {
      await customFetch(`/api/inbox/messages/${id}/retry`, { method: "POST" });
      toast({ title: t("inbox.retry.success") });
    } catch (err: any) {
      toast({ title: err?.body?.error || t("inbox.retry.failed"), variant: "destructive" });
    } finally {
      setRetryingId(null);
    }
    if (selectedId) fetchDetail(selectedId);
  }

  // ── Bulk selection helpers ───────────────────────────────────────────────
  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((prev) =>
      prev.size === convs.length ? new Set() : new Set(convs.map((c) => c.id)),
    );
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  async function runBulk(type: "archive" | "unarchive" | "delete") {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const path = type === "archive" ? "bulk-archive" : type === "unarchive" ? "bulk-unarchive" : "bulk-delete";
      await customFetch(`/api/inbox/conversations/${path}`, {
        method: "POST",
        body: JSON.stringify(type === "delete" ? { ids, confirm: "DELETE_CONVERSATIONS" } : { ids }),
      });
      toast({
        title:
          type === "archive"
            ? t("inbox.bulk.archivedToast", { count: ids.length })
            : type === "unarchive"
              ? t("inbox.bulk.restoredToast", { count: ids.length })
              : t("inbox.bulk.deletedToast", { count: ids.length }),
      });
      setBulkConfirm(null);
      exitSelectMode();
      if (selectedId && ids.includes(selectedId)) setSelectedId(null);
      fetchInbox();
    } catch (err: any) {
      toast({ title: err?.body?.error || t("inbox.bulk.failed"), variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  }

  // Day separator label: Today / Yesterday / localized date.
  const dayLabelOf = (d: Date) => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t("inbox.chat.today");
    if (d.toDateString() === yesterday.toDateString()) return t("inbox.chat.yesterday");
    return d.toLocaleDateString();
  };

  // Safe non-null assertion: `conv` is only read inside the `!detail ? loader : (...)` JSX branch below.
  const conv = detail?.conversation!;
  const activeLineBrand = whatsappLineBrand(conv?.channel, conv?.channelAccount);
  const externalAutoReplyAvailable = isExternalAutoReplyAvailable(
    conv?.channel,
    conv?.channelAccount,
  );
  const metaReplyWindowClosed = Boolean(
    detail &&
    (conv?.channel === "whatsapp" || conv?.channel === "messenger" || conv?.channel === "instagram") &&
    !detail.withinWindow
  );
  const ext = detail?.externalContact;
  const contactBlocked = Boolean((ext as any)?.isBlocked);
  const linked = ext && (ext.leadId || ext.studentId || ext.agentId);
  // Student wins over lead (converted leads have both leadId and studentId set).
  const linkedLabel = ext?.studentId ? "Student" : ext?.leadId ? "Lead" : ext?.agentId ? "Agent" : null;
  const linkedHref =
    ext?.studentId ? `/staff/students/${ext.studentId}` :
    ext?.leadId ? `/staff/leads/${ext.leadId}` :
    ext?.agentId ? `/staff/agents/${ext.agentId}` : null;

  return (
    <>
    <Card
      className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm"
      style={{
        height: "calc(100dvh - 150px)",
        maxHeight: "calc(100dvh - 150px)",
        minHeight: "32rem",
      }}
    >
      <div className="flex h-full min-h-0">
        <div
          className={`h-full min-h-0 min-w-0 overflow-hidden w-full lg:w-[var(--inbox-list-w)] lg:shrink-0 ${selectedId !== null ? "hidden min-[1180px]:flex min-[1180px]:!w-[220px] min-[1180px]:flex-col min-[1440px]:!w-[var(--inbox-list-w)]" : "flex flex-col"}`}
          style={{ "--inbox-list-w": `${listWidth}px` } as React.CSSProperties}
        >
          <div className="p-3 border-b border-border/50 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <InboxIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground truncate">
                  {t("messagesPage.inbox")}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1 text-green-700 hover:text-green-800 hover:bg-green-50"
                  onClick={() => setNewWaConvOpen(true)}
                  title={t("messagesPage.newConversation")}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t("messagesPage.newConversation")}
                </Button>
                <LiveStatusIndicator
                  status={effectiveLiveStatus}
                  lastEventAt={lastEventAt}
                  now={now}
                  onReconnect={reconnectLive}
                />
              </div>
            </div>

            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={inboxSearch}
                onChange={(event) => setInboxSearch(event.target.value)}
                placeholder={t("messagesPage.searchConversations")}
                className="h-8 pl-8 pr-8 text-xs"
                data-testid="input-inbox-search"
              />
              {inboxSearch && (
                <button
                  type="button"
                  onClick={() => setInboxSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("messagesPage.cancel")}
                  data-testid="button-clear-inbox-search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between gap-2 h-8"
                  data-testid="button-inbox-tab-filter"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {(() => {
                      if (selectedStaffName) {
                        return (
                          <>
                            <UserCheck className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{selectedStaffName}</span>
                          </>
                        );
                      }
                      const current = tabs.find((tb) => tb.key === tab) ?? tabs[0];
                      const Icon = current.icon;
                      return (
                        <>
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{current.label}</span>
                          {pinnedTab === tab && (
                            <Pin className="w-3 h-3 shrink-0 text-primary fill-current" />
                          )}
                        </>
                      );
                    })()}
                  </span>
                  <ChevronDown className="w-3 h-3 opacity-60 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                {tabs.map((tb) => {
                  const Icon = tb.icon;
                  const active = tab === tb.key;
                  const pinned = pinnedTab === tb.key;
                  return (
                    <DropdownMenuItem
                      key={tb.key}
                      onClick={() => {
                        setAssignedStaffId(null);
                        setTab(tb.key);
                      }}
                      className={cn("flex items-center gap-2", assignedStaffId === null && active && "bg-accent")}
                    >
                      <Icon className={cn("w-3.5 h-3.5 shrink-0", !active && "opacity-60")} />
                      <span className="flex-1 truncate">{tb.label}</span>
                      {assignedStaffId === null && active && <Check className="w-3.5 h-3.5 shrink-0 opacity-70" />}
                      <button
                        type="button"
                        aria-pressed={pinned}
                        title={pinned ? t("inbox.tabs.unpinDefault") : t("inbox.tabs.pinDefault")}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          togglePinnedTab(tb.key);
                        }}
                        className={cn(
                          "p-1 rounded hover:bg-muted shrink-0",
                          pinned ? "text-primary" : "text-muted-foreground opacity-50 hover:opacity-100"
                        )}
                      >
                        <Pin className={cn("w-3.5 h-3.5", pinned && "fill-current")} />
                      </button>
                    </DropdownMenuItem>
                  );
                })}
                <div className="my-1 h-px bg-border" />
                {inboxStaffLoading && (
                  <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("common.loading")}
                  </div>
                )}
                {!inboxStaffLoading && inboxStaff.length === 0 && (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {t("messagesPage.noStaffFound")}
                  </div>
                )}
                <div className="max-h-56 overflow-y-auto">
                  {inboxStaff.map((staffUser) => {
                    const staffName = `${staffUser.firstName ?? ""} ${staffUser.lastName ?? ""}`.trim() || staffUser.email || `#${staffUser.id}`;
                    const active = staffUser.id === assignedStaffId;
                    return (
                      <DropdownMenuItem
                        key={`staff-${staffUser.id}`}
                        onClick={() => {
                          setTab("all");
                          setAssignedStaffId(staffUser.id);
                        }}
                        className={cn("flex items-center gap-2", active && "bg-accent")}
                        data-testid={`option-inbox-staff-${staffUser.id}`}
                      >
                        <UserCheck className={cn("h-3.5 w-3.5 shrink-0", !active && "opacity-60")} />
                        <span className="flex-1 truncate">{staffName}</span>
                        {active && <Check className="h-3.5 w-3.5 shrink-0 opacity-70" />}
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full justify-between gap-2 h-8">
                  <span className="flex items-center gap-2 min-w-0">
                    {channel !== "all" && (
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          channel === "whatsapp" && "bg-green-500",
                          channel === "messenger" && "bg-blue-600",
                          channel === "instagram" && "bg-pink-500",
                          channel === "web_form" && "bg-indigo-500",
                          channel === "web_chat" && "bg-cyan-600",
                          channel === "email" && "bg-purple-500",
                          channel === "sms" && "bg-amber-500",
                          channel === "telegram" && "bg-sky-500"
                        )}
                      />
                    )}
                    <Filter className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      {channel === "all"
                        ? t("messagesPage.allChannels")
                        : t(`inbox.channels.${channel}`)}
                    </span>
                  </span>
                  <ChevronDown className="w-3 h-3 opacity-60 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
                {channelOptions.map((ch) => {
                  const Icon = ch === "all" ? InboxIcon : (channelIcon[ch] || MessageCircle);
                  return (
                    <DropdownMenuItem key={ch} onClick={() => setChannel(ch)}>
                      <Icon
                        className={cn(
                          "w-4 h-4 me-2",
                          ch === "whatsapp" && "text-green-600",
                          ch === "messenger" && "text-blue-700",
                          ch === "instagram" && "text-pink-600",
                          ch === "web_form" && "text-indigo-600",
                          ch === "web_chat" && "text-cyan-700",
                          ch === "email" && "text-purple-600",
                          ch === "sms" && "text-amber-600",
                          ch === "telegram" && "text-sky-600"
                        )}
                      />
                      {ch === "all"
                        ? t("messagesPage.allChannels")
                        : t(`inbox.channels.${ch}`)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
                title={t("inbox.sort.toggle")}
                data-testid="button-inbox-sort"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                {sortOrder === "desc" ? t("inbox.sort.newestFirst") : t("inbox.sort.oldestFirst")}
              </Button>
              {["super_admin", "admin"].includes(user?.role || "") && (
              <Button
                variant="ghost"
                size="sm"
                className={cn("h-7 px-2 text-xs gap-1", showTests ? "text-amber-600" : "text-muted-foreground")}
                onClick={() => setShowTests((v) => !v)}
                title={t("inbox.tests.toggleHint")}
                data-testid="button-inbox-show-tests"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {showTests ? t("inbox.tests.shown") : t("inbox.tests.hidden")}
              </Button>
              )}
              <div className="flex-1" />
              <Button
                variant={selectMode ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                data-testid="button-inbox-select-mode"
              >
                <ListChecks className="w-3.5 h-3.5" />
                {selectMode ? t("inbox.bulk.cancel") : t("inbox.bulk.select")}
              </Button>
            </div>

            {selectMode && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 py-1.5">
                <button
                  type="button"
                  onClick={selectAllVisible}
                  className="text-xs font-medium text-primary hover:underline shrink-0"
                >
                  {selectedIds.size === convs.length && convs.length > 0
                    ? t("inbox.bulk.clearAll")
                    : t("inbox.bulk.selectAll")}
                </button>
                <span className="text-xs text-muted-foreground flex-1 truncate">
                  {t("inbox.bulk.selectedCount", { count: selectedIds.size })}
                </span>
                {tab === "archived" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] gap-1"
                    disabled={selectedIds.size === 0 || bulkBusy}
                    onClick={() => setBulkConfirm("unarchive")}
                    data-testid="button-bulk-unarchive"
                  >
                    <ArchiveRestore className="w-3 h-3" /> {t("inbox.bulk.restore")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[11px] gap-1"
                    disabled={selectedIds.size === 0 || bulkBusy}
                    onClick={() => setBulkConfirm("archive")}
                    data-testid="button-bulk-archive"
                  >
                    <Archive className="w-3 h-3" /> {t("inbox.bulk.archive")}
                  </Button>
                )}
                {canDeleteConversations && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-6 px-2 text-[11px] gap-1"
                    disabled={selectedIds.size === 0 || bulkBusy}
                    onClick={() => setBulkConfirm("delete")}
                    data-testid="button-bulk-delete"
                  >
                    <Trash2 className="w-3 h-3" /> {t("inbox.bulk.delete")}
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
            ) : convs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <InboxIcon className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">{t("messagesPage.noConversations")}</p>
              </div>
            ) : convs.map((c) => {
              const Icon = channelIcon[c.channel] || MessageCircle;
              const lineBrand = whatsappLineBrand(c.channel, c.channelAccount);
              const isSel = c.id === selectedId;
              const isChecked = selectedIds.has(c.id);
              const unreadCount = c.unreadCount ?? 0;
              const isUnread = unreadCount > 0;
              const displayName = c.externalContact?.displayName || c.title || "(unknown)";
              return (
                <div
                  key={c.id}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "68px" }}
                  data-testid="inbox-conversation-item"
                  data-unread={isUnread ? "true" : "false"}
                  aria-label={isUnread ? `${displayName}, ${unreadCount} ${t("inbox.tabs.unread")}` : displayName}
                  onClick={() => (selectMode ? toggleSelected(c.id) : setSelectedId(c.id))}
                  className={`relative flex items-center gap-3 px-4 py-3 cursor-pointer border-b transition-colors ${
                    isSel && !selectMode
                      ? "bg-primary/5 border-b-primary/20 border-l-4 border-l-primary"
                      : isChecked
                        ? "bg-primary/10 border-b-primary/20"
                        : isUnread
                          ? "bg-emerald-50/90 border-b-emerald-100 border-l-4 border-l-emerald-500 hover:bg-emerald-100/80 dark:bg-emerald-950/25 dark:border-b-emerald-900/60 dark:hover:bg-emerald-950/40"
                          : "border-border/30 border-l-4 border-l-transparent hover:bg-secondary/50"
                  }`}
                >
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelected(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-4 h-4 shrink-0 accent-primary"
                      data-testid={`checkbox-conv-${c.id}`}
                    />
                  )}
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      lineBrand ? "" : channelColor[c.channel] || ""
                    } ${isUnread ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""}`}
                    style={lineBrand ? { color: lineBrand.color, backgroundColor: `${lineBrand.color}18` } : undefined}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        <p className={`text-sm truncate ${isUnread ? "font-extrabold text-foreground" : "font-medium"}`}>
                          {displayName}
                        </p>
                        {isUnread && (
                          <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wide text-white">
                            {t("inbox.tabs.unread")}
                          </span>
                        )}
                      </div>
                      {c.unmatched && <Badge variant="outline" className="text-[9px] h-4 border-amber-300 text-amber-700 px-1">unmatched</Badge>}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                      {lineBrand && (
                        <span
                          className="inline-flex h-4 max-w-[7.5rem] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[9px] font-bold leading-none"
                          style={{ color: lineBrand.color, borderColor: `${lineBrand.color}59`, backgroundColor: `${lineBrand.color}18` }}
                          title={`Gelen hat: ${lineBrand.label}`}
                          data-testid={`line-badge-${c.id}`}
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: lineBrand.color }} />
                          <span className="truncate">{lineBrand.label}</span>
                        </span>
                      )}
                      <p className={`min-w-0 flex-1 truncate text-xs ${isUnread ? "text-foreground font-bold" : "text-muted-foreground"}`}>{c.lastMessagePreview || "—"}</p>
                    </div>
                  </div>
                  {!selectMode && (c.awaitingReply || isUnread) && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      {c.awaitingReply && (
                        <span
                          className="w-2 h-2 rounded-full bg-orange-500 shrink-0"
                          title={t("inbox.tabs.awaiting")}
                          data-testid={`awaiting-dot-${c.id}`}
                        />
                      )}
                      {isUnread && (
                        <span
                          className="min-w-[22px] h-[22px] px-1.5 rounded-full bg-emerald-600 text-white text-[10px] font-extrabold flex items-center justify-center shrink-0 shadow-sm ring-2 ring-emerald-200 dark:ring-emerald-900"
                          data-testid={`unread-badge-${c.id}`}
                        >
                          {unreadCount > 99 ? "99+" : unreadCount}
                        </span>
                      )}
                    </div>
                  )}
                  {!selectMode && (
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-muted shrink-0 text-muted-foreground/60 hover:text-foreground"
                      onClick={(e) => setConversationReadState(c.id, !isUnread, e)}
                      title={isUnread ? t("inbox.action.markRead") : t("inbox.action.markUnread")}
                      aria-label={isUnread ? t("inbox.action.markRead") : t("inbox.action.markUnread")}
                      data-testid={`button-read-state-${c.id}`}
                    >
                      {isUnread
                        ? <CheckCheck className="w-3.5 h-3.5" />
                        : <Mail className="w-3.5 h-3.5" />}
                    </button>
                  )}
                  {!selectMode && (
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-muted shrink-0"
                      onClick={(e) => toggleStar(c.id, e)}
                      title={c.isStarred ? t("inbox.action.unstar") : t("inbox.action.star")}
                    >
                      <Star className={`w-3.5 h-3.5 ${c.isStarred ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"}`} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startListResize}
          onDoubleClick={resetListWidth}
          title={t("inbox.resizer.resetHint")}
          className="hidden min-[1440px]:flex shrink-0 w-[7px] -mx-[3px] z-10 cursor-col-resize items-stretch justify-center group touch-none"
        >
          <div className="w-px bg-border/50 group-hover:bg-primary/60 group-active:bg-primary transition-colors" />
        </div>

        <div className={`flex-1 min-w-0 flex flex-col h-full min-h-0 overflow-hidden ${selectedId === null ? "hidden lg:flex lg:items-center lg:justify-center" : ""}`}>
          {!selectedId ? (
            <div className="text-center text-muted-foreground">
              <InboxIcon className="w-16 h-16 mx-auto mb-3 opacity-20" />
              <p className="font-medium">{t("messagesPage.selectConversation")}</p>
            </div>
          ) : !detail ? (
            <div className="flex items-center justify-center w-full h-full"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b border-border/60 bg-background/95 px-3 py-2.5 sm:px-4">
                <Button size="icon" variant="ghost" className="h-8 w-8 min-[1180px]:hidden" onClick={() => setSelectedId(null)}>
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <div className="flex-1 basis-[18rem] min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <p className="font-semibold text-sm truncate">{ext?.displayName || conv.title || "(unknown)"}</p>
                    <Badge variant="secondary" className={`text-[10px] ${channelColor[conv.channel] || ""}`}>{conv.channel}</Badge>
                    {activeLineBrand && (
                      <Badge
                        variant="outline"
                        className="gap-1 text-[10px]"
                        style={{ color: activeLineBrand.color, borderColor: `${activeLineBrand.color}59`, backgroundColor: `${activeLineBrand.color}18` }}
                        title={`Gelen hat: ${activeLineBrand.label}`}
                        data-testid="active-line-badge"
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: activeLineBrand.color }}
                        />
                        {activeLineBrand.label}
                      </Badge>
                    )}
                    {linked && linkedHref && (
                      <a
                        href={linkedHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${linkedLabel} #${ext.studentId || ext.leadId || ext.agentId} in a new tab`}
                      >
                        <Badge variant="outline" className="text-[10px] gap-1 cursor-pointer hover:bg-primary/10">
                          <Link2 className="w-3 h-3" /> {linkedLabel} #{ext.studentId || ext.leadId || ext.agentId}
                        </Badge>
                      </a>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                    {(ext?.phone || ext?.email) && (
                      <span className="max-w-full truncate">{ext?.phone || ext?.email}</span>
                    )}
                    {conv.assignedTo && (
                      <>
                        {(ext?.phone || ext?.email) && <span aria-hidden>•</span>}
                        <span>assigned to</span>
                        <Avatar className="h-4 w-4">
                          {conv.assignedTo.avatarUrl ? (
                            <AvatarImage
                              src={conv.assignedTo.avatarUrl}
                              alt={`${conv.assignedTo.firstName} ${conv.assignedTo.lastName}`}
                            />
                          ) : null}
                          <AvatarFallback className="text-[8px] font-medium bg-primary/10 text-primary">
                            {((conv.assignedTo.firstName?.[0] ?? "") + (conv.assignedTo.lastName?.[0] ?? "")).toUpperCase() || "?"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{conv.assignedTo.firstName} {conv.assignedTo.lastName}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
                  {conv.needsHuman && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      <AlertTriangle className="w-3 h-3" /> {t("messagesPage.needsHuman")}
                    </span>
                  )}
                  {externalAutoReplyAvailable && (
                    <Button
                      size="sm"
                      variant={conv.botEnabled ? "default" : "outline"}
                      onClick={() => toggleBot(!conv.botEnabled)}
                      disabled={contactBlocked}
                      className="h-7 text-xs gap-1"
                      title={conv.botEnabled ? t("messagesPage.aiOnHint") : t("messagesPage.aiOffHint")}
                      data-testid="button-toggle-bot"
                    >
                      <Bot className="w-3 h-3" /> {conv.botEnabled ? t("messagesPage.aiOn") : t("messagesPage.aiOff")}
                    </Button>
                  )}
                  {conv.channel !== "internal" && ext && (
                    <Button
                      size="sm"
                      variant={contactBlocked ? "outline" : "destructive"}
                      onClick={() => toggleContactBlock(!contactBlocked)}
                      disabled={blockingContact}
                      className="h-7 text-xs gap-1"
                      title={contactBlocked ? t("messagesPage.unblockContact") : t("messagesPage.blockContact")}
                      data-testid="button-toggle-contact-block"
                    >
                      {blockingContact ? <Loader2 className="w-3 h-3 animate-spin" /> : contactBlocked ? <ShieldCheck className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
                      <span className="hidden min-[1800px]:inline">
                        {contactBlocked ? t("messagesPage.unblock") : t("messagesPage.block")}
                      </span>
                    </Button>
                  )}
                  {(user?.role === "super_admin" || user?.role === "admin") ? (
                    <AssignStaffDropdown
                      currentId={conv.assignedToId ?? null}
                      currentName={conv.assignedTo ? `${conv.assignedTo.firstName ?? ""} ${conv.assignedTo.lastName ?? ""}`.trim() : null}
                      onSelect={assignTo}
                      t={t}
                    />
                  ) : (
                    conv.assignedToId == null && (
                      <Button size="sm" variant="outline" onClick={assignToMe} className="h-7 text-xs gap-1">
                        <UserCheck className="w-3 h-3" /> {t("messagesPage.assignToMe")}
                      </Button>
                    )
                  )}
                  {assignedNotice && (
                    <span className="text-xs text-green-600 font-medium">{t("messagesPage.assignedToYou")}</span>
                  )}
                  <Button
                    size="sm"
                    variant={(conv as any).isSubscribed ? "default" : "outline"}
                    onClick={() => toggleSubscribe(conv.id)}
                    className="h-7 text-xs gap-1"
                    title={(conv as any).isSubscribed ? t("inbox.action.unsubscribe") : t("inbox.action.subscribe")}
                  >
                    <Bell className="w-3 h-3" />
                    <span className="hidden min-[1800px]:inline">{(conv as any).isSubscribed ? t("inbox.action.unsubscribe") : t("inbox.action.subscribe")}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConversationReadState(conv.id, true)}
                    className="h-7 text-xs gap-1"
                    title={t("inbox.action.markUnread")}
                    data-testid="button-mark-conversation-unread"
                  >
                    <Mail className="w-3 h-3" />
                    <span className="hidden min-[1800px]:inline">{t("inbox.action.markUnread")}</span>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 lg:hidden"
                    onClick={() => setSidebarSheetOpen(true)}
                    aria-label={t("inbox.sidebar.openLeadInfo")}
                    data-testid="button-open-lead-info"
                  >
                    <Info className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {conv.unmatched && (
                <div className="m-3 p-3 rounded-lg border border-amber-300 bg-amber-50 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5" />
                  <div className="flex-1 text-xs text-amber-900">
                    <p className="font-semibold">{t("messagesPage.unmatchedContact")}</p>
                    <p>{t("messagesPage.notLinkedYet")}</p>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={loadSuggestions}>
                    Match
                  </Button>
                </div>
              )}

              {contactBlocked && (
                <div className="m-3 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-red-900">
                  <Ban className="h-4 w-4 shrink-0" />
                  <p className="flex-1 text-xs">{t("messagesPage.blockedContactNotice")}</p>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => toggleContactBlock(false)} disabled={blockingContact}>
                    {t("messagesPage.unblock")}
                  </Button>
                </div>
              )}

              {(conv.channel === "whatsapp" || conv.channel === "messenger" || conv.channel === "instagram") && !detail.withinWindow && (
                <div className="m-3 p-3 rounded-lg border border-orange-300 bg-orange-50 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-orange-700" />
                  <p className="text-xs text-orange-900 flex-1">
                    {conv.channel === "whatsapp" ? t("messagesPage.outside24hReplyWindow") : t("messagesPage.outside24hReplyWindowMeta")}
                  </p>
                  {conv.channel === "whatsapp" && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openTemplateDialog}>{t("messagesPage.useTemplate")}</Button>
                  )}
                </div>
              )}

              <div
                className="relative flex-1 min-h-0 flex flex-col overflow-hidden"
                onDragEnter={handleChatDragEnter}
                onDragOver={handleChatDragOver}
                onDragLeave={handleChatDragLeave}
                onDrop={handleChatDrop}
              >
              {isDragging && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg pointer-events-none">
                  <div className="flex flex-col items-center gap-2 text-primary">
                    <Paperclip className="w-8 h-8" />
                    <span className="text-sm font-medium">{t("inbox.compose.dropFilesHere")}</span>
                  </div>
                </div>
              )}
              <div ref={msgScrollRef} onScroll={handleMsgScroll} className="flex-1 min-h-0 space-y-3 overflow-y-auto bg-gradient-to-b from-muted/15 via-background to-background p-3 sm:p-4 xl:px-6" data-testid="inbox-message-scroll">
                {hasMoreOlder && (
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1"
                      onClick={loadOlderMessages}
                      disabled={loadingOlder}
                      data-testid="button-load-older"
                    >
                      {loadingOlder ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
                      {t("inbox.chat.loadOlder")}
                    </Button>
                  </div>
                )}
                {allMsgs.map((m: any, idx: number) => {
                  const out = m.direction === "outbound";
                  const day = new Date(m.createdAt);
                  const prevMsg = idx > 0 ? allMsgs[idx - 1] : null;
                  const showDaySep = !prevMsg || new Date(prevMsg.createdAt).toDateString() !== day.toDateString();
                  return (
                    <div key={m.id}>
                    {showDaySep && (
                      <div className="flex items-center justify-center my-2">
                        <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {dayLabelOf(day)}
                        </span>
                      </div>
                    )}
                    <div className={`relative flex group ${out ? "justify-end" : "justify-start"}`}>
                      {/* Hover action buttons — reply + react */}
                      <div className={`flex items-center gap-0.5 self-center flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ${out ? "order-first mr-1.5" : "order-last ml-1.5"}`}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="h-6 w-6 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              onClick={() => {
                                const snippet = m.content && m.content !== "[attachment]" ? m.content.slice(0, 80) : "[attachment]";
                                setReplyToMsg({ id: m.id, snippet, senderName: m.senderName ?? "..." });
                              }}
                            >
                              <CornerUpLeft className="w-3.5 h-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top"><p>{t("inbox.replyAction.button")}</p></TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={t("inbox.forward.button")}
                              className="h-6 w-6 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              onClick={() => {
                                setForwardTargets(new Set());
                                setForwardSearch("");
                                setForwardMsgId(m.id);
                              }}
                            >
                              <Forward className="w-3.5 h-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top"><p>{t("inbox.forward.button")}</p></TooltipContent>
                        </Tooltip>
                        <div className="relative">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                aria-label={t("inbox.react.button")}
                                className="h-6 w-6 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                                onClick={(e) => {
                                  // Stop the opening click from bubbling to the document-level
                                  // outside-close listener (it runs in the same event cycle and
                                  // would instantly close the palette we just opened).
                                  e.stopPropagation();
                                  setEmojiPaletteFor(prev => prev === m.id ? null : m.id);
                                }}
                              >
                                <SmilePlus className="w-3.5 h-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top"><p>{t("inbox.react.button")}</p></TooltipContent>
                          </Tooltip>
                          {emojiPaletteFor === m.id && (
                            <div
                              ref={emojiPaletteRef}
                              className={`absolute bottom-full mb-1 z-30 flex items-center gap-0.5 rounded-2xl bg-popover border border-border shadow-lg px-2 py-1 ${out ? "right-0" : "left-0"}`}
                            >
                              {QUICK_EMOJIS.map(emoji => (
                                <button
                                  key={emoji}
                                  type="button"
                                  className="text-base hover:scale-125 transition-transform px-0.5 leading-none"
                                  onClick={() => toggleReaction(m.id, emoji)}
                                >
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex max-w-[min(82%,42rem)] flex-col">
                      <div className={`rounded-2xl px-3 py-2 text-sm ${out ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
                        {(m.metadata as any)?.forwarded && (
                          <div className={`flex items-center gap-1 text-[10px] italic mb-1 ${out ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                            <Forward className="w-3 h-3" />
                            {t("inbox.forward.label")}
                          </div>
                        )}
                        {m.repliedMessage && (
                          <div className={`mb-2 pl-2 border-l-2 rounded-sm text-xs py-1 pr-2 ${out ? "border-primary-foreground/40 bg-primary-foreground/10 opacity-75" : "border-foreground/30 bg-background/50 opacity-80"}`}>
                            <div className="font-semibold truncate">{m.repliedMessage.senderName}</div>
                            <div className="truncate max-w-[220px]">{m.repliedMessage.snippet}</div>
                          </div>
                        )}
                        {m.content && m.content !== "[attachment]" && (
                          <p className="whitespace-pre-wrap">{m.content}</p>
                        )}
                        {(() => {
                          const singleAtt = (m.metadata as any)?.attachment as MessageAttachment | undefined;
                          const allAtts: MessageAttachment[] = [
                            ...(singleAtt ? [singleAtt] : []),
                            ...((m.metadata as any)?.attachments ?? []),
                          ];
                          if (!allAtts.length) return null;
                          return (
                            <div className="mt-1.5 space-y-1.5">
                              {allAtts.map((a: MessageAttachment, i: number) => {
                                const rawUrl = a.url ?? a.fileUrl ?? "";
                                // Provider media and historical inbox-storage URLs are
                                // normalized through the authenticated API. This avoids
                                // exposing provider credentials and lets pdfjs preview
                                // absolute URLs saved under an older app origin.
                                const usesInboxMediaProxy = shouldProxyInboxAttachment(rawUrl);
                                const url = inboxAttachmentMediaUrl(rawUrl, m.id, i);
                                const type = a.type ?? a.fileType ?? "file";
                                const rawMeta = (m.metadata as any)?.raw;
                                const waRawType = rawMeta?.type;
                                const waMedia = waRawType ? (rawMeta[waRawType] as any) : null;
                                const waFilename = i === 0 ? (waMedia?.filename ?? waMedia?.file_name ?? null) : null;
                                const nameFromUrl = (() => {
                                  try {
                                    const seg = new URL(String(url)).pathname.split("/").pop() ?? "";
                                    return seg.includes(".") ? decodeURIComponent(seg) : null;
                                  } catch { return null; }
                                })();
                                const mimeExt = (() => {
                                  const mm = String((a as any).mimeType ?? a.fileType ?? "").split(";")[0].trim().toLowerCase();
                                  const map: Record<string, string> = {
                                    "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png",
                                    "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/webm": "webm", "audio/mpeg": "mp3",
                                    "application/msword": "doc",
                                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
                                  };
                                  return map[mm] ?? null;
                                })();
                                // Never show a bare "file" label: fall back to a
                                // localized type label (Document/Photo/Video/Audio)
                                // plus the mime-derived extension when known.
                                const attTypeLabel = type === "image" ? t("inbox.attachment.photo")
                                  : type === "video" ? t("inbox.attachment.video")
                                  : type === "audio" ? t("inbox.attachment.audio")
                                  : t("inbox.attachment.document");
                                const typedName = mimeExt ? `${attTypeLabel}.${mimeExt}` : attTypeLabel;
                                const explicitName = [a.name, a.fileName, waFilename, nameFromUrl].find(
                                  (v) => typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "file",
                                ) as string | undefined;
                                const name = explicitName ?? typedName;
                                const downloadName = normalizeInboxDownloadFilename(name);
                                const previewKind = getInboxAttachmentPreviewKind({
                                  type,
                                  mimeType: (a as any).mimeType ?? a.fileType,
                                  name,
                                });
                                // "Add" is always available on inbound attachments: with a
                                // linked student/lead it saves directly; otherwise it opens
                                // the create-and-assign flow (unmatched fallback modal).
                                const canAdd = !out;
                                const _btnCls = "inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors";
                                const actionRow = (
                                  <div className="flex items-center gap-1 flex-wrap mt-0.5">
                                    <a
                                      href={url}
                                      download={downloadName}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={_btnCls}
                                    >
                                      <Download className="w-3 h-3" />
                                      {t("inbox.addAsDoc.download")}
                                    </a>
                                    {canAdd && (
                                      <button
                                        type="button"
                                        title={t("inbox.addAsDoc.button")}
                                        onClick={() => setAddDocTarget({ msgId: m.id, attachIdx: i, attachUrl: url, attachName: name, isImage: previewKind === "image" })}
                                        className={_btnCls}
                                      >
                                        <FilePlus2 className="w-3 h-3" />
                                        {t("inbox.addAsDoc.button")}
                                      </button>
                                    )}
                                  </div>
                                );
                                if (previewKind === "image") return (
                                  <div key={i} className="space-y-1">
                                    <button type="button" onClick={() => setAttachPreview({ url, name, isImage: true, isPdf: false })}>
                                      <img src={url} alt={name} className="max-w-[240px] rounded-lg cursor-pointer hover:opacity-90 transition-opacity" loading="lazy" draggable={false} />
                                    </button>
                                    {actionRow}
                                  </div>
                                );
                                if (previewKind === "video") return (
                                  <div key={i} className="space-y-1">
                                    <video src={url} controls className="max-w-[240px] rounded-lg" />
                                    {actionRow}
                                  </div>
                                );
                                if (previewKind === "audio") return (
                                  <div key={i} className="space-y-1">
                                    <audio src={url} controls className="w-full" />
                                    {actionRow}
                                  </div>
                                );
                                const fileExt = name.includes(".") ? (name.split(".").pop() ?? "").toUpperCase() : "";
                                if (previewKind === "pdf") return (
                                  <div key={i} className="space-y-1">
                                    <PdfAttachmentCard
                                      url={url}
                                      serverThumbUrl={usesInboxMediaProxy ? `/api/inbox/media/${m.id}/${i}/pdf-thumb` : null}
                                      name={name}
                                      fileSize={a.fileSize ?? null}
                                      outbound={out}
                                      onClick={() => setAttachPreview({ url, name, isImage: false, isPdf: true })}
                                    />
                                    {actionRow}
                                  </div>
                                );
                                const fileSizeStr = a.fileSize ? formatBytes(a.fileSize) : null;
                                const metaParts = [fileExt, fileSizeStr].filter(Boolean);
                                return (
                                  <div key={i} className="space-y-1">
                                    <button
                                      type="button"
                                      onClick={() => setAttachPreview({ url, name, isImage: false, isPdf: fileExt === "PDF" })}
                                      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 w-full text-left transition-colors border min-w-[180px] ${
                                        out
                                          ? "border-primary-foreground/25 bg-primary-foreground/10 hover:bg-primary-foreground/20 text-primary-foreground"
                                          : "border-border bg-muted/50 hover:bg-muted text-foreground"
                                      }`}
                                    >
                                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${out ? "bg-primary-foreground/15" : "bg-muted"}`}>
                                        <FileText className="w-5 h-5 opacity-70" />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium truncate">{name}</p>
                                        {metaParts.length > 0 && (
                                          <p className={`text-[10px] mt-0.5 ${out ? "opacity-60" : "text-muted-foreground"}`}>
                                            {metaParts.join(" · ")}
                                          </p>
                                        )}
                                      </div>
                                    </button>
                                    {actionRow}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                        <div className={`flex items-center gap-1 text-[10px] mt-1 ${out ? "opacity-80" : "text-muted-foreground"}`}>
                          <span>{day.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          {out && m.status === "failed" && (
                            <span
                              className="inline-flex items-center gap-0.5 text-red-300 font-medium cursor-help"
                              title={m.failedReason || t("inbox.status.failed")}
                              data-testid={`status-failed-${m.id}`}
                            >
                              <AlertTriangle className="w-2.5 h-2.5" /> {t("inbox.status.failed")}
                            </span>
                          )}
                          {out && (m.status === "pending" || m.status === "queued") && (
                            <span className="inline-flex items-center gap-0.5" title={t("inbox.status.pending")}>
                              <Clock className="w-2.5 h-2.5" />
                            </span>
                          )}
                          {out && (m.status === "sent" || m.status === "delivered" || m.status === "read") && (
                            <span className="inline-flex items-center" title={t(`inbox.status.${m.status}`)}>
                              {m.status === "sent" ? <Check className="w-3 h-3" /> : <CheckCheck className={`w-3 h-3 ${m.status === "read" ? "text-sky-300" : ""}`} />}
                            </span>
                          )}
                          {m.metadata?.simulated && <span className="opacity-80">• {t("inbox.status.simulated")}</span>}
                        </div>
                        {out && m.status === "failed" && (
                          <button
                            type="button"
                            onClick={() => retryMessage(m.id)}
                            disabled={retryingId === m.id}
                            className="mt-1 inline-flex items-center gap-1 rounded-md border border-red-300/60 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-100 hover:bg-red-500/20 disabled:opacity-50"
                            title={m.failedReason || undefined}
                            data-testid={`button-retry-${m.id}`}
                          >
                            {retryingId === m.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
                            {t("inbox.retry.resend")}
                          </button>
                        )}
                      </div>
                      {(m.reactions ?? []).length > 0 && (
                        <div className={`flex flex-wrap gap-1 mt-1 ${out ? "justify-end" : "justify-start"}`}>
                          {(m.reactions ?? []).map((r: any) => (
                            <button
                              key={r.emoji}
                              type="button"
                              onClick={() => toggleReaction(m.id, r.emoji)}
                              className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${r.userIds.includes(user?.id ?? -1) ? "bg-primary/15 border-primary/40 font-semibold" : "bg-muted border-border hover:bg-muted/60"}`}
                            >
                              <span className="leading-none">{r.emoji}</span>
                              {r.count > 1 && <span className="text-[10px] opacity-80 ml-0.5">{r.count}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                      </div>
                    </div>
                    </div>
                  );
                })}
              </div>
              {newBelow > 0 && (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-lg hover:bg-primary/90"
                  data-testid="button-jump-new"
                >
                  <ArrowDown className="w-3 h-3" /> {t("inbox.chat.newMessages", { count: newBelow })}
                </button>
              )}
              </div>

              <ChatNoteTaskTabs
                activeTab={composeTab}
                onTabChange={setComposeTab}
                chatSlot={
                  <div className="flex flex-col gap-2 p-2.5 sm:p-3">
                    {replyToMsg && (
                      <div className="flex items-center gap-2 rounded-lg bg-muted/60 border border-border px-2.5 py-1.5 text-xs">
                        <CornerUpLeft className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <div className="flex-1 min-w-0 flex gap-1">
                          <span className="font-medium text-foreground shrink-0">{replyToMsg.senderName}:</span>
                          <span className="text-muted-foreground truncate">{replyToMsg.snippet.slice(0, 60)}</span>
                        </div>
                        <button type="button" onClick={() => setReplyToMsg(null)} className="shrink-0 rounded hover:text-destructive">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                    {pendingFiles.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {pendingFiles.map((f, i) => (
                          <div key={i} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs max-w-[180px]">
                            <Paperclip className="w-3 h-3 shrink-0" />
                            <span className="truncate flex-1">{f.name}</span>
                            <button type="button" onClick={() => setPendingFiles(prev => prev.filter((_, j) => j !== i))} className="rounded hover:text-destructive shrink-0">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      multiple
                      accept={INBOX_MEDIA_ACCEPT}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length > 0) addPendingFiles(files);
                        e.target.value = "";
                      }}
                    />
                    <div className="flex items-end gap-1.5 sm:gap-2">
                      <div className="relative flex-1 min-w-0">
                        {slashQuery !== null && (
                          <div className="absolute bottom-[calc(100%+0.4rem)] left-0 right-0 z-30 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                            {slashTemplates.length === 0 ? (
                              <p className="px-3 py-2 text-xs text-muted-foreground">
                                No matching active template
                              </p>
                            ) : (
                              slashTemplates.map((template, index) => (
                                <button
                                  key={template.id}
                                  type="button"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => chooseComposerTemplate(template)}
                                  className={cn(
                                    "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors",
                                    index === slashActiveIndex ? "bg-primary/10" : "hover:bg-muted",
                                  )}
                                >
                                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-2">
                                      <span className="truncate text-sm font-medium">
                                        /{template.externalTemplateName || template.name}
                                      </span>
                                      <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[9px]">
                                        {template.externalTemplateName ? "Approved" : "Quick reply"}
                                      </Badge>
                                    </span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                      {template.content}
                                    </span>
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        )}
                        <Textarea
                          value={reply}
                          disabled={contactBlocked}
                          onChange={(e) => setReply(e.target.value)}
                          onPaste={(e) => {
                            const pastedFiles = Array.from(e.clipboardData.items)
                              .filter((item) => item.kind === "file")
                              .map((item) => item.getAsFile())
                              .filter((file): file is File => file !== null);
                            if (pastedFiles.length > 0) {
                              e.preventDefault();
                              addPendingFiles(pastedFiles);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (slashQuery !== null && slashTemplates.length > 0) {
                              if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setSlashActiveIndex((prev) => (prev + 1) % slashTemplates.length);
                                return;
                              }
                              if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setSlashActiveIndex((prev) => (prev - 1 + slashTemplates.length) % slashTemplates.length);
                                return;
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setReply("");
                                return;
                              }
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                chooseComposerTemplate(slashTemplates[slashActiveIndex] || slashTemplates[0]);
                                return;
                              }
                            }
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              if (!metaReplyWindowClosed) sendReply();
                            }
                          }}
                          placeholder={contactBlocked ? t("messagesPage.blockedReplyPlaceholder") : metaReplyWindowClosed ? (conv.channel === "whatsapp" ? t("messagesPage.outside24hUseTemplate") : t("messagesPage.outside24hReplyWindowMeta")) : t("messagesPage.replyPlaceholder")}
                          rows={2}
                          className="w-full rounded-lg text-sm"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          title={t("inbox.compose.attach")}
                          onClick={() => fileInputRef.current?.click()}
                          disabled={contactBlocked || metaReplyWindowClosed || voiceRecorder.isRecording}
                        >
                          <Paperclip className="w-4 h-4" />
                        </Button>
                        {(conv.channel === "whatsapp" || conv.channel === "web_chat") && voiceRecorder.isSupported && (
                          <Button
                            size="icon"
                            variant={voiceRecorder.isRecording ? "destructive" : "ghost"}
                            className="h-8 w-8 shrink-0"
                            onClick={voiceRecorder.isRecording ? voiceRecorder.stop : voiceRecorder.start}
                            disabled={contactBlocked || metaReplyWindowClosed || sending || uploading}
                            title={voiceRecorder.isRecording ? "Stop voice recording" : "Record voice message"}
                          >
                            {voiceRecorder.isRecording
                              ? <Square className="w-3.5 h-3.5 fill-current" />
                              : <Mic className="w-4 h-4" />}
                          </Button>
                        )}
                        {conv.channel === "whatsapp" && (
                          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={openTemplateDialog} title={t("messagesPage.template")}>
                            <FileText className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                      <Button
                        size="sm"
                        onClick={sendReply}
                        disabled={contactBlocked || sending || uploading || voiceRecorder.isRecording || (reply.trim() === "" && pendingFiles.length === 0) || metaReplyWindowClosed}
                        className="h-9 shrink-0 gap-1 px-3"
                      >
                        {(sending || uploading) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                        <span className="hidden sm:inline">{t("inbox.send") || "Send"}</span>
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] text-muted-foreground">
                        {t("inbox.compose.enterToSend")} · Type / for templates · Paste files with Ctrl/Cmd+V
                      </p>
                      {voiceRecorder.isRecording && (
                        <div className="flex items-center gap-2 text-xs font-medium text-red-600">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
                          {String(Math.floor(voiceRecorder.seconds / 60)).padStart(2, "0")}:
                          {String(voiceRecorder.seconds % 60).padStart(2, "0")}
                          <button
                            type="button"
                            onClick={voiceRecorder.cancel}
                            className="underline underline-offset-2"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                }
                noteDraft={noteDraft}
                onNoteDraftChange={setNoteDraft}
                onSubmitNote={handleSubmitNote}
                noteSubmitting={noteMutation.isPending}
                noteEnabled={Boolean(detail.lead || detail.student)}
                taskDraft={taskDraft}
                onTaskDraftChange={setTaskDraft}
                onSubmitTask={handleSubmitTask}
                taskSubmitting={taskMutation.isPending}
                taskEnabled={Boolean(detail.lead || detail.student)}
              />
            </>
          )}
        </div>

        {selectedId !== null && detail && (
          <div
            className="hidden h-full min-h-0 overflow-hidden border-l border-border/50 bg-muted/20 lg:flex lg:shrink-0 lg:flex-col"
            style={{ width: 238 }}
          >
            <LeadDetailSidebar
              detail={detail}
              conversationId={selectedId}
              documentLevel={
                assignDocLevels[selectedId] ??
                (detail as any)?.student?.interestedLevel ??
                (detail as any)?.lead?.interestedLevel ??
                null
              }
              onDocumentLevelChange={rememberAssignDocLevel}
              onOpenMatchDialog={loadSuggestions}
              onSummarize={handleSummarize}
              isSummarizing={summarizeMutation.isPending}
              onUpdated={() => { if (selectedId) fetchDetail(selectedId); }}
              onSendApplicationDocument={sendApplicationDocument}
              applicationDocumentSendingDisabled={metaReplyWindowClosed || sending || uploading}
            />
          </div>
        )}
      </div>

      {detail && (
        <Sheet open={sidebarSheetOpen} onOpenChange={setSidebarSheetOpen}>
          <SheetContent
            side={isRTL ? "left" : "right"}
            className="flex w-[92vw] max-w-md flex-col p-0 lg:hidden"
          >
            <SheetHeader className="px-4 py-3 border-b border-border/50 text-start">
              <SheetTitle className="text-sm">{t("inbox.sidebar.leadInfoTitle")}</SheetTitle>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              <LeadDetailSidebar
                detail={detail}
                conversationId={selectedId}
                documentLevel={
                  (selectedId ? assignDocLevels[selectedId] : null) ??
                  (detail as any)?.student?.interestedLevel ??
                  (detail as any)?.lead?.interestedLevel ??
                  null
                }
                onDocumentLevelChange={rememberAssignDocLevel}
                onOpenMatchDialog={() => { setSidebarSheetOpen(false); loadSuggestions(); }}
                onSummarize={handleSummarize}
                isSummarizing={summarizeMutation.isPending}
                onUpdated={() => { if (selectedId) fetchDetail(selectedId); }}
                onSendApplicationDocument={sendApplicationDocument}
                applicationDocumentSendingDisabled={metaReplyWindowClosed || sending || uploading}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      <Dialog open={forwardMsgId !== null} onOpenChange={(o) => { if (!o && !forwardSending) setForwardMsgId(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("inbox.forward.title")}</DialogTitle>
          </DialogHeader>
          <Input
            value={forwardSearch}
            onChange={(e) => setForwardSearch(e.target.value)}
            placeholder={t("inbox.forward.searchPlaceholder")}
            className="mb-2"
          />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {convs
              .filter((c) => c.id !== selectedId)
              .filter((c) => {
                const q = forwardSearch.trim().toLowerCase();
                if (!q) return true;
                const name = (c.externalContact?.displayName || c.title || "").toLowerCase();
                return name.includes(q);
              })
              .slice(0, 50)
              .map((c) => {
                const name = c.externalContact?.displayName || c.title || "(unknown)";
                const checked = forwardTargets.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setForwardTargets((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else if (next.size < 10) next.add(c.id);
                        return next;
                      });
                    }}
                    className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      checked ? "bg-primary/10 border border-primary/40" : "hover:bg-muted border border-transparent"
                    }`}
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${checked ? "bg-primary border-primary" : "border-border"}`}>
                      {checked && <Check className="w-3 h-3 text-primary-foreground" />}
                    </span>
                    <span className="truncate flex-1">{name}</span>
                    <Badge variant="outline" className="text-[9px] shrink-0">{c.channel}</Badge>
                  </button>
                );
              })}
            {convs.filter((c) => c.id !== selectedId).length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">{t("inbox.forward.noConversations")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForwardMsgId(null)} disabled={forwardSending}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={async () => {
                if (!forwardMsgId || forwardTargets.size === 0) return;
                setForwardSending(true);
                try {
                  const r: any = await customFetch(`/api/inbox/messages/${forwardMsgId}/forward`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ conversationIds: Array.from(forwardTargets) }),
                  });
                  const results: Array<{ conversationId: number; ok: boolean; error?: string }> = r?.results ?? [];
                  const okCount = results.filter((x) => x.ok).length;
                  const failCount = results.length - okCount;
                  if (failCount === 0) {
                    toast({ title: t("inbox.forward.sent", { count: String(okCount) }) });
                  } else {
                    toast({
                      title: t("inbox.forward.partial", { ok: String(okCount), failed: String(failCount) }),
                      variant: okCount > 0 ? "default" : "destructive",
                    });
                  }
                  setForwardMsgId(null);
                } catch {
                  toast({ title: t("inbox.forward.error"), variant: "destructive" });
                } finally {
                  setForwardSending(false);
                }
              }}
              disabled={forwardSending || forwardTargets.size === 0}
            >
              {forwardSending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("inbox.forward.send", { count: String(forwardTargets.size) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={matchOpen} onOpenChange={setMatchOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Link2 className="w-4 h-4" /> {t("messagesPage.matchContact")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {matchSuggestions?.outcome === "strong" && (
              <p className="text-xs text-emerald-700 bg-emerald-50 p-2 rounded">{t("messagesPage.strongMatchConfirmLink")}</p>
            )}
            {matchSuggestions?.outcome === "ambiguous" && (
              <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded">{t("messagesPage.multipleCandidatesPickOne")}</p>
            )}
            {matchSuggestions?.outcome === "none" && (
              <p className="text-xs text-muted-foreground bg-secondary p-2 rounded">{t("messagesPage.noMatchesCreateLead")}</p>
            )}
            {(matchSuggestions?.candidates || []).map((c: any, i: number) => (
              <div key={`${c.type}-${c.id}-${i}`} className="flex items-center justify-between p-2 border rounded-lg">
                <div>
                  <p className="text-sm font-medium">{c.displayName || `${c.firstName || ""} ${c.lastName || ""}`.trim() || "(unnamed)"} <Badge variant="outline" className="text-[9px] ml-1">{c.type}</Badge></p>
                  <p className="text-[11px] text-muted-foreground">{c.email || c.phone || ""}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => applyMatch(c.type, c.id)}>{t("messagesPage.link")}</Button>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatchOpen(false)}>{t("messagesPage.cancel")}</Button>
            <Button variant="outline" onClick={openCreateLeadDialog} className="gap-1"><Plus className="w-3 h-3" /> {t("messagesPage.newLead")}</Button>
            <Button onClick={openAddStudentDialog} className="gap-1"><UserPlus className="w-3 h-3" /> {t("messagesPage.addStudentBtn")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={studentSearchOpen} onOpenChange={(open) => { if (!studentLinking) setStudentSearchOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserPlus className="w-4 h-4" /> {t("messagesPage.matchStudentSearchTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">{t("messagesPage.matchStudentSearchHint")}</p>
            <Input
              value={studentSearchQuery}
              onChange={(e) => setStudentSearchQuery(e.target.value)}
              placeholder={t("messagesPage.matchStudentSearchPlaceholder")}
              className="h-9"
              autoFocus
            />
            {studentSearchLoading && (
              <div className="flex items-center justify-center py-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
            )}
            {!studentSearchLoading && studentSearchQuery.trim().length >= 2 && studentSearchResults.length === 0 && (
              <p className="text-xs text-muted-foreground bg-secondary p-2 rounded">{t("messagesPage.matchStudentNoResults")}</p>
            )}
            {!studentSearchLoading && studentSearchResults.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {studentSearchResults.map((s: any) => (
                  <div key={s.id} className="flex items-center justify-between p-2 border rounded-lg gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{`${s.firstName || ""} ${s.lastName || ""}`.trim() || "(unnamed)"}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {[s.phone, s.email, s.passportNumber].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" disabled={studentLinking} onClick={() => linkExistingStudent(s.id)}>
                      {t("messagesPage.link")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStudentSearchOpen(false)} disabled={studentLinking}>{t("messagesPage.cancel")}</Button>
            <Button onClick={openCreateStudentModal} disabled={studentLinking} className="gap-1"><Plus className="w-3 h-3" /> {t("messagesPage.matchStudentCreateNew")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createLeadOpen} onOpenChange={(open) => { if (!createLeadSubmitting) setCreateLeadOpen(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Plus className="w-4 h-4" /> {t("messagesPage.createLeadFromConversation")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {createLeadDuplicate && (
              <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 space-y-2">
                <p className="text-xs font-semibold text-amber-900">{t("messagesPage.duplicateLeadFound")}</p>
                <p className="text-xs text-amber-800">{t("messagesPage.duplicateLeadMessage")}</p>
                <div className="flex items-center justify-between text-xs border border-amber-200 rounded p-2 bg-white">
                  <span className="font-medium">{createLeadDuplicate.firstName} {createLeadDuplicate.lastName}</span>
                  <span className="text-muted-foreground">{createLeadDuplicate.email || createLeadDuplicate.phone || ""}</span>
                </div>
                <Button size="sm" variant="outline" className="w-full gap-1 h-8 text-xs" onClick={linkToExistingLead}>
                  <Link2 className="w-3 h-3" /> {t("messagesPage.linkToExistingLead")}
                </Button>
              </div>
            )}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="text-xs">{t("messagesPage.fullName")} *</Label>
                {createLeadAiFields.has("fullName") && (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 gap-0.5 bg-purple-100 text-purple-700">
                    <span>✦</span> {t("messagesPage.aiSuggestion")}
                  </Badge>
                )}
              </div>
              {createLeadLoading ? (
                <div className="h-9 rounded-md bg-muted animate-pulse" />
              ) : (
                <Input
                  value={createLeadForm.fullName}
                  onChange={(e) => setCreateLeadForm((f) => ({ ...f, fullName: e.target.value }))}
                  placeholder={t("messagesPage.fullName")}
                  className="h-9"
                />
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="text-xs">{t("messagesPage.emailAddress")}</Label>
                {createLeadAiFields.has("email") && (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 gap-0.5 bg-purple-100 text-purple-700">
                    <span>✦</span> {t("messagesPage.aiSuggestion")}
                  </Badge>
                )}
              </div>
              {createLeadLoading ? (
                <div className="h-9 rounded-md bg-muted animate-pulse" />
              ) : (
                <Input
                  type="email"
                  value={createLeadForm.email}
                  onChange={(e) => setCreateLeadForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder={t("messagesPage.emailAddress")}
                  className="h-9"
                />
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("messagesPage.phoneNumber")}</Label>
              {createLeadLoading ? (
                <div className="h-9 rounded-md bg-muted animate-pulse" />
              ) : (
                <Input
                  value={createLeadForm.phone}
                  onChange={(e) => setCreateLeadForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder={t("messagesPage.phoneNumber")}
                  className="h-9"
                />
              )}
            </div>
            {createLeadLoading && (
              <p className="text-[11px] text-muted-foreground text-center animate-pulse">{t("messagesPage.loadingAiSuggestion")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateLeadOpen(false)} disabled={createLeadSubmitting}>{t("messagesPage.cancel")}</Button>
            <Button onClick={submitCreateLead} disabled={createLeadLoading || createLeadSubmitting || !createLeadForm.fullName.trim()} className="gap-1">
              {createLeadSubmitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              {t("messagesPage.createLead")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attachment preview modal */}
      <Dialog open={!!attachPreview} onOpenChange={(o) => { if (!o) setAttachPreview(null); }}>
        <DialogContent className="max-w-3xl w-full p-2">
          <DialogHeader className="px-2 pt-1 pb-2">
            <DialogTitle className="text-sm truncate">{attachPreview?.name}</DialogTitle>
          </DialogHeader>
          {attachPreview?.isImage ? (
            <img
              src={attachPreview.url}
              alt={attachPreview.name}
              className="max-h-[75vh] w-full object-contain rounded"
            />
          ) : (
            <iframe
              src={attachPreview?.url}
              title={attachPreview?.name}
              className="w-full rounded"
              style={{ height: "75vh" }}
            />
          )}
        </DialogContent>
      </Dialog>

      <AddStudentModal
        open={addStudentOpen}
        onClose={() => setAddStudentOpen(false)}
        onSuccess={() => {}}
        prefill={addStudentPrefill}
        onCreated={(studentId) => applyMatch("student", studentId)}
      />

      {addDocTarget && detail?.student && selectedId && (
        <AssignDocumentFromMessageModal
          convId={selectedId}
          target={addDocTarget}
          ownerType="student"
          owner={detail.student}
          rememberedLevel={assignDocLevels[selectedId] ?? null}
          onLevelChange={rememberAssignDocLevel}
          onClose={() => setAddDocTarget(null)}
          onSaved={() => { if (selectedId) fetchDetail(selectedId); }}
        />
      )}

      {addDocTarget && detail?.lead && !detail?.student && selectedId && (
        <AssignDocumentFromMessageModal
          convId={selectedId}
          target={addDocTarget}
          ownerType="lead"
          owner={{ id: detail.lead.id, interestedLevel: detail.lead.interestedLevel ?? null }}
          rememberedLevel={assignDocLevels[selectedId] ?? null}
          onLevelChange={rememberAssignDocLevel}
          onClose={() => setAddDocTarget(null)}
          onSaved={() => { if (selectedId) fetchDetail(selectedId); }}
        />
      )}

      {addDocTarget && detail && selectedId && !detail.lead && !detail.student && (
        <AssignDocumentFromMessageModal
          convId={selectedId}
          target={addDocTarget}
          ownerType="unmatched"
          owner={{ id: 0, interestedLevel: null }}
          rememberedLevel={assignDocLevels[selectedId] ?? null}
          onLevelChange={rememberAssignDocLevel}
          onClose={() => setAddDocTarget(null)}
          onSaved={() => {
            setAddDocTarget(null);
            fetchInbox();
            if (selectedId) fetchDetail(selectedId);
          }}
        />
      )}

      <WhatsAppTemplatePicker
        open={tplOpen}
        conversationId={selectedId}
        initialTemplateId={tplInitialId}
        onClose={() => {
          setTplOpen(false);
          setTplInitialId(null);
        }}
        onSend={sendTemplate}
        sending={tplSending}
      />

      {/* ── "Yeni sohbet" person picker ─────────────────────────── */}
      <Dialog open={newWaConvOpen} onOpenChange={(open) => {
        setNewWaConvOpen(open);
        // NOTE: do NOT reset newWaConvSelected here — Radix fires onOpenChange(false)
        // when the controlled `open` prop changes, which would null out the selection
        // before handleNewWaConvSend can read it. Reset happens in the template
        // picker's onClose instead.
        if (!open) { setNewWaConvSearch(""); setNewWaConvResults([]); }
      }}>
        <DialogContent className="sm:max-w-md overflow-x-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4" />
              {t("messagesPage.newConvTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1 overflow-x-hidden">
            <div className="space-y-1.5">
              <Label>{t("messagesPage.senderLine")}</Label>
              <Select value={newWaConvAccountId} onValueChange={setNewWaConvAccountId}>
                <SelectTrigger><SelectValue placeholder={t("messagesPage.selectSenderLine")} /></SelectTrigger>
                <SelectContent>
                  {whatsAppAccounts.map((account) => {
                    const brand = whatsappLineBrand("whatsapp", account);
                    return (
                      <SelectItem key={account.id} value={String(account.id)}>
                        <span className="inline-flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: brand?.color }} />
                          {brand?.label || account.displayName}{account.isDefault ? ` · ${t("messagesPage.systemDefault")}` : ""}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("messagesPage.senderLineHelp")}</p>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-8 h-9 rounded-lg"
                autoFocus
                placeholder={t("messagesPage.newConvSearchPlaceholder")}
                value={newWaConvSearch}
                onChange={(e) => setNewWaConvSearch(e.target.value)}
              />
            </div>
            {newWaConvLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            ) : newWaConvResults.length === 0 && newWaConvSearch.trim() ? (
              <p className="text-sm text-muted-foreground text-center py-4">{t("messagesPage.noResults")}</p>
            ) : (
              <div className="max-h-72 overflow-y-auto overflow-x-hidden space-y-1">
                {newWaConvResults.map(r => (
                  <button
                    key={`${r.entityType}-${r.entityId}`}
                    type="button"
                    onClick={() => {
                      setNewWaConvSelected(r);
                      setNewWaConvOpen(false);
                      setNewWaConvTplOpen(true);
                    }}
                    className="w-full min-w-0 flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 hover:bg-muted/50 transition-colors overflow-hidden"
                  >
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium truncate" title={r.name}>{r.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{r.phone}</p>
                    </div>
                    <Badge variant="outline" className="text-[10px] shrink-0 ml-auto">
                      {r.entityType === "student" ? t("common.student") : t("common.lead")}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewWaConvOpen(false)}>{t("messagesPage.cancel")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── "Yeni sohbet" template picker (after person selected) ── */}
      <WhatsAppTemplatePicker
        open={newWaConvTplOpen}
        entityType={newWaConvSelected?.entityType === "lead" || newWaConvSelected?.entityType === "student"
          ? newWaConvSelected.entityType
          : undefined}
        entityId={newWaConvSelected?.entityId}
        onClose={() => { setNewWaConvTplOpen(false); setNewWaConvSelected(null); }}
        onSend={handleNewWaConvSend}
        sending={newWaConvSending}
      />

      <Dialog open={bulkConfirm !== null} onOpenChange={(open) => { if (!open && !bulkBusy) setBulkConfirm(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {bulkConfirm === "delete" || bulkConfirm === "delete-final" ? (
                <Trash2 className="w-4 h-4 text-destructive" />
              ) : bulkConfirm === "unarchive" ? (
                <ArchiveRestore className="w-4 h-4" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {bulkConfirm === "delete-final"
                ? t("inbox.bulk.deleteConfirmTitle2")
                : bulkConfirm === "delete"
                  ? t("inbox.bulk.deleteConfirmTitle")
                  : bulkConfirm === "unarchive"
                    ? t("inbox.bulk.restoreConfirmTitle")
                    : t("inbox.bulk.archiveConfirmTitle")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {bulkConfirm === "delete-final"
              ? t("inbox.bulk.deleteConfirmBody2", { count: selectedIds.size })
              : bulkConfirm === "delete"
                ? t("inbox.bulk.deleteConfirmBody", { count: selectedIds.size })
                : bulkConfirm === "unarchive"
                  ? t("inbox.bulk.restoreConfirmBody", { count: selectedIds.size })
                  : t("inbox.bulk.archiveConfirmBody", { count: selectedIds.size })}
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={bulkBusy} onClick={() => setBulkConfirm(null)}>
              {t("messagesPage.cancel")}
            </Button>
            <Button
              disabled={bulkBusy}
              variant={bulkConfirm === "delete" || bulkConfirm === "delete-final" ? "destructive" : "default"}
              onClick={() => {
                if (bulkConfirm === "delete") setBulkConfirm("delete-final");
                else if (bulkConfirm === "delete-final") void runBulk("delete");
                else void runBulk(bulkConfirm === "unarchive" ? "unarchive" : "archive");
              }}
              className="gap-1"
              data-testid="button-bulk-confirm"
            >
              {bulkBusy && <Loader2 className="w-3 h-3 animate-spin" />}
              {bulkConfirm === "delete-final"
                ? t("inbox.bulk.deleteForever")
                : bulkConfirm === "delete"
                  ? t("inbox.bulk.deleteContinue")
                  : bulkConfirm === "unarchive"
                    ? t("inbox.bulk.restore")
                    : t("inbox.bulk.archive")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
    </>
  );
}

function ConversationList({
  conversations, selectedId, onSelect, onNewConversation, search, setSearch,
  sortOrder, onToggleSort, selectMode, onToggleSelectMode, selectedIds,
  onToggleSelected, onSelectAll, onBulkArchive, onBulkDelete, bulkBusy,
  audienceFilter, setAudienceFilter, readFilter, setReadFilter, archivedFilter, setArchivedFilter,
}: {
  conversations: Conversation[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNewConversation: () => void;
  search: string;
  setSearch: (s: string) => void;
  sortOrder: "desc" | "asc";
  onToggleSort: () => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  selectedIds: Set<number>;
  onToggleSelected: (id: number) => void;
  onSelectAll: () => void;
  onBulkArchive: () => void;
  onBulkDelete: () => void;
  bulkBusy: boolean;
  audienceFilter: "all" | "agent" | "student";
  setAudienceFilter: (value: "all" | "agent" | "student") => void;
  readFilter: "all" | "read" | "unread";
  setReadFilter: (value: "all" | "read" | "unread") => void;
  archivedFilter: boolean;
  setArchivedFilter: (value: boolean) => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const canDeleteConversations = ["super_admin", "admin"].includes(user?.role || "");

  return (
    <>
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border/50 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-foreground">{t("messagesPage.messages")}</h2>
          <Button size="sm" variant="outline" onClick={onNewConversation} className="h-8 gap-1.5 rounded-lg">
            <Plus className="w-3.5 h-3.5" /> New
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("messagesPage.searchConversations")} className="pl-9 h-8 text-sm rounded-lg" />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <Select value={audienceFilter} onValueChange={value => setAudienceFilter(value as "all" | "agent" | "student")}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All people</SelectItem>
              <SelectItem value="agent">Agents</SelectItem>
              <SelectItem value="student">Students</SelectItem>
            </SelectContent>
          </Select>
          <Select value={readFilter} onValueChange={value => setReadFilter(value as "all" | "read" | "unread")}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="unread">Unread</SelectItem>
              <SelectItem value="read">Read</SelectItem>
            </SelectContent>
          </Select>
          <Select value={archivedFilter ? "archived" : "active"} onValueChange={value => setArchivedFilter(value === "archived")}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1 text-muted-foreground"
            onClick={onToggleSort}
            title={t("inbox.sort.toggle")}
            data-testid="button-internal-sort"
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            {sortOrder === "desc" ? t("inbox.sort.newestFirst") : t("inbox.sort.oldestFirst")}
          </Button>
          <div className="flex-1" />
          <Button
            variant={selectMode ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs gap-1 text-muted-foreground"
            onClick={onToggleSelectMode}
            data-testid="button-internal-select-mode"
          >
            <ListChecks className="w-3.5 h-3.5" />
            {selectMode ? t("inbox.bulk.cancel") : t("inbox.bulk.select")}
          </Button>
        </div>
        {selectMode && (
          <div className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 py-1.5">
            <button
              type="button"
              onClick={onSelectAll}
              className="text-xs font-medium text-primary hover:underline shrink-0"
            >
              {selectedIds.size === conversations.length && conversations.length > 0
                ? t("inbox.bulk.clearAll")
                : t("inbox.bulk.selectAll")}
            </button>
            <span className="text-xs text-muted-foreground flex-1 truncate">
              {t("inbox.bulk.selectedCount", { count: selectedIds.size })}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px] gap-1"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={onBulkArchive}
              data-testid="button-internal-bulk-archive"
            >
              {archivedFilter ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
              {archivedFilter ? t("inbox.bulk.restore") : t("inbox.bulk.archive")}
            </Button>
            {canDeleteConversations && (
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-[11px] gap-1"
                disabled={selectedIds.size === 0 || bulkBusy}
                onClick={onBulkDelete}
                data-testid="button-internal-bulk-delete"
              >
                <Trash2 className="w-3 h-3" /> {t("inbox.bulk.delete")}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <MessageCircle className="w-10 h-10 mb-2 opacity-30" />
            <p className="text-sm">{t("messagesPage.noConversationsYet")}</p>
          </div>
        ) : (
          conversations.map(conv => {
            const others = conv.participants.filter(p => p.userId !== user?.id);
            const displayName = conv.title || others.map(p => `${p.firstName} ${p.lastName}`).join(", ") || "Conversation";
            const initials = others[0] ? `${others[0].firstName?.[0] || ""}${others[0].lastName?.[0] || ""}` : "?";
            const avatarUrl = others[0]?.avatarUrl || null;
            const isSelected = conv.id === selectedId;
            const isChecked = selectedIds.has(conv.id);
            const unreadCount = conv.unreadCount ?? 0;
            const isUnread = unreadCount > 0;

            return (
              <div
                key={conv.id}
                style={{ contentVisibility: "auto", containIntrinsicSize: "68px" }}
                data-testid="internal-conversation-item"
                data-unread={isUnread ? "true" : "false"}
                aria-label={isUnread ? `${displayName}, ${unreadCount} ${t("inbox.tabs.unread")}` : displayName}
                onClick={() => (selectMode ? onToggleSelected(conv.id) : onSelect(conv.id))}
                className={`relative flex items-center gap-3 px-4 py-3 cursor-pointer border-b transition-colors ${
                  isSelected && !selectMode
                    ? "bg-primary/5 border-b-primary/20 border-l-4 border-l-primary"
                    : isChecked
                      ? "bg-primary/10 border-b-primary/20"
                      : isUnread
                        ? "bg-emerald-50/90 border-b-emerald-100 border-l-4 border-l-emerald-500 hover:bg-emerald-100/80 dark:bg-emerald-950/25 dark:border-b-emerald-900/60 dark:hover:bg-emerald-950/40"
                        : "border-border/30 border-l-4 border-l-transparent hover:bg-secondary/50"
                }`}
              >
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggleSelected(conv.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="w-4 h-4 shrink-0 accent-primary"
                    data-testid={`checkbox-internal-conv-${conv.id}`}
                  />
                )}
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={displayName}
                    className={`w-10 h-10 rounded-full object-cover shrink-0 ${isUnread ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""}`}
                  />
                ) : (
                  <div className={`w-10 h-10 rounded-full bg-gradient-to-tr from-primary/30 to-accent/30 flex items-center justify-center font-bold text-xs text-foreground shrink-0 ${isUnread ? "ring-2 ring-emerald-500 ring-offset-2 ring-offset-background" : ""}`}>
                    {initials}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className={`${isUnread ? "font-extrabold" : "font-medium"} text-sm text-foreground truncate`}>{displayName}</p>
                      {isUnread && (
                        <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wide text-white">
                          {t("inbox.tabs.unread")}
                        </span>
                      )}
                    </div>
                    {isUnread && (
                      <Badge className="bg-emerald-600 text-white text-[10px] font-extrabold h-[22px] min-w-[22px] px-1.5 ml-2 shadow-sm ring-2 ring-emerald-200 dark:ring-emerald-900">
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </Badge>
                    )}
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${isUnread ? "text-foreground font-bold" : "text-muted-foreground"}`}>{conv.lastMessagePreview || "No messages yet"}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
    </>
  );
}

function MessageThread({
  conversationId, onBack
}: {
  conversationId: number;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useI18n();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState("");
  const channel = "internal" as const;
  const [sending, setSending] = useState(false);
  const [participants, setParticipants] = useState<Array<{ userId: number; firstName: string; lastName: string; avatarUrl: string | null; role: string; lastReadAt?: string | null }>>([]);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(true);
  const [togglingReceipts, setTogglingReceipts] = useState(false);
  const [botEnabled, setBotEnabled] = useState(false);
  const [needsHuman, setNeedsHuman] = useState(false);
  const [togglingBot, setTogglingBot] = useState(false);
  const [summary, setSummary] = useState<ConversationAiSummary | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasAtBottomRef = useRef(true);
  const justOpenedRef = useRef(true);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await customFetch(`/api/conversations/${conversationId}/messages?limit=100`);
      setMessages((res as any)?.data || res || []);
      if (typeof (res as any)?.readReceiptsEnabled === "boolean") {
        setReadReceiptsEnabled((res as any).readReceiptsEnabled);
      }
      if (typeof (res as any)?.botEnabled === "boolean") {
        setBotEnabled((res as any).botEnabled);
      }
      if (typeof (res as any)?.needsHuman === "boolean") {
        setNeedsHuman((res as any).needsHuman);
      }
    } catch {}
  }, [conversationId]);

  useEffect(() => {
    setLoading(true);
    justOpenedRef.current = true;
    wasAtBottomRef.current = true;
    // Reset the AI summary so a stale summary from the previous conversation
    // doesn't leak across threads. The internal thread is self-contained and
    // has no detail endpoint that returns aiSummary, so we seed it on demand
    // from the summarize response below.
    setSummary(null);
    setReadReceiptsEnabled(true);
    setBotEnabled(false);
    setNeedsHuman(false);
    Promise.all([
      fetchMessages(),
      customFetch(`/api/conversations/${conversationId}/participants`).then((r: any) => setParticipants(r?.data || r || [])),
    ]).finally(() => setLoading(false));

    pollRef.current = setInterval(fetchMessages, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [conversationId, fetchMessages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (justOpenedRef.current || wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      wasAtBottomRef.current = true;
      justOpenedRef.current = false;
    }
  }, [messages]);

  // AI summary for internal threads. The summarize endpoint is type/link-
  // independent (it only needs messages), so we reuse the same hook + error
  // mapping as the Inbox tab. The result is stored locally and seeded from the
  // response since the internal thread has no detail endpoint returning it.
  const summarizeMutation = useSummarizeInboxConversation({
    mutation: {
      onSuccess: (resp) => {
        setSummary(resp.data);
        if (!resp.fromCache) toast({ title: t("inbox.aiSummary.generated") });
      },
      onError: (err: any) => {
        const status: number | undefined = err?.status;
        const errBody = err?.data ?? err?.body;
        const errCode = String(errBody?.error ?? "");
        let msg = t("inbox.aiSummary.errorGeneric");
        if (status === 429) msg = t("inbox.aiSummary.errorRateLimit");
        else if (status === 502) msg = t("inbox.aiSummary.errorService");
        else if (status === 400 && /no.*messages|messages.*summarize/i.test(errCode)) {
          msg = t("inbox.aiSummary.errorNoMessages");
        } else if (status === 400) {
          // Internal conversations are link-independent, so a generic 400 here
          // is effectively "nothing to summarize" rather than a missing link.
          msg = t("inbox.aiSummary.errorNoMessages");
        }
        toast({ variant: "destructive", title: msg });
      },
    },
  });

  const handleSummarize = () => {
    summarizeMutation.mutate({ id: conversationId });
  };

  const uploadFile = async (file: File): Promise<MessageAttachment | null> => {
    try {
      setUploading(true);
      const urlRes = await customFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      const { uploadURL, objectPath } = urlRes as any;
      const uploadResp = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!uploadResp.ok) throw new Error(t("messagesPage.fileUploadFailed"));
      return {
        fileName: file.name,
        fileUrl: `/api/storage${objectPath}`,
        fileType: file.type,
        fileSize: file.size,
      };
    } catch (err: any) {
      toast({ title: t("messagesPage.uploadFailed"), description: err.message, variant: "destructive" });
      return null;
    } finally {
      setUploading(false);
    }
  };

  const sendMessage = async () => {
    if ((!newMessage.trim() && !pendingFile) || sending) return;
    setSending(true);
    try {
      let attachment: MessageAttachment | undefined;
      if (pendingFile) {
        const uploaded = await uploadFile(pendingFile);
        if (!uploaded) { setSending(false); return; }
        attachment = uploaded;
      }
      const metadata = attachment ? { attachment } : undefined;
      await customFetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newMessage.trim() || "", channel, metadata }),
      });
      setNewMessage("");
      setPendingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      fetchMessages();
    } catch (err: any) {
      toast({ title: t("messagesPage.failedToSend"), description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: t("messagesPage.fileTooLarge"), description: t("messagesPage.maxFileSize25mb"), variant: "destructive" });
      return;
    }
    setPendingFile(file);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isImage = (type: string) => type.startsWith("image/");

  const handleDownload = async (fileUrl: string, fileName: string) => {
    try {
      const downloadUrl = new URL(fileUrl, window.location.origin);
      downloadUrl.searchParams.set("download", fileName);
      const res = await fetch(downloadUrl.toString(), { credentials: "include" });
      if (!res.ok) throw new Error(t("messagesPage.downloadFailed"));
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      toast({ title: t("messagesPage.downloadFailed"), description: t("messagesPage.couldNotDownloadFile"), variant: "destructive" });
    }
  };

  const others = participants.filter(p => p.userId !== user?.id);
  const threadTitle = others.map(p => `${p.firstName} ${p.lastName}`).join(", ") || "Conversation";

  async function toggleReadReceipts() {
    if (togglingReceipts) return;
    setTogglingReceipts(true);
    try {
      const res: any = await customFetch(`/api/conversations/${conversationId}/read-receipts`, { method: "PATCH" });
      if (typeof res?.readReceiptsEnabled === "boolean") setReadReceiptsEnabled(res.readReceiptsEnabled);
    } catch {
      toast({ title: t("messagesPage.readReceiptsToggleFailed"), variant: "destructive" });
    } finally {
      setTogglingReceipts(false);
    }
  }

  async function toggleInternalBot(enabled: boolean) {
    if (togglingBot) return;
    setTogglingBot(true);
    try {
      const response: any = await customFetch(`/api/inbox/conversations/${conversationId}/bot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setBotEnabled(Boolean(response?.data?.botEnabled));
      setNeedsHuman(Boolean(response?.data?.needsHuman));
      toast({
        title: enabled ? t("messagesPage.aiOn") : t("messagesPage.aiOff"),
      });
    } catch (error: any) {
      toast({
        title: error?.body?.error || error?.data?.error || t("messagesPage.aiToggleFailed"),
        variant: "destructive",
      });
    } finally {
      setTogglingBot(false);
    }
  }

  const ChannelIcon = channelIcon[channel] || MessageSquare;

  return (
    <>
    <div className="flex flex-col h-full min-h-0">
      <div className="p-4 border-b border-border/50 flex items-center gap-3 shrink-0">
        <Button size="icon" variant="ghost" className="lg:hidden w-8 h-8" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate">{threadTitle}</p>
          <p className="text-xs text-muted-foreground">{participants.length} participants</p>
        </div>
        {needsHuman && (
          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800 gap-1">
            <AlertTriangle className="w-3 h-3" />
            {t("messagesPage.needsHuman")}
          </Badge>
        )}
        <Button
          size="sm"
          variant={botEnabled ? "default" : "outline"}
          onClick={() => toggleInternalBot(!botEnabled)}
          disabled={togglingBot}
          className="h-8 gap-1.5"
          title={botEnabled ? t("messagesPage.aiOnHint") : t("messagesPage.aiOffHint")}
          data-testid="button-toggle-internal-bot"
        >
          {togglingBot ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
          {botEnabled ? t("messagesPage.aiOn") : t("messagesPage.aiOff")}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleReadReceipts}
              disabled={togglingReceipts}
              className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground"
              aria-label={readReceiptsEnabled ? t("messagesPage.readReceiptsOn") : t("messagesPage.readReceiptsOff")}
            >
              {readReceiptsEnabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            {readReceiptsEnabled ? t("messagesPage.readReceiptsOn") : t("messagesPage.readReceiptsOff")}
          </TooltipContent>
        </Tooltip>
        <Badge variant="secondary" className={`text-xs ${channelColor[channel] || ""}`}>
          <ChannelIcon className="w-3 h-3 mr-1" />
          {channel}
        </Badge>
      </div>

      <div className="px-4 pt-3 shrink-0">
        <AiSummaryCard
          summary={summary}
          hasLink
          hasMessages={messages.length > 0}
          isSummarizing={summarizeMutation.isPending}
          onSummarize={handleSummarize}
          onDismiss={() => setSummary(null)}
        />
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <MessageSquare className="w-10 h-10 mb-2 opacity-30" />
            <p className="text-sm">{t("messagesPage.noMessagesYet")}</p>
          </div>
        ) : (
          messages.map(msg => {
            const isBot = msg.metadata?.botSent === true;
            const isMe = !isBot && msg.senderId === user?.id;
            const initials = isBot
              ? "AI"
              : `${msg.senderFirstName?.[0] || ""}${msg.senderLastName?.[0] || ""}`;
            const att = (msg.metadata as any)?.attachment as MessageAttachment | undefined;
            const hasTextContent = msg.content && !msg.content.startsWith("\u{1F4CE}");
            return (
              <div key={msg.id} className={`flex gap-2.5 ${isMe ? "flex-row-reverse" : ""}`}>
                {!isMe && (
                  msg.senderAvatarUrl ? (
                    <img src={msg.senderAvatarUrl} alt={initials} className="w-8 h-8 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      isBot
                        ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                        : "bg-gradient-to-tr from-primary/30 to-accent/30"
                    }`}>
                      {isBot ? <Bot className="w-4 h-4" /> : initials}
                    </div>
                  )
                )}
                <div className={`max-w-[70%] ${isMe ? "items-end" : ""}`}>
                  {!isMe && (
                    <p className="text-xs text-muted-foreground mb-1">
                      {isBot ? "AI Assistant" : `${msg.senderFirstName ?? ""} ${msg.senderLastName ?? ""}`.trim()}
                    </p>
                  )}
                  <div className={`rounded-2xl px-4 py-2.5 ${
                    isMe
                      ? "bg-primary text-white rounded-tr-sm"
                      : isBot
                        ? "bg-primary/10 border border-primary/20 rounded-tl-sm"
                        : "bg-secondary rounded-tl-sm"
                  }`}>
                    {att && isImage(att.fileType!) && (
                      <div className="mb-1 group/att relative">
                        <img src={att.fileUrl!} alt={att.fileName!} className="max-w-full max-h-48 rounded-lg object-cover" />
                        <button
                          onClick={() => handleDownload(att.fileUrl!, att.fileName!)}
                          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity hover:bg-black/70"
                          title={t("messagesPage.download")}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                    {att && !isImage(att.fileType!) && (
                      String(att.fileType ?? "").includes("pdf") || String(att.fileName ?? "").toLowerCase().endsWith(".pdf") ? (
                        <div className="mb-1">
                          <PdfAttachmentCard
                            url={att.fileUrl!}
                            name={att.fileName!}
                            fileSize={att.fileSize ?? null}
                            outbound={isMe}
                            onClick={() => handleDownload(att.fileUrl!, att.fileName!)}
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => handleDownload(att.fileUrl!, att.fileName!)}
                          className={`flex items-center gap-2 p-2 rounded-lg mb-1 w-full text-left ${isMe ? "bg-white/10 hover:bg-white/20" : "bg-background hover:bg-background/80"} transition-colors`}
                        >
                          <FileText className="w-5 h-5 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium truncate">{att.fileName!}</p>
                            <p className={`text-[10px] ${isMe ? "text-white/60" : "text-muted-foreground"}`}>{formatFileSize(att.fileSize!)}</p>
                          </div>
                          <Download className={`w-4 h-4 shrink-0 ${isMe ? "text-white/60" : "text-muted-foreground"}`} />
                        </button>
                      )
                    )}
                    {hasTextContent && <p className="text-sm whitespace-pre-wrap">{msg.content}</p>}
                  </div>
                  <span className={`flex items-center gap-1 text-[10px] text-muted-foreground mt-1 ${isMe ? "justify-end" : ""}`}>
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {msg.channel !== "internal" && (
                      <span className="ml-1 opacity-70">via {msg.channel}</span>
                    )}
                    {isMe && readReceiptsEnabled && (() => {
                      const isSeen = others.some(p => p.lastReadAt && new Date(p.lastReadAt) >= new Date(msg.createdAt));
                      return isSeen
                        ? <Tooltip><TooltipTrigger asChild><span><CheckCheck className="w-3 h-3 text-primary inline" /></span></TooltipTrigger><TooltipContent side="top" className="text-xs">{t("messagesPage.seen")}</TooltipContent></Tooltip>
                        : <Tooltip><TooltipTrigger asChild><span><Check className="w-3 h-3 opacity-50 inline" /></span></TooltipTrigger><TooltipContent side="top" className="text-xs">{t("messagesPage.delivered")}</TooltipContent></Tooltip>;
                    })()}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="p-4 border-t border-border/50 shrink-0">
        {pendingFile && (
          <div className="flex items-center gap-2 mb-2 p-2 rounded-lg bg-secondary/50 text-sm">
            <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="truncate flex-1">{pendingFile.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(pendingFile.size)}</span>
            <button onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
            accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.rar"
          />
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 rounded-xl"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || uploading}
          >
            <Paperclip className="w-4 h-4" />
          </Button>
          <Input
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            placeholder={t("messagesPage.typeMessage")}
            className="flex-1 rounded-xl"
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          />
          <Button onClick={sendMessage} disabled={sending || uploading || (!newMessage.trim() && !pendingFile)} className="rounded-xl gap-1.5">
            {(sending || uploading) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send
          </Button>
        </div>
      </div>
    </div>
    </>
  );
}

function BroadcastTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [targetAudience, setTargetAudience] = useState("all");
  const [targetRoles, setTargetRoles] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [broadcasts, setBroadcasts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [expandedCampaignId, setExpandedCampaignId] = useState<number | null>(null);
  const [campaignDetails, setCampaignDetails] = useState<Record<number, any>>({});
  const [campaignDetailLoading, setCampaignDetailLoading] = useState<number | null>(null);
  const [retryingCampaignId, setRetryingCampaignId] = useState<number | null>(null);

  const availableRoles = [
    { value: "super_admin", label: "Super Admin" }, { value: "admin", label: "Admin" },
    { value: "manager", label: "Manager" }, { value: "staff", label: "Staff" },
    { value: "consultant", label: "Consultant" }, { value: "accountant", label: "Accountant" },
    { value: "student", label: "Student" }, { value: "agent", label: "Agent" },
    { value: "sub_agent", label: "Sub Agent" },
  ];

  useEffect(() => {
    customFetch("/api/broadcasts").then((r: any) => {
      setBroadcasts(r?.data || r || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const loadCampaigns = useCallback(async (quiet = false) => {
    if (!quiet) setCampaignsLoading(true);
    try {
      const response = await customFetch("/api/message-campaigns") as any;
      setCampaigns(response?.data || response || []);
    } catch (error: any) {
      if (!quiet) {
        toast({
          title: "CRM campaigns could not be loaded",
          description: error?.message || "Campaign history is temporarily unavailable.",
          variant: "destructive",
        });
      }
    } finally {
      if (!quiet) setCampaignsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadCampaigns();
    const timer = window.setInterval(() => void loadCampaigns(true), 10_000);
    return () => window.clearInterval(timer);
  }, [loadCampaigns]);

  const sendBroadcast = async () => {
    if (!title.trim() || !content.trim()) {
      toast({ title: t("messagesPage.titleAndMessageRequired"), variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await customFetch("/api/broadcasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          channel: "internal",
          targetAudience,
          targetRoles: targetAudience === "role" ? targetRoles : [],
        }),
      });
      toast({ title: `Internal announcement sent to ${(res as any).recipientCount} users` });
      setTitle("");
      setContent("");
      setBroadcasts(prev => [res as any, ...prev]);
    } catch (err: any) {
      toast({ title: t("messagesPage.failedToSendBroadcast"), description: err.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const toggleRole = (role: string) => {
    setTargetRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);
  };

  const loadCampaignDetails = async (campaignId: number) => {
    setCampaignDetailLoading(campaignId);
    try {
      const response = await customFetch(`/api/message-campaigns/${campaignId}`) as any;
      setCampaignDetails((current) => ({ ...current, [campaignId]: response?.data || response }));
      return true;
    } catch (error: any) {
      toast({
        title: "Recipient history could not be loaded",
        description: error?.message,
        variant: "destructive",
      });
      return false;
    } finally {
      setCampaignDetailLoading(null);
    }
  };

  const toggleCampaignDetails = async (campaignId: number) => {
    if (expandedCampaignId === campaignId) {
      setExpandedCampaignId(null);
      return;
    }
    setExpandedCampaignId(campaignId);
    if (campaignDetails[campaignId]) return;
    if (!(await loadCampaignDetails(campaignId))) {
      setExpandedCampaignId(null);
    }
  };

  const retryFailedCampaign = async (campaignId: number) => {
    setRetryingCampaignId(campaignId);
    try {
      const response = await customFetch(`/api/message-campaigns/${campaignId}/retry-failed`, {
        method: "POST",
      }) as any;
      toast({
        title: `${response?.retried || 0} safe failure(s) queued again`,
        description: "Recipients with an unknown provider outcome remain blocked for manual review.",
      });
      setCampaignDetails((current) => {
        const next = { ...current };
        delete next[campaignId];
        return next;
      });
      await loadCampaigns(true);
      if (expandedCampaignId === campaignId) await loadCampaignDetails(campaignId);
    } catch (error: any) {
      toast({ title: "Retry failed", description: error?.message, variant: "destructive" });
    } finally {
      setRetryingCampaignId(null);
    }
  };

  const campaignStatusClass = (status: string) => {
    if (status === "completed") return "bg-emerald-100 text-emerald-700";
    if (status === "failed") return "bg-red-100 text-red-700";
    if (status === "running") return "bg-blue-100 text-blue-700";
    return "bg-amber-100 text-amber-700";
  };

  const maskCampaignPhone = (phone: string | null | undefined) => {
    if (!phone) return "No phone";
    const visible = phone.replace(/\D/g, "");
    if (visible.length < 5) return "***";
    return `+${visible.slice(0, 2)}••••${visible.slice(-3)}`;
  };

  return (
    <>
    <div className="space-y-6">
      <Card className="p-6 border-none shadow-lg shadow-black/5">
        <div className="mb-4">
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-primary" /> Internal Announcements
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Send an in-app announcement to Find And Study OS users. This does not contact CRM leads or students.
          </p>
        </div>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("messagesPage.title")}</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("messagesPage.broadcastTitle")} className="rounded-xl" />
          </div>
          <div className="space-y-2">
            <Label>{t("messagesPage.message")}</Label>
            <Textarea value={content} onChange={e => setContent(e.target.value)} placeholder={t("messagesPage.writeBroadcastMessage")} rows={4} className="rounded-xl" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Delivery</Label>
              <div className="flex h-10 items-center gap-2 rounded-xl border bg-muted/30 px-3 text-sm">
                <MessageSquare className="h-4 w-4 text-primary" /> Internal · in app
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("messagesPage.targetAudience")}</Label>
              <Select value={targetAudience} onValueChange={setTargetAudience}>
                <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("messagesPage.allActiveUsers")}</SelectItem>
                  <SelectItem value="role">{t("messagesPage.specificRoles")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {targetAudience === "role" && (
            <div className="space-y-2">
              <Label>{t("messagesPage.selectRoles")}</Label>
              <div className="flex flex-wrap gap-2">
                {availableRoles.map(r => (
                  <button key={r.value} onClick={() => toggleRole(r.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${targetRoles.includes(r.value) ? "bg-primary text-white" : "bg-secondary hover:bg-secondary/80 text-foreground"}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Button onClick={sendBroadcast} disabled={sending} className="rounded-xl gap-2">
            <Send className="w-4 h-4" /> {sending ? "Sending..." : "Send Internal Announcement"}
          </Button>
        </div>
      </Card>

      <Card className="border-none shadow-lg shadow-black/5 overflow-hidden">
        <div className="px-6 py-4 border-b border-border/50">
          <h3 className="font-semibold text-foreground">Internal Announcement History</h3>
        </div>
        {loading ? (
          <div className="p-8 text-center"><div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin mx-auto" /></div>
        ) : broadcasts.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">{t("messagesPage.noBroadcastsYet")}</div>
        ) : (
          <div className="divide-y divide-border/50">
            {broadcasts.map((b: any) => {
              const ChIcon = channelIcon[b.channel] || MessageSquare;
              return (
                <div key={b.id} className="px-6 py-4 hover:bg-secondary/30 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm text-foreground">{b.title}</p>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{b.content}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="secondary" className={`text-[10px] ${channelColor[b.channel] || ""}`}>
                        <ChIcon className="w-3 h-3 mr-1" />{b.channel}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        <Users className="w-3 h-3 mr-1" />{b.recipientCount}
                      </Badge>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    Sent by {b.senderFirstName} {b.senderLastName} • {new Date(b.sentAt || b.createdAt).toLocaleString()}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="border-none shadow-lg shadow-black/5 overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-border/50 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="flex items-center gap-2 font-semibold text-foreground">
              <MessageCircle className="h-5 w-5 text-emerald-600" /> CRM Campaigns
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Approved WhatsApp templates sent to snapshotted Leads, Students or Applications, with one delivery record per recipient.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setLocation("/staff/leads")}>Select Leads</Button>
            <Button variant="outline" size="sm" onClick={() => setLocation("/staff/students")}>Select Students</Button>
            <Button variant="outline" size="sm" onClick={() => setLocation("/staff/applications")}>Select Applications</Button>
            <Button variant="ghost" size="icon" onClick={() => void loadCampaigns()} aria-label="Refresh campaigns">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {campaignsLoading ? (
          <div className="p-8 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" /></div>
        ) : campaigns.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium">No CRM campaign yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Select records on Leads, Students or Applications and choose “Send Template”.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {campaigns.map((campaign: any) => {
              const detail = campaignDetails[campaign.id];
              const recipients = detail?.recipients || [];
              const processed = Number(campaign.sentCount || 0) + Number(campaign.failedCount || 0) + Number(campaign.skippedCount || 0);
              const total = Math.max(1, Number(campaign.totalCount || 0));
              const progress = Math.min(100, Math.round((processed / total) * 100));
              return (
                <div key={campaign.id} className="px-6 py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-foreground">{campaign.name}</p>
                        <Badge className={`border-0 text-[10px] ${campaignStatusClass(campaign.status)}`}>{campaign.status}</Badge>
                        <Badge variant="outline" className="text-[10px] capitalize">{campaign.sourceEntityType}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Template: {campaign.externalTemplateName || campaign.templateName} · Created {new Date(campaign.createdAt).toLocaleString()}
                      </p>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>{campaign.totalCount || 0} total</span>
                        <span className="text-emerald-700">{campaign.sentCount || 0} sent</span>
                        <span>{campaign.queuedCount || 0} queued</span>
                        <span className={campaign.failedCount ? "text-destructive" : ""}>{campaign.failedCount || 0} failed</span>
                        <span>{campaign.skippedCount || 0} skipped</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" size="sm" onClick={() => void toggleCampaignDetails(campaign.id)}>
                        {campaignDetailLoading === campaign.id
                          ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          : <Eye className="mr-2 h-3.5 w-3.5" />}
                        {expandedCampaignId === campaign.id ? "Hide recipients" : "View recipients"}
                      </Button>
                      {Number(campaign.failedCount || 0) > 0 && (
                        <Button variant="outline" size="sm" onClick={() => void retryFailedCampaign(campaign.id)} disabled={retryingCampaignId === campaign.id}>
                          {retryingCampaignId === campaign.id ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                          Retry safe failures
                        </Button>
                      )}
                    </div>
                  </div>

                  {expandedCampaignId === campaign.id && (
                    <div className="mt-4 overflow-hidden rounded-xl border bg-muted/15">
                      {campaignDetailLoading === campaign.id ? (
                        <div className="p-5 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
                      ) : recipients.length === 0 ? (
                        <div className="p-4 text-sm text-muted-foreground">No recipient record found.</div>
                      ) : (
                        <div className="max-h-72 divide-y overflow-y-auto">
                          {recipients.map((recipient: any) => (
                            <div key={recipient.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_120px_100px]">
                              <div className="min-w-0">
                                <p className="truncate font-medium text-foreground">{recipient.displayName || `${recipient.entityType} #${recipient.entityId}`}</p>
                                <p className="mt-0.5 text-muted-foreground">{maskCampaignPhone(recipient.phoneE164)}</p>
                                {recipient.errorDetail && <p className="mt-1 text-destructive">{recipient.errorDetail}</p>}
                              </div>
                              <span className="hidden self-start text-muted-foreground sm:block">Attempt {recipient.attempts || 0}/3</span>
                              <Badge variant="outline" className="h-fit justify-self-end capitalize">{recipient.status}</Badge>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
    </>
  );
}

const TEMPLATE_CATEGORIES = [
  { value: "general", label: "General" },
  { value: "welcome", label: "Welcome" },
  { value: "follow_up", label: "Follow Up" },
  { value: "application", label: "Application" },
  { value: "visa", label: "Visa" },
  { value: "payment", label: "Payment" },
  { value: "offer", label: "Offer" },
  { value: "rejection", label: "Rejection" },
  { value: "reminder", label: "Reminder" },
  { value: "agent", label: "Agent" },
];

const TEMPLATE_CHANNELS = [
  { value: "all", label: "All Channels" },
  { value: "internal", label: "Internal" },
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "sms", label: "SMS" },
];

const TEMPLATE_LANGUAGES = SYSTEM_LANGUAGE_OPTIONS.map(({ code, label }) => ({
  value: code,
  label,
}));

const WHATSAPP_TEMPLATE_VARIABLES = [
  { value: "studentName", labelKey: "messagesPage.variableStudentName" },
  { value: "firstName", labelKey: "messagesPage.variableFirstName" },
  { value: "lastName", labelKey: "messagesPage.variableLastName" },
  { value: "universityName", labelKey: "messagesPage.variableUniversityName" },
  { value: "programName", labelKey: "messagesPage.variableProgramName" },
  { value: "deadline", labelKey: "messagesPage.variableDeadline" },
  { value: "level", labelKey: "messagesPage.variableLevel" },
  { value: "intake", labelKey: "messagesPage.variableIntake" },
] as const;

function whatsappTemplateVariableCount(body: string): number {
  return new Set(Array.from(body.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (match) => match[1])).size;
}

interface Template {
  id: number;
  name: string;
  category: string;
  subject: string | null;
  content: string;
  channel: string;
  language: string;
  variables: string[];
  isActive: boolean;
  externalTemplateName?: string | null;
  approvalStatus?: string | null;
  createdById: number | null;
  createdAt: string;
  updatedAt: string;
  creatorFirstName: string | null;
  creatorLastName: string | null;
}

function TemplatesTab() {
  const { t: tx } = useI18n();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);

  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("general");
  const [formSubject, setFormSubject] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formChannel, setFormChannel] = useState("all");
  const [formLanguage, setFormLanguage] = useState("en");

  const [waSyncing, setWaSyncing] = useState(false);
  const [waSyncError, setWaSyncError] = useState<string | null>(null);
  const [waTplOpen, setWaTplOpen] = useState(false);
  const [waDeleteConfirm, setWaDeleteConfirm] = useState<number | null>(null);
  const [waDeleting, setWaDeleting] = useState(false);
  const [waSaving, setWaSaving] = useState(false);
  const [waMode, setWaMode] = useState<"custom" | "library">("custom");
  const [waName, setWaName] = useState("");
  const [waLanguage, setWaLanguage] = useState("en");
  const [waCategory, setWaCategory] = useState("utility");
  const [waBodyText, setWaBodyText] = useState("");
  const [waFooterText, setWaFooterText] = useState("");
  const [waVariableMappings, setWaVariableMappings] = useState<string[]>([]);
  const [waVariableExamples, setWaVariableExamples] = useState<string[]>([]);
  const [waQuickReplies, setWaQuickReplies] = useState<string[]>([]);
  const [waLibraryName, setWaLibraryName] = useState("");
  const waVariableCount = useMemo(
    () => whatsappTemplateVariableCount(waBodyText),
    [waBodyText],
  );
  const waBodyCharacterCount = useMemo(
    () => Array.from(waBodyText.trim()).length,
    [waBodyText],
  );

  useEffect(() => {
    setWaVariableMappings((current) =>
      Array.from({ length: waVariableCount }, (_, index) => current[index] || ""),
    );
    setWaVariableExamples((current) =>
      Array.from({ length: waVariableCount }, (_, index) => current[index] || ""),
    );
  }, [waVariableCount]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await customFetch("/api/message-templates");
      setTemplates((res as any)?.data || []);
    } catch {
      toast({ title: tx("messagesPage.failedToLoadTemplates"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  const syncWhatsAppTemplates = useCallback(async () => {
    setWaSyncing(true);
    setWaSyncError(null);
    try {
      const res = await customFetch("/api/inbox/whatsapp-templates");
      const synced: Template[] = (res as any)?.data || [];
      setTemplates((prev) => {
        const map = new Map(prev.map((t) => [t.id, t]));
        for (const t of synced) map.set(t.id, t);
        return Array.from(map.values());
      });
    } catch (err: any) {
      setWaSyncError(err?.body?.error || tx("messagesPage.whatsappTemplateSyncFailed"));
    } finally {
      setWaSyncing(false);
    }
  }, [tx]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);
  useEffect(() => { syncWhatsAppTemplates(); }, [syncWhatsAppTemplates]);

  function openNewWaTemplate() {
    setWaMode("custom");
    setWaName("");
    setWaLanguage("en");
    setWaCategory("utility");
    setWaBodyText("");
    setWaFooterText("");
    setWaVariableMappings([]);
    setWaVariableExamples([]);
    setWaQuickReplies([]);
    setWaLibraryName("");
    setWaTplOpen(true);
  }

  async function deleteWaTemplate(id: number, externalName: string) {
    setWaDeleting(true);
    try {
      await customFetch(`/api/inbox/whatsapp-templates/${encodeURIComponent(externalName)}?localTemplateId=${id}`, {
        method: "DELETE",
      });
      setTemplates(prev => prev.filter(t => t.id !== id));
      toast({ title: tx("messagesPage.templateDeleted") });
    } catch (err: any) {
      toast({ title: err?.body?.error || tx("messagesPage.failedToDelete"), variant: "destructive" });
    } finally {
      setWaDeleting(false);
      setWaDeleteConfirm(null);
    }
  }

  async function submitWaTemplate() {
    if (!waName.trim()) {
      toast({ title: tx("messagesPage.nameAndContentRequired"), variant: "destructive" });
      return;
    }
    if (waMode === "custom" && !waBodyText.trim()) {
      toast({ title: tx("messagesPage.nameAndContentRequired"), variant: "destructive" });
      return;
    }
    if (
      waMode === "custom" &&
      waBodyCharacterCount > WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS
    ) {
      toast({ title: tx("messagesPage.whatsappTemplateBodyTooLong"), variant: "destructive" });
      return;
    }
    if (waMode === "library" && !waLibraryName.trim()) {
      toast({ title: tx("messagesPage.nameAndContentRequired"), variant: "destructive" });
      return;
    }
    if (
      waMode === "custom" &&
      waVariableCount > 0 &&
      (waVariableMappings.some((value) => !value) || waVariableExamples.some((value) => !value.trim()))
    ) {
      toast({ title: tx("messagesPage.variableMappingRequired"), variant: "destructive" });
      return;
    }
    if (waQuickReplies.some((value) => value.trim().length > 25)) {
      toast({ title: tx("messagesPage.quickReplyTooLong"), variant: "destructive" });
      return;
    }
    setWaSaving(true);
    try {
      await customFetch("/api/inbox/whatsapp-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: waMode,
          name: waName.trim(),
          language: waLanguage,
          category: waCategory,
          bodyText: waMode === "custom" ? waBodyText.trim() : undefined,
          footerText: waMode === "custom" ? (waFooterText.trim() || undefined) : undefined,
          variableMappings: waMode === "custom" ? waVariableMappings : undefined,
          bodyExamples: waMode === "custom" ? waVariableExamples.map((value) => value.trim()) : undefined,
          quickReplyButtons: waMode === "custom"
            ? waQuickReplies.map((text) => ({ text: text.trim() })).filter((button) => button.text)
            : undefined,
          libraryTemplateName: waMode === "library" ? waLibraryName.trim() : undefined,
        }),
      });
      toast({ title: tx("messagesPage.whatsappTemplateSubmitted") });
      setWaTplOpen(false);
      fetchTemplates();
    } catch (err: any) {
      toast({ title: err?.body?.error || tx("messagesPage.whatsappTemplateSubmitFailed"), variant: "destructive" });
    } finally {
      setWaSaving(false);
    }
  }

  function waStatusBadge(status?: string | null) {
    const s = String(status || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const styles: Record<string, string> = {
      approved: "bg-green-500/10 text-green-700",
      pending: "bg-amber-500/10 text-amber-700",
      rejected: "bg-red-500/10 text-red-700",
      pending_deletion: "bg-orange-500/10 text-orange-700",
      in_appeal: "bg-blue-500/10 text-blue-700",
      paused: "bg-amber-500/10 text-amber-700",
      disabled: "bg-red-500/10 text-red-700",
      unknown: "bg-gray-500/10 text-gray-600",
    };
    const labels: Record<string, string> = {
      approved: tx("messagesPage.waStatusApproved"),
      pending: tx("messagesPage.waStatusPending"),
      rejected: tx("messagesPage.waStatusRejected"),
      unknown: tx("messagesPage.waStatusUnknown"),
    };
    const readableFallback = s.split("_").map((part) =>
      part ? `${part[0].toUpperCase()}${part.slice(1)}` : ""
    ).join(" ");
    return (
      <Badge variant="secondary" className={`text-[10px] h-5 ${styles[s] || styles.unknown}`}>
        {labels[s] || readableFallback || labels.unknown}
      </Badge>
    );
  }

  function openNew() {
    setEditingTemplate(null);
    setFormName("");
    setFormCategory("general");
    setFormSubject("");
    setFormContent("");
    setFormChannel("all");
    setFormLanguage("en");
    setEditOpen(true);
  }

  function openEdit(t: Template) {
    setEditingTemplate(t);
    setFormName(t.name);
    setFormCategory(t.category);
    setFormSubject(t.subject || "");
    setFormContent(t.content);
    setFormChannel(t.channel);
    setFormLanguage(t.language);
    setEditOpen(true);
  }

  async function saveTemplate() {
    if (!formName.trim() || !formContent.trim()) {
      toast({ title: tx("messagesPage.nameAndContentRequired"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: formName.trim(),
        category: formCategory,
        subject: formSubject.trim() || null,
        content: formContent.trim(),
        channel: formChannel,
        language: formLanguage,
      };

      if (editingTemplate) {
        const res = await customFetch(`/api/message-templates/${editingTemplate.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        setTemplates(prev => prev.map(t => t.id === editingTemplate.id ? { ...t, ...(res as any) } : t));
        toast({ title: tx("messagesPage.templateUpdated") });
      } else {
        const res = await customFetch("/api/message-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        fetchTemplates();
        toast({ title: tx("messagesPage.templateCreated") });
      }
      setEditOpen(false);
    } catch (err: any) {
      toast({ title: tx("messagesPage.failedToSaveTemplate"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function deleteTemplate(id: number) {
    try {
      await customFetch(`/api/message-templates/${id}`, { method: "DELETE" });
      setTemplates(prev => prev.filter(t => t.id !== id));
      toast({ title: tx("messagesPage.templateDeleted") });
    } catch (err: any) {
      toast({ title: tx("messagesPage.failedToDelete"), description: err.message, variant: "destructive" });
    }
    setDeleteConfirm(null);
  }

  async function toggleActive(t: Template) {
    try {
      await customFetch(`/api/message-templates/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      setTemplates(prev => prev.map(x => x.id === t.id ? { ...x, isActive: !x.isActive } : x));
    } catch {
      toast({ title: tx("messagesPage.failedToUpdateTemplate"), variant: "destructive" });
    }
  }

  function copyContent(content: string) {
    navigator.clipboard.writeText(content);
    toast({ title: tx("messagesPage.templateContentCopied") });
  }

  const filtered = templates.filter(t => {
    if (filterCategory !== "all" && t.category !== filterCategory) return false;
    if (searchTerm && !t.name.toLowerCase().includes(searchTerm.toLowerCase()) && !t.content.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  const cannedFiltered = filtered.filter(t => !t.externalTemplateName);
  const waFiltered = filtered.filter(t => !!t.externalTemplateName);

  const grouped = cannedFiltered.reduce<Record<string, Template[]>>((acc, t) => {
    (acc[t.category] = acc[t.category] || []).push(t);
    return acc;
  }, {});

  const channelBadge = (ch: string) => {
    const colors: Record<string, string> = {
      all: "bg-gray-500/10 text-gray-600",
      internal: "bg-blue-500/10 text-blue-600",
      email: "bg-purple-500/10 text-purple-600",
      whatsapp: "bg-green-500/10 text-green-600",
      telegram: "bg-sky-500/10 text-sky-600",
      sms: "bg-amber-500/10 text-amber-600",
    };
    return colors[ch] || colors.all;
  };

  return (
    <>
    <div className="space-y-4">
      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" /> Message Templates
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Create and manage reusable message templates for quick communication.
            </p>
          </div>
          <Button onClick={openNew} className="rounded-xl gap-2">
            <Plus className="w-4 h-4" /> New Template
          </Button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={tx("messagesPage.searchTemplates")}
              className="pl-9 rounded-xl"
            />
          </div>
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-full sm:w-48 rounded-xl">
              <SelectValue placeholder={tx("messagesPage.category")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tx("messagesPage.allCategories")}</SelectItem>
              {TEMPLATE_CATEGORIES.map(c => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <FileText className="w-12 h-12 mb-3 opacity-20" />
            <p className="font-medium">{tx("messagesPage.noTemplatesFound")}</p>
            <p className="text-sm mt-1">{tx("messagesPage.createFirstTemplate")}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([cat, catTemplates]) => {
              const catLabel = TEMPLATE_CATEGORIES.find(c => c.value === cat)?.label || cat;
              return (
                <div key={cat}>
                  <div className="flex items-center gap-2 mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{catLabel}</h4>
                    <Badge variant="secondary" className="text-[10px] h-5">{catTemplates.length}</Badge>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {catTemplates.map(t => (
                      <div
                        key={t.id}
                        className={`border rounded-xl p-4 transition-all hover:shadow-md ${!t.isActive ? "opacity-50 bg-secondary/30" : "bg-card hover:border-primary/30"}`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm text-foreground truncate">{t.name}</p>
                            {t.subject && (
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">Subject: {t.subject}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Badge variant="secondary" className={`text-[10px] h-5 ${channelBadge(t.channel)}`}>
                              {TEMPLATE_CHANNELS.find(c => c.value === t.channel)?.label || t.channel}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] h-5 gap-0.5">
                              <Globe className="w-2.5 h-2.5" />
                              {t.language.toUpperCase()}
                            </Badge>
                          </div>
                        </div>

                        <div className="relative mb-3">
                          {previewId === t.id ? (
                            <div className="bg-secondary/50 rounded-lg p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                              {t.content}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground line-clamp-2">{t.content}</p>
                          )}
                        </div>

                        <div className="flex items-center justify-between">
                          <p className="text-[10px] text-muted-foreground">
                            {t.creatorFirstName && `by ${t.creatorFirstName} ${t.creatorLastName}`}
                            {t.updatedAt && ` • ${new Date(t.updatedAt).toLocaleDateString()}`}
                          </p>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setPreviewId(previewId === t.id ? null : t.id)}
                              className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                              title={previewId === t.id ? "Collapse" : "Preview"}
                            >
                              {previewId === t.id ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              onClick={() => copyContent(t.content)}
                              className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                              title={tx("messagesPage.copyContent")}
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => openEdit(t)}
                              className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                              title={tx("messagesPage.edit")}
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => toggleActive(t)}
                              className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                              title={t.isActive ? "Deactivate" : "Activate"}
                            >
                              {t.isActive ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            {deleteConfirm === t.id ? (
                              <div className="flex items-center gap-1">
                                <button onClick={() => deleteTemplate(t.id)} className="p-1.5 rounded-lg bg-red-500/10 text-red-600 hover:bg-red-500/20 transition-colors" title={tx("messagesPage.confirmDelete")}>
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => setDeleteConfirm(null)} className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground" title={tx("messagesPage.cancel")}>
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setDeleteConfirm(t.id)}
                                className="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors text-muted-foreground hover:text-red-600"
                                title={tx("messagesPage.delete")}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" /> {tx("messagesPage.whatsappOfficialTemplates")}
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              {tx("messagesPage.whatsappOfficialTemplatesDesc")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={syncWhatsAppTemplates} disabled={waSyncing} className="rounded-xl gap-2">
              {waSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {tx("messagesPage.refresh")}
            </Button>
            <Button onClick={openNewWaTemplate} className="rounded-xl gap-2">
              <Plus className="w-4 h-4" /> {tx("messagesPage.newWhatsappTemplate")}
            </Button>
          </div>
        </div>

        {waSyncError && (
          <div className="mb-4 p-3 rounded-lg border border-amber-300 bg-amber-50 text-xs text-amber-900">
            {waSyncError}
          </div>
        )}

        {waFiltered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <FileText className="w-10 h-10 mb-3 opacity-20" />
            <p className="font-medium text-sm">{tx("messagesPage.noWhatsappTemplatesFound")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {waFiltered.map(t => (
              <div key={t.id} className={`border rounded-xl p-4 transition-all hover:shadow-md ${!t.isActive ? "opacity-50 bg-secondary/30" : "bg-card hover:border-primary/30"}`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-foreground truncate">{t.name}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {waStatusBadge(t.approvalStatus)}
                    <Badge variant="outline" className="text-[10px] h-5 gap-0.5">
                      <Globe className="w-2.5 h-2.5" /> {t.language.toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">{t.content}</p>
                <div className="flex items-center justify-between mt-3">
                  <p className="text-[10px] text-muted-foreground capitalize">{t.category}</p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => copyContent(t.content)}
                      className="p-1.5 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                      title={tx("messagesPage.copyContent")}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    {waDeleteConfirm === t.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => t.externalTemplateName && deleteWaTemplate(t.id, t.externalTemplateName)}
                          disabled={waDeleting}
                          className="h-7 gap-1 px-2 text-xs"
                          title={tx("messagesPage.confirmDelete")}
                        >
                          {waDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          {tx("messagesPage.delete")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setWaDeleteConfirm(null)}
                          className="h-7 px-2 text-xs"
                          title={tx("messagesPage.cancel")}
                        >
                          {tx("messagesPage.cancel")}
                        </Button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setWaDeleteConfirm(t.id)}
                        className="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors text-muted-foreground hover:text-red-600"
                        title={tx("messagesPage.delete")}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={waTplOpen} onOpenChange={setWaTplOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" /> {tx("messagesPage.newWhatsappTemplate")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex gap-2">
              <Button type="button" variant={waMode === "custom" ? "default" : "outline"} size="sm" className="rounded-lg" onClick={() => setWaMode("custom")}>
                {tx("messagesPage.waModeCustom")}
              </Button>
              <Button type="button" variant={waMode === "library" ? "default" : "outline"} size="sm" className="rounded-lg" onClick={() => setWaMode("library")}>
                {tx("messagesPage.waModeLibrary")}
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tx("messagesPage.templateNameRequired")}</Label>
                <Input value={waName} onChange={e => setWaName(e.target.value)} placeholder="order_update" className="rounded-xl" />
              </div>
              <div className="space-y-2">
                <Label>{tx("messagesPage.language")}</Label>
                <Select value={waLanguage} onValueChange={setWaLanguage}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_LANGUAGES.map(l => (
                      <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{tx("messagesPage.category")}</Label>
              <Select value={waCategory} onValueChange={setWaCategory}>
                <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="utility">Utility</SelectItem>
                  <SelectItem value="marketing">Marketing</SelectItem>
                  <SelectItem value="authentication">Authentication</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {waMode === "custom" ? (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{tx("messagesPage.contentRequired")}</Label>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>{"{{1}}, {{2}} ..."}</span>
                      <span
                        className={
                          waBodyCharacterCount > WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS
                            ? "font-medium text-destructive"
                            : ""
                        }
                      >
                        {waBodyCharacterCount}/
                        {WHATSAPP_TEMPLATE_BODY_MAX_CHARACTERS.toLocaleString("en-US")}
                      </span>
                    </div>
                  </div>
                  <Textarea
                    value={waBodyText}
                    onChange={e => setWaBodyText(e.target.value)}
                    rows={5}
                    aria-describedby="whatsapp-template-body-limit"
                    className="rounded-xl font-mono text-sm"
                  />
                  <p id="whatsapp-template-body-limit" className="text-xs text-muted-foreground">
                    {tx("messagesPage.whatsappTemplateBodyLimit")}
                  </p>
                </div>
                {waVariableCount > 0 && (
                  <div className="space-y-3 rounded-xl border bg-muted/20 p-3">
                    <div>
                      <Label>{tx("messagesPage.variableMappings")}</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tx("messagesPage.variableMappingsDesc")}
                      </p>
                    </div>
                    {Array.from({ length: waVariableCount }, (_, index) => (
                      <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[110px_1fr_1fr] sm:items-end">
                        <Label className="pb-2 font-mono">{`{{${index + 1}}}`}</Label>
                        <div className="space-y-1">
                          <Label className="text-xs">{tx("messagesPage.crmField")}</Label>
                          <Select
                            value={waVariableMappings[index] || undefined}
                            onValueChange={(value) => setWaVariableMappings((current) => {
                              const next = [...current];
                              next[index] = value;
                              return next;
                            })}
                          >
                            <SelectTrigger className="rounded-xl"><SelectValue placeholder={tx("messagesPage.selectCrmField")} /></SelectTrigger>
                            <SelectContent>
                              {WHATSAPP_TEMPLATE_VARIABLES.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {tx(option.labelKey)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">{tx("messagesPage.metaReviewExample")}</Label>
                          <Input
                            value={waVariableExamples[index] || ""}
                            onChange={(event) => setWaVariableExamples((current) => {
                              const next = [...current];
                              next[index] = event.target.value;
                              return next;
                            })}
                            placeholder={tx("messagesPage.metaReviewExamplePlaceholder")}
                            className="rounded-xl"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-2">
                  <Label>{tx("messagesPage.waFooterOptional")}</Label>
                  <Input value={waFooterText} onChange={e => setWaFooterText(e.target.value)} className="rounded-xl" />
                </div>
                <div className="space-y-2 rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Label>{tx("messagesPage.quickReplyButtons")}</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tx("messagesPage.quickReplyButtonsDesc")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={waQuickReplies.length >= 3}
                      onClick={() => setWaQuickReplies((current) => [...current, ""])}
                      className="shrink-0 rounded-lg gap-1"
                    >
                      <Plus className="h-3.5 w-3.5" /> {tx("messagesPage.addQuickReply")}
                    </Button>
                  </div>
                  {waQuickReplies.map((reply, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        value={reply}
                        maxLength={25}
                        onChange={(event) => setWaQuickReplies((current) => {
                          const next = [...current];
                          next[index] = event.target.value;
                          return next;
                        })}
                        placeholder={tx("messagesPage.quickReplyPlaceholder")}
                        className="rounded-xl"
                      />
                      <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">
                        {reply.length}/25
                      </span>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => setWaQuickReplies((current) => current.filter((_, replyIndex) => replyIndex !== index))}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={tx("messagesPage.removeQuickReply")}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>{tx("messagesPage.waLibraryTemplateName")}</Label>
                <Input value={waLibraryName} onChange={e => setWaLibraryName(e.target.value)} className="rounded-xl" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaTplOpen(false)} className="rounded-xl">{tx("messagesPage.cancel")}</Button>
            <Button onClick={submitWaTemplate} disabled={waSaving} className="rounded-xl gap-2">
              {waSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {tx("messagesPage.submitForApproval")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              {editingTemplate ? "Edit Template" : "New Template"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{tx("messagesPage.templateNameRequired")}</Label>
              <Input value={formName} onChange={e => setFormName(e.target.value)} placeholder={tx("messagesPage.egWelcomeEmail")} className="rounded-xl" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{tx("messagesPage.category")}</Label>
                <Select value={formCategory} onValueChange={setFormCategory}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_CATEGORIES.map(c => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx("messagesPage.channel")}</Label>
                <Select value={formChannel} onValueChange={setFormChannel}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_CHANNELS.map(c => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tx("messagesPage.language")}</Label>
                <Select value={formLanguage} onValueChange={setFormLanguage}>
                  <SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_LANGUAGES.map(l => (
                      <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {(formChannel === "email" || formChannel === "all") && (
              <div className="space-y-2">
                <Label>{tx("messagesPage.subjectLine")}</Label>
                <Input value={formSubject} onChange={e => setFormSubject(e.target.value)} placeholder={tx("messagesPage.emailSubject")} className="rounded-xl" />
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{tx("messagesPage.contentRequired")}</Label>
                <p className="text-[10px] text-muted-foreground">
                  Use {"{{variable}}"} for dynamic placeholders, e.g. {"{{studentName}}"}, {"{{programName}}"}
                </p>
              </div>
              <Textarea
                value={formContent}
                onChange={e => setFormContent(e.target.value)}
                placeholder={tx("messagesPage.writeTemplateContent")}
                rows={8}
                className="rounded-xl font-mono text-sm"
              />
            </div>

            {formContent && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{tx("messagesPage.preview")}</Label>
                <div className="bg-secondary/50 rounded-xl p-4 text-sm whitespace-pre-wrap border border-border/50">
                  {formContent}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} className="rounded-xl">{tx("messagesPage.cancel")}</Button>
            <Button onClick={saveTemplate} disabled={saving} className="rounded-xl gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {saving ? "Saving..." : editingTemplate ? "Update Template" : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </>
  );
}

const BROADCAST_ROLES = ["super_admin", "admin", "manager"];

function MessageConvTracker({ convId }: { convId: number | null }) {
  useEntityViewTracker("message_thread", convId ?? undefined);
  return null;
}

export default function MessagesPage() {
  const { t, isRTL } = useI18n();
  const initialInternalConversation = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const id = Number(params.get("conversation"));
      return params.get("tab") === "internal" && Number.isInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  })();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<number | null>(initialInternalConversation);
  const [activeMessageTab, setActiveMessageTab] = useState(
    initialInternalConversation !== null ? "messages" : "inbox",
  );
  const [search, setSearch] = useState("");
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<UserResult[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<UserResult[]>([]);
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth(true);
  const canBroadcast = BROADCAST_ROLES.includes(user?.role || "");
  const [internalSort, setInternalSort] = useState<"desc" | "asc">(() => {
    try { return localStorage.getItem("internal_sort_order") === "asc" ? "asc" : "desc"; } catch { return "desc"; }
  });
  const [internalAudience, setInternalAudience] = useState<"all" | "agent" | "student">("all");
  const [internalReadState, setInternalReadState] = useState<"all" | "read" | "unread">("all");
  const [internalArchived, setInternalArchived] = useState(false);
  const [internalSelectMode, setInternalSelectMode] = useState(false);
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());
  const [internalBulkConfirm, setInternalBulkConfirm] = useState<"archive" | "unarchive" | "delete" | "delete-final" | null>(null);
  const [internalBulkBusy, setInternalBulkBusy] = useState(false);
  const [internalListWidth, setInternalListWidth] = useState<number>(() => readStoredListWidth(INTERNAL_LIST_WIDTH_STORAGE_KEY));
  const internalListResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    if (internalListResizeCleanupRef.current) internalListResizeCleanupRef.current();
  }, []);

  function startInternalListResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    if (internalListResizeCleanupRef.current) internalListResizeCleanupRef.current();
    const startX = e.clientX;
    const startW = internalListWidth;
    const maxW = inboxListMaxWidth();
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const delta = isRTL ? startX - ev.clientX : ev.clientX - startX;
      setInternalListWidth(Math.min(maxW, Math.max(INBOX_LIST_MIN_WIDTH, startW + delta)));
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      internalListResizeCleanupRef.current = null;
    };
    const onEnd = () => {
      cleanup();
      setInternalListWidth((w) => {
        try {
          localStorage.setItem(INTERNAL_LIST_WIDTH_STORAGE_KEY, String(w));
        } catch {
          // localStorage unavailable — width just won't persist
        }
        return w;
      });
    };
    internalListResizeCleanupRef.current = cleanup;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  }

  useEffect(() => { try { localStorage.setItem("internal_sort_order", internalSort); } catch {} }, [internalSort]);

  const fetchConversations = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        order: internalSort,
        audience: internalAudience,
        readState: internalReadState,
        archived: String(internalArchived),
      });
      if (search) params.set("search", search);
      const res = await customFetch(`/api/conversations?${params}`);
      setConversations((res as any)?.data || res || []);
    } catch {}
  }, [search, internalSort, internalAudience, internalReadState, internalArchived]);

  const toggleInternalSelected = (id: number) => {
    setInternalSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  async function runInternalBulk(type: "archive" | "unarchive" | "delete") {
    const ids = Array.from(internalSelectedIds);
    if (ids.length === 0) return;
    setInternalBulkBusy(true);
    try {
      const path = type === "delete" ? "bulk-delete" : type === "unarchive" ? "bulk-unarchive" : "bulk-archive";
      await customFetch(`/api/inbox/conversations/${path}`, {
        method: "POST",
        body: JSON.stringify(type === "delete" ? { ids, confirm: "DELETE_CONVERSATIONS" } : { ids }),
      });
      toast({
        title: type === "delete"
          ? t("inbox.bulk.deletedToast", { count: ids.length })
          : type === "unarchive"
            ? t("inbox.bulk.restoredToast", { count: ids.length })
            : t("inbox.bulk.archivedToast", { count: ids.length }),
      });
      setInternalBulkConfirm(null);
      setInternalSelectMode(false);
      setInternalSelectedIds(new Set());
      if (selectedConv && ids.includes(selectedConv)) setSelectedConv(null);
      fetchConversations();
    } catch (err: any) {
      toast({ title: err?.body?.error || t("inbox.bulk.failed"), variant: "destructive" });
    } finally {
      setInternalBulkBusy(false);
    }
  }

  useEffect(() => { fetchConversations(); }, [fetchConversations]);

  useEffect(() => {
    const interval = setInterval(fetchConversations, 10000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  useEffect(() => {
    if (userSearch.length < 2) { setUserResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await customFetch(`/api/users-search?search=${userSearch}&limit=10`);
        setUserResults((res as any)?.data || res || []);
      } catch {}
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearch]);

  const createConversation = async () => {
    if (selectedUsers.length === 0) {
      toast({ title: t("messagesPage.selectAtLeastOneUser"), variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const type = selectedUsers.length > 1 ? "group" : "direct";
      const res = await customFetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          participantIds: selectedUsers.map(u => u.id),
          title: type === "group" ? selectedUsers.map(u => u.firstName).join(", ") : undefined,
        }),
      });
      setNewConvOpen(false);
      setSelectedUsers([]);
      setUserSearch("");
      fetchConversations();
      setSelectedConv((res as any).id);
    } catch (err: any) {
      toast({ title: t("messagesPage.failedToCreateConversation"), description: err.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const toggleUserSelect = (user: UserResult) => {
    setSelectedUsers(prev =>
      prev.find(u => u.id === user.id)
        ? prev.filter(u => u.id !== user.id)
        : [...prev, user]
    );
  };

  return (
    <>
      <div className="min-h-0">
        <Tabs value={activeMessageTab} onValueChange={setActiveMessageTab} className="space-y-3">
          <TabsList className="h-10 max-w-full justify-start overflow-x-auto rounded-xl p-1 sm:w-fit">
            <TabsTrigger value="inbox" className="shrink-0 gap-2 px-3 sm:px-4">
              <InboxIcon className="w-4 h-4" /> Inbox
            </TabsTrigger>
            <TabsTrigger value="messages" className="shrink-0 gap-2 px-3 sm:px-4">
              <MessageCircle className="w-4 h-4" /> Internal
            </TabsTrigger>
            {canBroadcast && (
              <TabsTrigger value="broadcast" className="shrink-0 gap-2 px-3 sm:px-4">
                <Megaphone className="w-4 h-4" /> Broadcast
              </TabsTrigger>
            )}
            <TabsTrigger value="templates" className="shrink-0 gap-2 px-3 sm:px-4">
              <FileText className="w-4 h-4" /> Templates
            </TabsTrigger>
          </TabsList>

          <TabsContent value="inbox">
            <InboxTab />
          </TabsContent>

          <TabsContent value="messages">
            <Card
              className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm"
              style={{
                height: "calc(100dvh - 150px)",
                maxHeight: "calc(100dvh - 150px)",
                minHeight: "32rem",
              }}
            >
              <div className="flex h-full min-h-0">
                <div
                  className={`h-full min-h-0 min-w-0 overflow-hidden w-full lg:w-[var(--internal-list-w)] lg:shrink-0 ${selectedConv !== null ? "hidden lg:block" : ""}`}
                  style={{ "--internal-list-w": `${internalListWidth}px` } as React.CSSProperties}
                >
                  <ConversationList
                    conversations={conversations}
                    selectedId={selectedConv}
                    onSelect={setSelectedConv}
                    onNewConversation={() => setNewConvOpen(true)}
                    search={search}
                    setSearch={setSearch}
                    sortOrder={internalSort}
                    onToggleSort={() => setInternalSort((o) => (o === "desc" ? "asc" : "desc"))}
                    selectMode={internalSelectMode}
                    onToggleSelectMode={() => {
                      setInternalSelectMode((v) => !v);
                      setInternalSelectedIds(new Set());
                    }}
                    selectedIds={internalSelectedIds}
                    onToggleSelected={toggleInternalSelected}
                    onSelectAll={() =>
                      setInternalSelectedIds((prev) =>
                        prev.size === conversations.length
                          ? new Set()
                          : new Set(conversations.map((c) => c.id)),
                      )
                    }
                    onBulkDelete={() => setInternalBulkConfirm("delete")}
                    bulkBusy={internalBulkBusy}
                    audienceFilter={internalAudience}
                    setAudienceFilter={setInternalAudience}
                    readFilter={internalReadState}
                    setReadFilter={setInternalReadState}
                    archivedFilter={internalArchived}
                    setArchivedFilter={(value) => {
                      setInternalArchived(value);
                      setSelectedConv(null);
                      setInternalSelectedIds(new Set());
                    }}
                    onBulkArchive={() => setInternalBulkConfirm(internalArchived ? "unarchive" : "archive")}
                  />
                </div>

                <div
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={startInternalListResize}
                  className="hidden lg:flex shrink-0 w-[7px] -mx-[3px] z-10 cursor-col-resize items-stretch justify-center group touch-none"
                >
                  <div className="w-px bg-border/50 group-hover:bg-primary/60 group-active:bg-primary transition-colors" />
                </div>

                <div className={`flex-1 min-w-0 h-full min-h-0 ${selectedConv === null ? "hidden lg:flex lg:items-center lg:justify-center" : ""}`}>
                  {selectedConv === null ? (
                    <div className="text-center text-muted-foreground">
                      <MessageCircle className="w-16 h-16 mx-auto mb-3 opacity-20" />
                      <p className="font-medium">{t("messagesPage.selectConversation")}</p>
                      <p className="text-sm mt-1">{t("messagesPage.orStartNewOne")}</p>
                    </div>
                  ) : (
                    <>
                      <MessageConvTracker convId={selectedConv} />
                      <MessageThread conversationId={selectedConv} onBack={() => setSelectedConv(null)} />
                    </>
                  )}
                </div>
              </div>
            </Card>
          </TabsContent>

          {canBroadcast && (
            <TabsContent value="broadcast">
              <BroadcastTab />
            </TabsContent>
          )}

          <TabsContent value="templates">
            <TemplatesTab />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={newConvOpen} onOpenChange={setNewConvOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5" /> New Conversation
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t("messagesPage.searchUsers")}</Label>
              <Input value={userSearch} onChange={e => setUserSearch(e.target.value)}
                placeholder={t("messagesPage.typeToSearch")} className="rounded-xl" />
            </div>
            {userResults.length > 0 && (
              <div className="max-h-48 overflow-y-auto space-y-1 border rounded-xl p-2">
                {userResults.map(u => {
                  const selected = selectedUsers.find(s => s.id === u.id);
                  return (
                    <div key={u.id} onClick={() => toggleUserSelect(u)}
                      className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${selected ? "bg-primary/10" : "hover:bg-secondary"}`}>
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary/30 to-accent/30 flex items-center justify-center text-xs font-bold">
                        {u.firstName?.[0]}{u.lastName?.[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{u.firstName} {u.lastName}</p>
                        <p className="text-xs text-muted-foreground">{u.email} • {u.role}</p>
                      </div>
                      {selected && <Badge className="bg-primary text-white text-[10px] h-5">{t("messagesPage.selected")}</Badge>}
                    </div>
                  );
                })}
              </div>
            )}
            {selectedUsers.length > 0 && (
              <div className="space-y-2">
                <Label>Selected ({selectedUsers.length})</Label>
                <div className="flex flex-wrap gap-2">
                  {selectedUsers.map(u => (
                    <Badge key={u.id} variant="secondary" className="gap-1 cursor-pointer hover:bg-destructive/10" onClick={() => toggleUserSelect(u)}>
                      {u.firstName} {u.lastName} ×
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewConvOpen(false)}>{t("messagesPage.cancel")}</Button>
            <Button onClick={createConversation} disabled={creating || selectedUsers.length === 0}>
              {creating ? "Creating..." : "Start Conversation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={internalBulkConfirm !== null} onOpenChange={(open) => { if (!open && !internalBulkBusy) setInternalBulkConfirm(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {internalBulkConfirm === "delete" || internalBulkConfirm === "delete-final" ? (
                <Trash2 className="w-4 h-4 text-destructive" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {internalBulkConfirm === "delete-final"
                ? t("inbox.bulk.deleteConfirmTitle2")
                : internalBulkConfirm === "delete"
                  ? t("inbox.bulk.deleteConfirmTitle")
                  : internalBulkConfirm === "unarchive"
                    ? t("inbox.bulk.restoreConfirmTitle")
                  : t("inbox.bulk.archiveConfirmTitle")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {internalBulkConfirm === "delete-final"
              ? t("inbox.bulk.deleteConfirmBody2", { count: internalSelectedIds.size })
              : internalBulkConfirm === "delete"
                ? t("inbox.bulk.deleteConfirmBody", { count: internalSelectedIds.size })
                : internalBulkConfirm === "unarchive"
                  ? t("inbox.bulk.restoreConfirmBody", { count: internalSelectedIds.size })
                  : t("inbox.bulk.archiveConfirmBody", { count: internalSelectedIds.size })}
          </p>
          <DialogFooter>
            <Button variant="outline" disabled={internalBulkBusy} onClick={() => setInternalBulkConfirm(null)}>
              {t("messagesPage.cancel")}
            </Button>
            <Button
              disabled={internalBulkBusy}
              variant={internalBulkConfirm === "delete" || internalBulkConfirm === "delete-final" ? "destructive" : "default"}
              onClick={() => {
                if (internalBulkConfirm === "delete") setInternalBulkConfirm("delete-final");
                else if (internalBulkConfirm === "delete-final") void runInternalBulk("delete");
                else void runInternalBulk(internalBulkConfirm === "unarchive" ? "unarchive" : "archive");
              }}
              className="gap-1"
              data-testid="button-internal-bulk-confirm"
            >
              {internalBulkBusy && <Loader2 className="w-3 h-3 animate-spin" />}
              {internalBulkConfirm === "delete-final"
                ? t("inbox.bulk.deleteForever")
                : internalBulkConfirm === "delete"
                  ? t("inbox.bulk.deleteContinue")
                  : internalBulkConfirm === "unarchive"
                    ? t("inbox.bulk.restore")
                    : t("inbox.bulk.archive")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Admin/super-admin conversation owner picker: searchable staff dropdown that
 * replaces "Assign to me". Selecting a person reassigns the conversation (and
 * the linked lead/student/application chain, server-side); "Unassign" clears it.
 */
function AssignStaffDropdown({
  currentId,
  currentName,
  onSelect,
  t,
}: {
  currentId: number | null;
  currentName: string | null;
  onSelect: (userId: number | null) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [staff, setStaff] = useState<Array<{ id: number; firstName: string | null; lastName: string | null; role: string; isActive?: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    customFetch(`/api/users?roles=super_admin,admin,manager,staff,consultant,editor,accountant&limit=200`)
      .then((res: any) => {
        const list = Array.isArray(res?.data) ? res.data : [];
        setStaff(list.filter((u: any) => u.isActive !== false));
      })
      .catch(() => setStaff([]))
      .finally(() => setLoading(false));
  }, [open]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? staff.filter((u) => `${u.firstName ?? ""} ${u.lastName ?? ""}`.toLowerCase().includes(q))
    : staff;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" data-testid="button-assign-staff">
          <UserCheck className="w-3 h-3" />
          <span className="hidden max-w-[140px] truncate sm:inline">
            {currentId != null && currentName ? currentName : t("messagesPage.assignOwner")}
          </span>
          <ChevronDown className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-0">
        <div className="p-2 border-b">
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("messagesPage.searchStaff")}
            className="h-8 text-xs"
            onKeyDown={(e) => e.stopPropagation()}
            data-testid="input-assign-staff-search"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {currentId != null && (
            <DropdownMenuItem
              className="text-xs text-destructive"
              onClick={() => { setOpen(false); onSelect(null); }}
              data-testid="option-unassign"
            >
              <X className="w-3 h-3 mr-1.5" /> {t("messagesPage.unassign")}
            </DropdownMenuItem>
          )}
          {loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> {t("common.loading")}
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">{t("messagesPage.noStaffFound")}</div>
          )}
          {filtered.map((u) => {
            const nm = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || `#${u.id}`;
            return (
              <DropdownMenuItem
                key={u.id}
                className="text-xs"
                onClick={() => { setOpen(false); if (u.id !== currentId) onSelect(u.id); }}
                data-testid={`option-assign-${u.id}`}
              >
                <span className="flex-1 truncate">{nm}</span>
                {u.id === currentId && <Check className="w-3 h-3 ml-1.5 text-primary" />}
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
