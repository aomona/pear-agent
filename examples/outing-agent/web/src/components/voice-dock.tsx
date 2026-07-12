import { useContinuation, useVoiceSession } from "@pear-agent/react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type VoiceDockProps = {
  sessionId: string | null;
};

function statusLabel(status: string): string {
  switch (status) {
    case "connecting":
      return "接続中…";
    case "connected":
      return "Live 接続中";
    case "muted":
      return "ミュート";
    case "disconnected":
      return "切断";
    case "error":
      return "エラー";
    default:
      return "待機";
  }
}

function isLive(status: string): boolean {
  return status === "connected" || status === "muted" || status === "connecting";
}

function roleShort(role: string): string {
  if (role === "assistant") return "AI";
  if (role === "user") return "You";
  return role;
}

/**
 * Floating Gemini Live control strip — start/stop, mute, scrolling transcript.
 * Claim / complete resume collapse into one「再開」path.
 */
export function VoiceDock({ sessionId }: VoiceDockProps) {
  const voice = useVoiceSession(sessionId);
  const continuation = useContinuation(sessionId);
  const cont = continuation.continuation;
  const scrollRef = useRef<HTMLDivElement>(null);
  const live = isLive(voice.status);
  const canResume = Boolean(cont && cont.status !== "completed");

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [voice.transcript]);

  async function handlePrimary() {
    if (!sessionId) return;
    try {
      if (live) {
        await voice.disconnect();
        toast.message("音声を止めました");
        return;
      }

      if (canResume && cont) {
        const claimed = cont.resumeAttemptId
          ? { continuation: cont }
          : await continuation.claimResume(cont.id);
        const attemptId = claimed.continuation.resumeAttemptId ?? cont.resumeAttemptId;
        await voice.connect({ continuationId: cont.id });
        if (attemptId) {
          try {
            await continuation.complete(cont.id, attemptId);
          } catch {
            // Connect is enough for demo if complete races
          }
        }
        toast.success("音声を再開しました");
        return;
      }

      await voice.connect();
      toast.success("音声を開始しました");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function handleMuteToggle() {
    if (voice.status === "muted") {
      voice.unmute();
      toast.message("マイク ON");
    } else {
      voice.mute();
      toast.message("マイク OFF");
    }
  }

  async function handleSuspend() {
    if (!sessionId) return;
    try {
      await voice.suspend({
        wakeCondition: { type: "manual" },
        suspendedReason: "Waiting / hands busy",
        resumeDirective: "Resume guidance from the latest execution snapshot",
      });
      toast.message("音声だけ一時停止（実行は続きます）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const recent = voice.transcript.slice(-8);
  const lastLine = recent[recent.length - 1];

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      aria-label="Gemini Live"
    >
      <div className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div
          ref={scrollRef}
          className={cn(
            "max-h-16 overflow-y-auto border-b bg-muted/40 px-3 py-1.5 text-[11px] leading-snug text-muted-foreground",
            recent.length === 0 && "flex items-center",
          )}
        >
          {recent.length === 0 ? (
            <span className="truncate">
              {canResume
                ? "一時停止中 — 再開で続きから話せます"
                : "音声アシストの文字起こしがここに流れます"}
            </span>
          ) : (
            <ul className="space-y-0.5">
              {recent.map((entry, i) => (
                <li key={`${entry.role}-${i}-${entry.text.slice(0, 12)}`} className="truncate">
                  <span
                    className={cn(
                      "mr-1 font-semibold",
                      entry.role === "assistant" ? "text-primary" : "text-foreground",
                    )}
                  >
                    {roleShort(entry.role)}
                  </span>
                  {entry.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 px-2.5 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                voice.status === "connected" && "animate-pulse bg-emerald-500",
                voice.status === "muted" && "bg-amber-400",
                voice.status === "connecting" && "animate-pulse bg-sky-400",
                voice.status === "error" && "bg-red-500",
                !live && voice.status !== "error" && "bg-muted-foreground/40",
              )}
              aria-hidden
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold">{statusLabel(voice.status)}</span>
                {canResume && !live ? (
                  <Badge variant="warning" className="text-[10px]">
                    再開可
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-[10px] text-muted-foreground">
                {lastLine
                  ? `${roleShort(lastLine.role)}: ${lastLine.text}`
                  : "Gemini Live · 実行とは別の一時接続"}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {live && voice.status !== "connecting" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-2 text-xs"
                onClick={handleMuteToggle}
              >
                {voice.status === "muted" ? "マイクON" : "ミュート"}
              </Button>
            ) : null}
            {live && voice.status === "connected" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs text-muted-foreground"
                onClick={() => void handleSuspend()}
                title="音声だけ止めて実行は続ける"
              >
                一時停止
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="h-8 min-w-[4.5rem] px-3 text-xs"
              variant={live ? "secondary" : "default"}
              disabled={!sessionId || voice.status === "connecting"}
              onClick={() => void handlePrimary()}
            >
              {voice.status === "connecting" ? "…" : live ? "停止" : canResume ? "再開" : "話す"}
            </Button>
          </div>
        </div>

        {voice.error ? (
          <p className="border-t px-3 py-1 text-[11px] text-destructive">{voice.error.message}</p>
        ) : null}
      </div>
    </div>
  );
}
