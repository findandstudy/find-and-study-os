export type OperationsSeverity = "critical" | "high" | "medium" | "low";
export type OperationsSource =
  | "task"
  | "application"
  | "document"
  | "portal"
  | "offer";

export type OperationsQueueItem = {
  id: string;
  source: OperationsSource;
  severity: OperationsSeverity;
  reasonCode:
    | "TASK_OVERDUE"
    | "TASK_DUE_SOON"
    | "APPLICATION_DEADLINE_OVERDUE"
    | "APPLICATION_DEADLINE_SOON"
    | "APPLICATION_UNASSIGNED"
    | "APPLICATION_STALE"
    | "DOCUMENT_REJECTED"
    | "DOCUMENT_REVIEW_REQUIRED"
    | "PORTAL_STATUS_SUSPENDED"
    | "PORTAL_IDENTITY_UNVERIFIED"
    | "PORTAL_LIFECYCLE_REVIEW"
    | "OFFER_EXPIRED"
    | "OFFER_EXPIRING";
  identity: string;
  state: string;
  nextAction: string;
  owner: string;
  dueAt: string | null;
  blocker: string;
  lastActivityAt: string | null;
  href: string;
  applicationId?: number;
  score: number;
  isMine: boolean;
};

export type QueueApplication = {
  id: number;
  stage?: string | null;
  assignedToId?: number | null;
  studentFirstName?: string | null;
  studentLastName?: string | null;
  universityName?: string | null;
  programName?: string | null;
  deadline?: string | null;
  updatedAt?: string | null;
};

export type QueueTask = {
  id: number;
  title: string;
  status: string;
  priority?: string | null;
  assignedTo?: number | null;
  assignedToName?: string | null;
  dueDate?: string | null;
  updatedAt?: string | null;
};

export type QueueDocument = {
  id: number;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  applicationId?: number | null;
  studentId?: number | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

export type QueuePortalOperations = {
  suspended?: Array<{
    submissionId: number;
    applicationId: number;
    universityKey: string;
    errorCategory: string;
    suspendedAt: string;
  }>;
  recentObservations?: Array<{
    id: number;
    submissionId: number;
    applicationId: number;
    universityKey: string;
    disposition: string;
    identityVerified: boolean;
    observedAt: string;
  }>;
};

export type QueueLifecycleProposal = {
  id: number;
  applicationId: number;
  rawStatus: string;
  status: string;
  createdAt: string;
};

export type QueueOfferDeadline = {
  docId: number;
  applicationId: number;
  universityName?: string | null;
  programName?: string | null;
  studentFirstName?: string | null;
  studentLastName?: string | null;
  validUntil?: string | null;
  daysLeft?: number | null;
};

export type BuildOperationsQueueInput = {
  currentUserId?: number | null;
  applications: QueueApplication[];
  tasks: QueueTask[];
  documents: QueueDocument[];
  terminalStageKeys?: string[];
  portal?: QueuePortalOperations | null;
  lifecycleProposals?: QueueLifecycleProposal[];
  offerDeadlines?: QueueOfferDeadline[];
};

const DAY_MS = 86_400_000;

function atStartOfDay(value: Date): number {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  ).getTime();
}

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function dayDistance(
  value: string | null | undefined,
  now: Date,
): number | null {
  const time = validTime(value);
  if (time === null) return null;
  return Math.ceil((atStartOfDay(new Date(time)) - atStartOfDay(now)) / DAY_MS);
}

function personName(first?: string | null, last?: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

function applicationIdentity(application: QueueApplication): string {
  const person = personName(
    application.studentFirstName,
    application.studentLastName,
  );
  const destination = [application.universityName, application.programName]
    .filter(Boolean)
    .join(" · ");
  return [person || `Application #${application.id}`, destination]
    .filter(Boolean)
    .join(" — ");
}

function severityScore(severity: OperationsSeverity): number {
  return { critical: 400, high: 300, medium: 200, low: 100 }[severity];
}

function score(
  severity: OperationsSeverity,
  dueAt: string | null,
  now: Date,
  tieBreaker = 0,
): number {
  const due = validTime(dueAt);
  const urgency =
    due === null
      ? 0
      : Math.max(-99, Math.min(99, Math.round((now.getTime() - due) / DAY_MS)));
  return severityScore(severity) + urgency + tieBreaker / 1_000_000;
}

function item(
  input: Omit<OperationsQueueItem, "score">,
  now: Date,
  tieBreaker = 0,
): OperationsQueueItem {
  return {
    ...input,
    score: score(input.severity, input.dueAt, now, tieBreaker),
  };
}

/**
 * Creates a deterministic, read-only operations projection from endpoints that
 * already enforce application/task/document/portal visibility. It never makes
 * workflow decisions and deliberately calls stale rows "last record update"
 * rather than claiming an SLA breach without a versioned SLA policy.
 */
export function buildOperationsQueue(
  input: BuildOperationsQueueInput,
  now = new Date(),
): OperationsQueueItem[] {
  const rows: OperationsQueueItem[] = [];
  const currentUserId = input.currentUserId ?? null;
  const terminalStages = new Set(
    (input.terminalStageKeys ?? []).map((value) => value.toLowerCase()),
  );
  const applications = new Map(
    input.applications.map((application) => [application.id, application]),
  );

  for (const task of input.tasks) {
    if (task.status === "done") continue;
    const days = dayDistance(task.dueDate, now);
    const owner =
      task.assignedToName?.trim() ||
      (task.assignedTo ? `User #${task.assignedTo}` : "Unassigned");
    const isMine = currentUserId !== null && task.assignedTo === currentUserId;
    if (days !== null && days < 0) {
      rows.push(
        item(
          {
            id: `task:${task.id}:overdue`,
            source: "task",
            severity: "critical",
            reasonCode: "TASK_OVERDUE",
            identity: task.title,
            state: task.status,
            nextAction: "Complete or reschedule the task",
            owner,
            dueAt: task.dueDate ?? null,
            blocker: `${Math.abs(days)} day(s) overdue`,
            lastActivityAt: task.updatedAt ?? null,
            href: "/staff/tasks",
            isMine,
          },
          now,
          task.id,
        ),
      );
    } else if (days !== null && days <= 3) {
      rows.push(
        item(
          {
            id: `task:${task.id}:due-soon`,
            source: "task",
            severity: task.priority === "high" ? "high" : "medium",
            reasonCode: "TASK_DUE_SOON",
            identity: task.title,
            state: task.status,
            nextAction: "Complete the scheduled task",
            owner,
            dueAt: task.dueDate ?? null,
            blocker: days === 0 ? "Due today" : `Due in ${days} day(s)`,
            lastActivityAt: task.updatedAt ?? null,
            href: "/staff/tasks",
            isMine,
          },
          now,
          task.id,
        ),
      );
    }
  }

  for (const application of input.applications) {
    const stage = (application.stage ?? "unknown").toLowerCase();
    if (terminalStages.has(stage)) continue;
    const identity = applicationIdentity(application);
    const owner = application.assignedToId
      ? `User #${application.assignedToId}`
      : "Unassigned";
    const isMine =
      currentUserId !== null && application.assignedToId === currentUserId;
    const deadlineDays = dayDistance(application.deadline, now);
    if (deadlineDays !== null && deadlineDays < 0) {
      rows.push(
        item(
          {
            id: `application:${application.id}:deadline-overdue`,
            source: "application",
            severity: "critical",
            reasonCode: "APPLICATION_DEADLINE_OVERDUE",
            identity,
            state: application.stage ?? "unknown",
            nextAction: "Review the application deadline and recovery path",
            owner,
            dueAt: application.deadline ?? null,
            blocker: `${Math.abs(deadlineDays)} day(s) past the recorded deadline`,
            lastActivityAt: application.updatedAt ?? null,
            href: `/staff/applications/${application.id}`,
            applicationId: application.id,
            isMine,
          },
          now,
          application.id,
        ),
      );
    } else if (deadlineDays !== null && deadlineDays <= 14) {
      rows.push(
        item(
          {
            id: `application:${application.id}:deadline-soon`,
            source: "application",
            severity: deadlineDays <= 3 ? "critical" : "high",
            reasonCode: "APPLICATION_DEADLINE_SOON",
            identity,
            state: application.stage ?? "unknown",
            nextAction: "Confirm readiness before the recorded deadline",
            owner,
            dueAt: application.deadline ?? null,
            blocker:
              deadlineDays === 0
                ? "Deadline is today"
                : `Deadline in ${deadlineDays} day(s)`,
            lastActivityAt: application.updatedAt ?? null,
            href: `/staff/applications/${application.id}`,
            applicationId: application.id,
            isMine,
          },
          now,
          application.id,
        ),
      );
    }
    if (!application.assignedToId) {
      rows.push(
        item(
          {
            id: `application:${application.id}:unassigned`,
            source: "application",
            severity: "high",
            reasonCode: "APPLICATION_UNASSIGNED",
            identity,
            state: application.stage ?? "unknown",
            nextAction: "Assign an accountable owner",
            owner: "Unassigned",
            dueAt: null,
            blocker: "No accountable owner is recorded",
            lastActivityAt: application.updatedAt ?? null,
            href: `/staff/applications/${application.id}`,
            applicationId: application.id,
            isMine: false,
          },
          now,
          application.id,
        ),
      );
    }
    const updated = validTime(application.updatedAt);
    if (updated !== null) {
      const ageDays = Math.floor((now.getTime() - updated) / DAY_MS);
      if (ageDays >= 7) {
        rows.push(
          item(
            {
              id: `application:${application.id}:stale`,
              source: "application",
              severity: ageDays >= 14 ? "high" : "medium",
              reasonCode: "APPLICATION_STALE",
              identity,
              state: application.stage ?? "unknown",
              nextAction:
                "Review the case and record the next meaningful action",
              owner,
              dueAt: null,
              blocker: `Last record update was ${ageDays} day(s) ago`,
              lastActivityAt: application.updatedAt ?? null,
              href: `/staff/applications/${application.id}`,
              applicationId: application.id,
              isMine,
            },
            now,
            application.id,
          ),
        );
      }
    }
  }

  for (const document of input.documents) {
    const status = (document.status ?? "pending").toLowerCase();
    const linkedApplication = document.applicationId
      ? applications.get(document.applicationId)
      : undefined;
    const identity =
      document.name?.trim() ||
      document.type?.trim() ||
      `Document #${document.id}`;
    const href = document.applicationId
      ? `/staff/applications/${document.applicationId}`
      : document.studentId
        ? `/staff/students/${document.studentId}`
        : "/staff/students";
    const ownerId = linkedApplication?.assignedToId ?? null;
    const base = {
      identity,
      state: status,
      owner: ownerId ? `User #${ownerId}` : "Unassigned",
      dueAt: null,
      lastActivityAt: document.updatedAt ?? document.createdAt ?? null,
      href,
      applicationId: document.applicationId ?? undefined,
      isMine: currentUserId !== null && ownerId === currentUserId,
    };
    if (status === "rejected" || status === "quarantined") {
      rows.push(
        item(
          {
            ...base,
            id: `document:${document.id}:rejected`,
            source: "document",
            severity: "high",
            reasonCode: "DOCUMENT_REJECTED",
            nextAction: "Resolve the document issue and obtain valid evidence",
            blocker:
              status === "quarantined"
                ? "Document is quarantined"
                : "Document was rejected",
          },
          now,
          document.id,
        ),
      );
    } else if (
      ["pending", "review_required", "needs_review", "scanning"].includes(
        status,
      )
    ) {
      rows.push(
        item(
          {
            ...base,
            id: `document:${document.id}:review`,
            source: "document",
            severity: "medium",
            reasonCode: "DOCUMENT_REVIEW_REQUIRED",
            nextAction: "Review and verify the document evidence",
            blocker:
              status === "scanning"
                ? "Document scan is not complete"
                : "Verification is pending",
          },
          now,
          document.id,
        ),
      );
    }
  }

  for (const suspended of input.portal?.suspended ?? []) {
    const linkedApplication = applications.get(suspended.applicationId);
    rows.push(
      item(
        {
          id: `portal:${suspended.submissionId}:suspended`,
          source: "portal",
          severity: "critical",
          reasonCode: "PORTAL_STATUS_SUSPENDED",
          identity: `${applicationIdentity(linkedApplication ?? { id: suspended.applicationId })} — ${suspended.universityKey}`,
          state: "suspended",
          nextAction:
            "Inspect the portal error before resuming the isolated lane",
          owner: linkedApplication?.assignedToId
            ? `User #${linkedApplication.assignedToId}`
            : "Operations queue",
          dueAt: null,
          blocker: suspended.errorCategory,
          lastActivityAt: suspended.suspendedAt,
          href: "/admin/portal-automation",
          applicationId: suspended.applicationId,
          isMine:
            currentUserId !== null &&
            linkedApplication?.assignedToId === currentUserId,
        },
        now,
        suspended.submissionId,
      ),
    );
  }

  const seenUnverifiedSubmissions = new Set<number>();
  for (const observation of input.portal?.recentObservations ?? []) {
    if (
      observation.identityVerified ||
      seenUnverifiedSubmissions.has(observation.submissionId)
    )
      continue;
    seenUnverifiedSubmissions.add(observation.submissionId);
    const linkedApplication = applications.get(observation.applicationId);
    rows.push(
      item(
        {
          id: `portal:${observation.submissionId}:unverified`,
          source: "portal",
          severity: "critical",
          reasonCode: "PORTAL_IDENTITY_UNVERIFIED",
          identity: `${applicationIdentity(linkedApplication ?? { id: observation.applicationId })} — ${observation.universityKey}`,
          state: observation.disposition,
          nextAction:
            "Verify the external application identity before any lifecycle update",
          owner: "Operations queue",
          dueAt: null,
          blocker: "Portal observation identity is not verified",
          lastActivityAt: observation.observedAt,
          href: "/admin/portal-automation",
          applicationId: observation.applicationId,
          isMine: false,
        },
        now,
        observation.id,
      ),
    );
  }

  for (const proposal of input.lifecycleProposals ?? []) {
    if (proposal.status !== "pending_review") continue;
    const linkedApplication = applications.get(proposal.applicationId);
    rows.push(
      item(
        {
          id: `portal-proposal:${proposal.id}`,
          source: "portal",
          severity: "high",
          reasonCode: "PORTAL_LIFECYCLE_REVIEW",
          identity: applicationIdentity(
            linkedApplication ?? { id: proposal.applicationId },
          ),
          state: proposal.rawStatus,
          nextAction:
            "Maker-checker review is required before applying the lifecycle proposal",
          owner: "Approval queue",
          dueAt: null,
          blocker: "Lifecycle proposal is waiting for independent review",
          lastActivityAt: proposal.createdAt,
          href: "/admin/portal-automation",
          applicationId: proposal.applicationId,
          isMine: false,
        },
        now,
        proposal.id,
      ),
    );
  }

  for (const offer of input.offerDeadlines ?? []) {
    if (
      offer.daysLeft === null ||
      offer.daysLeft === undefined ||
      offer.daysLeft > 30
    )
      continue;
    const expired = offer.daysLeft <= 0;
    rows.push(
      item(
        {
          id: `offer:${offer.docId}`,
          source: "offer",
          severity: expired || offer.daysLeft <= 7 ? "critical" : "high",
          reasonCode: expired ? "OFFER_EXPIRED" : "OFFER_EXPIRING",
          identity: [
            personName(offer.studentFirstName, offer.studentLastName) ||
              `Application #${offer.applicationId}`,
            offer.universityName,
            offer.programName,
          ]
            .filter(Boolean)
            .join(" — "),
          state: expired ? "expired" : "expiring",
          nextAction: expired
            ? "Review expiry recovery options"
            : "Complete offer acceptance actions",
          owner: applications.get(offer.applicationId)?.assignedToId
            ? `User #${applications.get(offer.applicationId)!.assignedToId}`
            : "Unassigned",
          dueAt: offer.validUntil ?? null,
          blocker: expired
            ? "Offer validity has expired"
            : `Offer expires in ${offer.daysLeft} day(s)`,
          lastActivityAt: null,
          href: `/staff/applications/${offer.applicationId}`,
          applicationId: offer.applicationId,
          isMine:
            currentUserId !== null &&
            applications.get(offer.applicationId)?.assignedToId ===
              currentUserId,
        },
        now,
        offer.docId,
      ),
    );
  }

  return rows.sort(
    (left, right) =>
      right.score - left.score || left.id.localeCompare(right.id),
  );
}
