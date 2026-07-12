import { useContinuation, useVoiceSession } from "@pear-agent/react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import { coalesceTranscript } from "../lib/coalesce-transcript";
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
  if (role === "tool") return "tool";
  return role;
}

/**
 * Floating Gemini Live control strip — start/stop, mute, horizontal flowing transcript.
 */
export function VoiceDock({ sessionId }: VoiceDockProps) {
  const voice = useVoiceSession(sessionId);
  const continuation = useContinuation(sessionId);
  const cont = continuation.continuation;
  const tickerRef = useRef<HTMLDivElement>(null);
  const live = isLive(voice.status);
  const canResume = Boolean(cont && cont.status !== "completed");

  const turns = useMemo(
    () => coalesceTranscript(voice.transcript).filter((t) => t.role !== "status"),
    [voice.transcript],
  );
  // Show recent turns so the strip stays readable; prefer latest speech.
  const visibleTurns = turns.slice(-6);
  const streamKey = visibleTurns.map((t) => `${t.role}:${t.text}`).join("|");

  // Keep the right edge (latest text) in view as partials stream in.
  useEffect(() => {
    const el = tickerRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [streamKey]);

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

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      aria-label="Gemini Live"
    >
      <div className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85">
        {/* Horizontal flowing transcript (coalesced into sentences) */}
        <div
          className="relative border-b bg-muted/40"
          style={{
            maskImage:
              "linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent)",
            WebkitMaskImage:
              "linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent)",
          }}
        >
          <div
            ref={tickerRef}
            className="flex h-9 items-center gap-3 overflow-x-auto overflow-y-hidden px-3 whitespace-nowrap scrollbar-none"
            style={{ scrollbarWidth: "none" }}
          >
            {visibleTurns.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                {canResume
                  ? "一時停止中 — 再開で続きから話せます"
                  : "話した内容がここに横へ流れていきます"}
              </span>
            ) : (
              visibleTurns.map((turn, i) => (
                <span
                  key={`${turn.role}-${i}-${turn.text.length}`}
                  className="inline-flex items-baseline gap-1 text-[12px] leading-none"
                >
                  <span
                    className={cn(
                      "shrink-0 text-[10px] font-bold tracking-wide",
                      turn.role === "assistant" && "text-primary",
                      turn.role === "user" && "text-foreground",
                      turn.role === "tool" && "text-muted-foreground",
                    )}
                  >
                    {roleShort(turn.role)}
                  </span>
                  <span
                    className={cn(
                      "font-medium",
                      turn.role === "assistant" && "text-foreground",
                      turn.role === "user" && "text-foreground/90",
                      turn.role === "tool" && "text-muted-foreground",
                    )}
                  >
                    {turn.text}
                  </span>
                  {i < visibleTurns.length - 1 ? (
                    <span className="ml-1 text-muted-foreground/50" aria-hidden>
                      ·
                    </span>
                  ) : (
                    <span
                      className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-primary/70 align-middle"
                      aria-hidden
                    />
                  )}
                </span>
              ))
            )}
          </div>
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
                Gemini Live · 部分文字起こしを文章として横スクロール
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
