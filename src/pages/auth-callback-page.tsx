import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "@workos-inc/authkit-react";
import { Loader2 } from "lucide-react";

export function AuthCallbackPage() {
  const { isLoading, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading) return;

    if (user) {
      navigate("/app", { replace: true });
      return;
    }

    const params = new URLSearchParams(location.search);
    const authError =
      params.get("error_description") ||
      params.get("error") ||
      "Sign-in did not complete. Please try again.";

    navigate("/", {
      replace: true,
      state: { authError },
    });
  }, [isLoading, location.search, user, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-page">
      <div className="flex flex-col items-center gap-4 text-ink-muted">
        <Loader2 size={32} className="animate-spin text-accent" />
        <p className="text-sm font-display">Signing you in...</p>
      </div>
    </div>
  );
}
