import { useCallback, useEffect, useState } from "react";

// Web Speech API text-to-speech (speechSynthesis) — on-device, free, no
// backend, the read-aloud counterpart to useSpeechInput. Chrome / Edge /
// Safari support it; Firefox's support is partial, so callers hide the
// toggle when `supported` is false. The on/off preference is remembered per
// browser (localStorage).

const STORAGE_KEY = "corvus.tts.enabled";

function ttsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

// The answers are MarkdownLite — turn the markup into something that reads
// aloud like a person talking, not "star star", "colon dash dash dash",
// "pipe pipe pipe".
function plainForSpeech(md: string): string {
  const lines = (md ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .split("\n");

  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Markdown table separator row (|---|:--:|) — never spoken.
    if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) continue;
    // A table row: read the cells as a natural phrase, not the pipes.
    if (line.startsWith("|") || (line.includes(" | ") && line.split("|").length > 2)) {
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length > 0) out.push(cells.join(", ") + ".");
      continue;
    }
    // Bullet / numbered list markers → just the text.
    out.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
  }
  return out
    .join(" ")
    .replace(/\s*[|]\s*/g, ", ")
    .replace(/:--+:?|--+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export function useSpeechOutput() {
  const [supported] = useState(ttsSupported);
  const [enabled, setEnabledState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [speaking, setSpeaking] = useState(false);

  const cancel = useCallback(() => {
    if (ttsSupported()) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const setEnabled = useCallback(
    (v: boolean) => {
      setEnabledState(v);
      try {
        localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
      } catch {
        /* private mode / blocked storage — the toggle still works for this session */
      }
      if (!v) cancel();
    },
    [cancel],
  );

  const speak = useCallback((text: string) => {
    if (!ttsSupported()) return;
    const clean = plainForSpeech(text);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean.slice(0, 4000));
    u.lang = "en-US";
    u.rate = 1;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }, []);

  // Stop talking if the component unmounts (widget closed, route change).
  useEffect(
    () => () => {
      if (ttsSupported()) window.speechSynthesis.cancel();
    },
    [],
  );

  return { supported, enabled, setEnabled, speaking, speak, cancel };
}
