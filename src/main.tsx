import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { PlatformProvider } from "@/platform/platform";
import { queryClient } from "@/lib/query-persist";
import { desktopPlatform } from "./desktop/platform";
import { DesktopAuthProvider } from "./desktop/desktop-auth-provider";
import "./index.css";

// The desktop app shares the web app's IndexedDB-persisted query cache, so a
// launch renders the last-known notes immediately instead of waiting on the
// network. Authentication is owned by the Electron main process (see
// electron/auth.cjs); DesktopAuthProvider mirrors it over IPC.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlatformProvider platform={desktopPlatform}>
      <DesktopAuthProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </DesktopAuthProvider>
    </PlatformProvider>
  </StrictMode>,
);
