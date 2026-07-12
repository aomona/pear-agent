import { useContinuation, useVoiceSession } from "@pear-agent/react";
import { toast } from "sonner";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

type VoiceContinuationPanelProps = {
  sessionId: string | null;
};

export function VoiceContinuationPanel({ sessionId }: VoiceContinuationPanelProps) {
  const voice = useVoiceSession(sessionId);
  const continuation = useContinuation(sessionId);

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast.success(label);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const cont = continuation.continuation;

  return (
    <Card>
      <CardHeader>
        <CardTitle>3. Voice & Continuation</CardTitle>
        <CardDescription>
          Connect でマイク許可 → 音声会話が始まります（GEMINI_API_KEY 必須）。充電待ちで Suspend
          しても Execution Session は止まりません。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Voice</span>
          <Badge variant="secondary">{voice.status}</Badge>
          {voice.lease ? (
            <Badge variant="outline">lease {voice.lease.id.slice(0, 8)}…</Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!sessionId}
            onClick={() => void run("Voice connected", () => voice.connect())}
          >
            Connect voice
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!sessionId || voice.status === "idle" || voice.status === "disconnected"}
            onClick={() => {
              if (voice.status === "muted") {
                voice.unmute();
                toast.message("Mic unmuted");
              } else {
                voice.mute();
                toast.message("Mic muted");
              }
            }}
          >
            {voice.status === "muted" ? "Unmute" : "Mute"}
          </Button>
          <Button
            variant="secondary"
            disabled={!sessionId}
            onClick={() =>
              void run("Voice suspended", () =>
                voice.suspend({
                  wakeCondition: { type: "manual" },
                  suspendedReason: "Waiting for charge",
                  resumeDirective: "Resume packing and charging guidance from latest snapshot",
                }),
              )
            }
          >
            Suspend (charge wait)
          </Button>
          <Button
            variant="outline"
            disabled={!sessionId}
            onClick={() => void run("Voice disconnected", () => voice.disconnect())}
          >
            Disconnect voice
          </Button>
        </div>
        {voice.error ? <p className="text-sm text-destructive">{voice.error.message}</p> : null}

        {voice.transcript.length > 0 ? (
          <ScrollArea className="h-36 rounded-md border">
            <ul className="space-y-1 p-3 text-xs">
              {voice.transcript.map((entry, i) => (
                <li key={`${entry.role}-${i}`}>
                  <span className="font-medium text-muted-foreground">{entry.role}:</span>{" "}
                  {entry.text}
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : (
          <p className="text-xs text-muted-foreground">
            接続後に文字起こしとステータスがここに表示されます。スピーカー出力も自動再生されます。
          </p>
        )}

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Continuation</span>
          <Badge variant={cont ? "warning" : "outline"}>{cont?.status ?? "none"}</Badge>
        </div>
        {cont ? (
          <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs">
            <div>
              <span className="font-medium">id:</span> {cont.id}
            </div>
            <div>
              <span className="font-medium">reason:</span> {cont.suspendedReason}
            </div>
            <div>
              <span className="font-medium">directive:</span> {cont.resumeDirective}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Active Continuation はありません。</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!sessionId || !cont || cont.status === "completed"}
            onClick={() => {
              if (!cont) return;
              void run("Resume claimed", async () => {
                const result = await continuation.claimResume(cont.id);
                toast.message(`Snapshot revision events: ${result.snapshot.recentEvents.length}`);
                return result;
              });
            }}
          >
            Claim resume
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!sessionId || !cont || !cont.resumeAttemptId}
            onClick={() => {
              if (!cont?.resumeAttemptId) return;
              void run("Continuation completed", () =>
                continuation.complete(cont.id, cont.resumeAttemptId!),
              );
            }}
          >
            Complete resume
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!sessionId}
            onClick={() =>
              void run("Voice reconnected after wake", () =>
                voice.connect(cont ? { continuationId: cont.id } : undefined),
              )
            }
          >
            Reconnect voice
          </Button>
        </div>
        {continuation.error ? (
          <p className="text-sm text-destructive">{continuation.error.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
