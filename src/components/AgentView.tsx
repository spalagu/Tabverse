import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../backend";
import type { AgentHandle } from "../backend/types";
import type { SessionEvent } from "../agent/events";
import { buildTranscript, isAnswering } from "../agent/transcript";
import { runLogin, type LoginState } from "../agent/login";
import { useStore, type Tab } from "../state/store";
import { errorText } from "../strings/errors";
import {
  AgentWorkspacePane,
  type AgentSignInState,
} from "@tabverse/workbench/agent-workspace-pane";

/**
 * The agent tab.
 *
 * Three things and no more: the conversation, the approval prompts, and the
 * composer. Files and commands are not shown here — a tool call that touched a
 * file opens a real files tab, and that is the whole reason `location` rides
 * along on every event. Rebuilding an editor inside this pane would duplicate a
 * tab Tabverse already has.
 *
 * The session lives in Rust, one per tab, and reaches us as a stream of events.
 * Everything rendered below is a pure fold of that stream (`buildTranscript`),
 * which is what will let a remote viewer replay the same log and land on the
 * same screen.
 */
export function AgentView({ tab, active }: { tab: Tab; active: boolean }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  // Only covers the gap between sending and the first event coming back;
  // after that the stream itself says whether the agent is working.
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The folder actually in use, which is not always tab.cwd: an older tab may
  // carry none and fall back. The user needs to see the one that is real.
  const [cwd, setCwd] = useState<string | null>(tab.cwd ?? null);
  // Sharing this tab is not this pane's business: the sidebar share button
  // and the unified ShareDialog drive it, and its state lives on tab.share
  // exactly as a terminal's does.
  // Whether the provider is signed in, and the sign-in in progress if any.
  // Asked once here rather than announced by the session, so there is exactly
  // one place that says which provider is in use.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [login, setLogin] = useState<LoginState>({ phase: "idle" });

  useEffect(() => {
    void backend.agentLogin.status().then(setSignedIn);
  }, []);

  const signIn = useCallback(async () => {
    const finished = await runLogin(backend.agentLogin, (state) => {
      setLogin(state);
      // The whole point of signing in from inside a terminal that has a
      // browser: the authorisation page opens in a tab of ours rather than
      // sending the user out to whatever their default browser is, and the
      // redirect comes back to a listener the host already bound.
      if (state.phase === "waiting") {
        useStore.getState().addTab({ type: "browser", url: state.login.url });
      }
    });
    if (finished.phase === "done") setSignedIn(true);
  }, []);

  const signOut = useCallback(async () => {
    await backend.agentLogin.logout();
    setSignedIn(false);
    setLogin({ phase: "idle" });
  }, []);
  const agentRef = useRef<AgentHandle | null>(null);

  const transcript = useMemo(() => buildTranscript(events), [events]);
  const busy = sent || isAnswering(transcript);

  // The archive scan reads this off the tab, so it has to leave the component.
  // Without it a tab that is mid-run looks idle to the sweeper and gets shelved
  // underneath the work — the pane is the runtime, so that kills the turn.
  const setTabBusy = useStore((s) => s.setTabBusy);
  const revealPath = useStore((s) => s.revealPath);
  const showCommand = useStore((s) => s.showCommand);
  useEffect(() => {
    setTabBusy(tab.id, busy);
    // Cleared on the way out as well: a tab closed mid-run would otherwise
    // leave `busy` set forever, and nothing would ever shelve it again.
    return () => setTabBusy(tab.id, false);
  }, [busy, tab.id, setTabBusy]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      try {
        const resolved = tab.cwd ?? (await backend.homeDir());
        if (!disposed) setCwd(resolved);
        const agent = await backend.createAgent({ cwd: resolved, sessionId: tab.id });
        if (disposed) {
          void agent.close();
          return;
        }
        agentRef.current = agent;
        unsubscribe = agent.onEvent((event) => {
          setEvents((prev) => [...prev, event]);
          // From here the transcript answers the question; the local flag only
          // existed to cover the wait for this first event.
          if (event.type === "turn_started") setSent(false);
        });
      } catch (e) {
        if (!disposed) setError(errorText(e));
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
      // Closing the session is what ends its thread; leaving it would leak one
      // per tab the user opens and closes.
      void agentRef.current?.close();
      agentRef.current = null;
    };
  }, [tab.cwd, tab.id]);


  const prompt = useCallback((text: string): boolean => {
    const agent = agentRef.current;
    if (!text || !agent || busy) return false;
    setSent(true);
    void agent.prompt(text).catch((cause) => {
      setError(errorText(cause));
      setSent(false);
    });
    return true;
  }, [busy]);

  const answer = useCallback((callId: string, allow: boolean) => {
    const agent = agentRef.current;
    if (!agent) return;
    void agent.answer(callId, allow).catch((cause) => {
      setError(errorText(cause));
    });
  }, []);

  const stop = useCallback(() => {
    void agentRef.current?.cancel().catch((cause) => {
      setError(errorText(cause));
    });
  }, []);

  if (!active && events.length === 0) return null;

  const signInState: AgentSignInState =
    signedIn === null
      ? { phase: "checking" }
      : signedIn
        ? { phase: "signed-in" }
        : login.phase === "waiting"
          ? { phase: "waiting", url: login.login.url }
          : login.phase === "failed"
            ? { phase: "failed", reason: login.reason }
            : { phase: "signed-out" };

  return (
    <AgentWorkspacePane
      transcript={transcript}
      title={tab.title}
      cwd={cwd}
      busy={busy}
      error={error}
      signIn={signInState}
      onReveal={revealPath}
      onCommand={showCommand}
      onPrompt={prompt}
      onAnswer={answer}
      onStop={stop}
      onSignIn={() => void signIn()}
      onSignOut={() => void signOut()}
    />
  );
}
