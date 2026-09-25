import { useEffect, useMemo, useState } from "react";
import { setTokenProvider } from "@/api/client";
import { JotyAuthProvider, type JotyAuthState } from "@/auth/joty-auth";
import { getSafeAuthReturnTo } from "@/lib/auth-return";
import type { DesktopAuthState } from "./electron-api";

const NO_BRIDGE: DesktopAuthState = {
  status: "signed-out",
  user: null,
  error: "The desktop bridge is unavailable; sign-in is not possible in this window.",
};

/**
 * Desktop auth adapter. The Electron main process owns the WorkOS session
 * (tokens never enter the renderer); this provider mirrors its state over IPC
 * and hands the API client a token getter.
 */
export function DesktopAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DesktopAuthState | null>(() =>
    window.joty?.auth ? null : NO_BRIDGE,
  );

  useEffect(() => {
    const bridge = window.joty?.auth;
    if (!bridge) return;

    let cancelled = false;
    // The initial state comes straight from the persisted session, so this
    // resolves without any network round trip.
    void bridge.getState().then((initial) => {
      if (!cancelled) setState(initial);
    });
    const unsubscribe = bridge.onState(setState);

    setTokenProvider(async () => {
      const result = await bridge.getAccessToken();
      if (result.token) return result.token;
      if (result.transient) {
        // Session intact but no usable token right now (offline / WorkOS
        // unreachable). A TypeError is what fetch itself throws when the
        // network is down, so the UI shows the connectivity message.
        throw new TypeError("Can't reach the sign-in service");
      }
      return "";
    });

    return () => {
      cancelled = true;
      unsubscribe();
      setTokenProvider(null);
    };
  }, []);

  const value = useMemo<JotyAuthState>(
    () => ({
      user: state?.user ?? null,
      isLoading: state === null,
      authError: state?.error ?? null,
      signIn(returnTo?: string) {
        return window.joty?.auth?.signIn(getSafeAuthReturnTo(returnTo) ?? "/notes");
      },
      signOut() {
        return window.joty?.auth?.signOut();
      },
    }),
    [state],
  );

  return <JotyAuthProvider value={value}>{children}</JotyAuthProvider>;
}
