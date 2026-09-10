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

// The answers are MarkdownLite — strip the markup so it isn't read aloud
// literally ("star star", "dash", pipes, backticks).
function plainForSpeech(md: string): string {
  return (md ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/[#>]/g, "")
    .replace(/\s+/g, " ")
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
