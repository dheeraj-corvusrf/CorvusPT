import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Sparkles, X, Send, Mic, Volume2, VolumeX } from "lucide-react";
import { askRouter } from "@/lib/ask-router";
import { askAboutDocument } from "@/lib/document-ai";
import { buildUserContext } from "@/lib/ai-context";
import { useAuth } from "@/lib/auth";
import { useSpeechInput } from "@/hooks/use-speech-input";
import { useSpeechOutput } from "@/hooks/use-speech-output";
import { listProperties } from "@/lib/properties";
import { looksLikeReminderRequest, parseReminderRequest, addReminder } from "@/lib/reminders";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { MarkdownLite } from "@/components/MarkdownLite";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  destination?: string | null;
};

// Floating, site-wide chat that actually answers questions (via the same
// Gemini-backed answer engine used in document-review's "Ask AI" modal), with a
// "Continue to X" link from route-intent attached to each answer. A signed-in
// user's own properties/protests are included as context, and prior turns in
// this conversation are folded into that same context string so follow-up
// questions ("what about the second one?") resolve correctly — there's no
// separate multi-turn API, ask-about-document just sees the running transcript.
export function AskAiWidget() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Voice input — fills the box as you speak; you still press Send.
  const speech = useSpeechInput(setQuery);
  // Read the answer aloud. On when the toggle is on, or (either way) when
  // the question was just asked by voice — so a spoken question gets a
  // spoken answer without a separate opt-in.
  const tts = useSpeechOutput();
  const askedByVoice = useRef(false);
  function maybeSpeak(text: string) {
    if (tts.enabled || askedByVoice.current) tts.speak(text);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, asking]);

  function reset() {
    setQuery("");
    setMessages([]);
    setAsking(false);
  }

  function close() {
    setOpen(false);
    reset();
    tts.cancel();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || asking) return;
    setQuery("");
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setAsking(true);
    try {
      // "remind me to …" / "save this date" → create a real reminder that
      // shows on the Calendar, instead of just answering. Only spends the
      // parse call when the message actually looks like one.
      if (user && looksLikeReminderRequest(q)) {
        try {
          const props = await listProperties(user.id).catch(() => []);
          const parsed = await parseReminderRequest(
            q,
            props.map((p) => ({ id: p.id, address: p.address })),
          );
          if (parsed.isReminder && parsed.remindOn) {
            await addReminder(user.id, {
              remindOn: parsed.remindOn,
              note: parsed.note || q,
              propertyId: parsed.propertyId,
              source: "assistant",
            });
            const when = new Date(`${parsed.remindOn}T00:00:00`).toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            });
            {
              const line = `Saved a reminder for ${when}: ${parsed.note || q}. It's on your Calendar.`;
              setMessages((prev) => [
                ...prev,
                { role: "assistant", text: line, destination: "/dashboard/calendar" },
              ]);
              maybeSpeak(line);
            }
            return;
          }
          if (parsed.isReminder && !parsed.remindOn) {
            const line = "I can save that reminder — what date should it be for?";
            setMessages((prev) => [...prev, { role: "assistant", text: line }]);
            maybeSpeak(line);
            return;
          }
        } catch {
          // Parsing/saving failed — fall through to a normal answer.
        }
      }

      const accountContext = user ? await buildUserContext(user.id).catch(() => "") : "";
      const transcript = messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
        .join("\n");
      const context = [accountContext, transcript].filter(Boolean).join("\n\n") || undefined;

      const [answerRes, routeRes] = await Promise.allSettled([
        askAboutDocument({ question: q, context }),
        askRouter(q),
      ]);
      const answer =
        answerRes.status === "fulfilled"
          ? answerRes.value.answer
          : "Sorry, I couldn't process that. Please try again.";
      const destination = routeRes.status === "fulfilled" ? routeRes.value.destination : null;
      setMessages((prev) => [...prev, { role: "assistant", text: answer, destination }]);
      maybeSpeak(answer);
    } finally {
      setAsking(false);
      askedByVoice.current = false;
    }
  }

  return (
    <div className="print:hidden fixed bottom-5 right-5 z-40">
      {open && (
        <div className="mb-3 w-96 max-w-[calc(100vw-2.5rem)] card-elev p-4 shadow-lg flex flex-col">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-sm">
              <Sparkles className="h-4 w-4 text-accent" />
              Ask AI
            </div>
            <button
              onClick={close}
              aria-label="Close Ask AI"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {messages.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Ask about protests, BPP, deadlines, or payments — I'll answer and point you to the
              right place.
            </p>
          )}

          {messages.length > 0 && (
            <div ref={scrollRef} className="mt-3 max-h-80 overflow-y-auto grid gap-2 pr-1">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={i}
                    className="ml-auto max-w-[85%] rounded-md bg-accent text-accent-foreground px-3 py-2 text-sm"
                  >
                    {m.text}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="mr-auto max-w-[90%] rounded-md bg-secondary/50 px-3 py-2 text-sm"
                  >
                    <MarkdownLite text={m.text} />
                    {m.destination && (
                      <Link
                        to={m.destination}
                        onClick={close}
                        className="btn-primary btn-primary-hover mt-2 inline-flex text-xs py-1.5"
                      >
                        Continue to this page
                      </Link>
                    )}
                  </div>
                ),
              )}
              {asking && (
                <div className="mr-auto rounded-md bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
                  AI is thinking…
                </div>
              )}
            </div>
          )}

          <form onSubmit={submit} className="mt-3 flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                askedByVoice.current = false;
              }}
              placeholder={
                speech.listening
                  ? "Listening…"
                  : messages.length === 0
                    ? "Describe the situation…"
                    : "Ask a follow-up…"
              }
              disabled={asking}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the input only mounts when the user opens this on-demand chat panel, so focusing it is expected, not a surprise focus jump.
              autoFocus
              className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
            />
            {tts.supported && (
              <button
                type="button"
                onClick={() => {
                  if (tts.enabled || tts.speaking) {
                    tts.setEnabled(false);
                  } else {
                    tts.setEnabled(true);
                  }
                }}
                aria-label={tts.enabled ? "Turn off read-aloud" : "Read answers aloud"}
                title={tts.enabled ? "Read-aloud on" : "Read answers aloud"}
                className={`rounded-md px-2.5 py-1.5 transition-colors ${
                  tts.enabled
                    ? "bg-accent/15 text-accent"
                    : "border border-input text-muted-foreground hover:text-foreground"
                } ${tts.speaking ? "animate-pulse" : ""}`}
              >
                {tts.enabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
            )}
            {speech.supported && (
              <button
                type="button"
                onClick={() => {
                  if (!speech.listening) askedByVoice.current = true;
                  speech.toggle();
                }}
                disabled={asking}
                aria-label={speech.listening ? "Stop listening" : "Speak your question"}
                title={speech.listening ? "Stop listening" : "Speak your question"}
                className={`rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50 ${
                  speech.listening
                    ? "bg-destructive/15 text-destructive animate-pulse"
                    : "border border-input text-muted-foreground hover:text-foreground"
                }`}
              >
                <Mic className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              disabled={asking || !query.trim()}
              aria-label="Send"
              className="btn-accent px-2.5 py-1.5 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close Ask AI" : "Open Ask AI"}
            className="grid h-14 w-14 place-items-center rounded-full bg-accent text-accent-foreground shadow-lg transition-all hover:opacity-90 hover:scale-105 active:scale-95"
          >
            {open ? <X className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
          </button>
        </TooltipTrigger>
        {!open && <TooltipContent side="left">Ask AI anything</TooltipContent>}
      </Tooltip>
    </div>
  );
}
