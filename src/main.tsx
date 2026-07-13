import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthKitProvider } from "@workos-inc/authkit-react";
import App from "@/App";
import { PlatformProvider } from "@/platform/platform";
import { desktopPlatform } from "./desktop/platform";
import { DesktopAuthProvider } from "./desktop/desktop-auth-provider";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID || "";
const redirectUri =
  import.meta.env.VITE_WORKOS_REDIRECT_URI || "http://127.0.0.1:39173/auth/callback";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* devMode is required here (unlike joty-web): the desktop shell serves
        the app from http://127.0.0.1, and AuthKit only persists the session
        in localStorage in devMode. Moving to an app:// scheme + system-browser
        auth would let us drop it — tracked as a follow-up. */}
    <AuthKitProvider clientId={clientId} redirectUri={redirectUri} devMode>
      <DesktopAuthProvider>
        <PlatformProvider platform={desktopPlatform}>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </PlatformProvider>
      </DesktopAuthProvider>
    </AuthKitProvider>
  </StrictMode>,
);
