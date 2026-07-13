import { useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { setTokenProvider } from "@/api/client";
import { JotyAuthProvider, type JotyUser } from "@/auth/joty-auth";
import { getSafeAuthReturnTo } from "@/lib/auth-return";

export function DesktopAuthProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();

  setTokenProvider(async () => (await auth.getAccessToken()) || "");
  useEffect(() => () => setTokenProvider(null), []);

  const user: JotyUser | null = auth.user
    ? {
        id: auth.user.id,
        email: auth.user.email,
        firstName: auth.user.firstName,
        lastName: auth.user.lastName,
        profilePictureUrl: auth.user.profilePictureUrl,
      }
    : null;

  const value = {
    user,
    isLoading: auth.isLoading,
    signIn(returnTo?: string) {
      const safeReturnTo = getSafeAuthReturnTo(returnTo);
      return auth.signIn(safeReturnTo ? { state: { returnTo: safeReturnTo } } : {});
    },
    signOut: auth.signOut,
  };

  return <JotyAuthProvider value={value}>{children}</JotyAuthProvider>;
}
