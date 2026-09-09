import { useCallback, useEffect, useRef, useState } from "react";

// Thin wrapper around the browser Web Speech API (SpeechRecognition /
// webkitSpeechRecognition) — on-device, free, no backend. Chrome/Edge and
// desktop Safari support it; Firefox does not, so callers should hide the mic
// affordance when `supported` is false rather than showing a dead button.
//
// The transcript is streamed to `onTranscript` as the user speaks
// (interimResults) so the text field fills live; the caller still hits Send
// itself — voice fills the box, it doesn't auto-submit.

type SpeechResultAlternative = { transcript: string };
type SpeechResult = { 0: SpeechResultAlternative; isFinal: boolean; length: number };
type SpeechResultList = { length: number; [i: number]: SpeechResult };
type SpeechRecognitionEventLike = { results: SpeechResultList };

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechInput(onTranscript: (text: string) => void) {
  const [supported] = useState(() => !!getRecognitionCtor());
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    // Tear down any previous instance first.
    recRef.current?.abort();
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      cbRef.current(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      // start() throws if called while already running — ignore.
      setListening(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  useEffect(
    () => () => {
      recRef.current?.abort();
    },
    [],
  );

  return { supported, listening, start, stop, toggle };
}
