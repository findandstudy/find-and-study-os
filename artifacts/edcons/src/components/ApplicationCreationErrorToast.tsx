import type { ReactNode } from "react";
import {
  applicationCreationErrorPresentation,
  type ApplicationCreationErrorPresentation,
} from "@/lib/applicationCreationError";

export const APPLICATION_CREATION_ERROR_TOAST_DURATION_MS = 30_000;

function ApplicationCreationErrorDescription({
  details,
}: {
  details: ApplicationCreationErrorPresentation;
}) {
  return (
    <div className="space-y-2.5" data-testid="application-creation-error-details">
      <p>{details.intro}</p>
      {details.items.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Items requiring attention">
          {details.items.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="flex items-start gap-2 rounded-md bg-red-50/80 px-2.5 py-1.5 text-foreground dark:bg-red-950/30"
            >
              <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
      )}
      {details.guidance && (
        <p className="font-medium text-foreground/80">{details.guidance}</p>
      )}
      <p className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        Close with × or this notification will disappear automatically in 30 seconds.
      </p>
    </div>
  );
}

export function applicationCreationErrorToast(
  error: unknown,
  fallback?: string,
): {
  title: string;
  description: ReactNode;
  variant: "destructive";
  duration: number;
} {
  const details = applicationCreationErrorPresentation(error, fallback);
  return {
    title: details.title,
    description: <ApplicationCreationErrorDescription details={details} />,
    variant: "destructive",
    duration: APPLICATION_CREATION_ERROR_TOAST_DURATION_MS,
  };
}
