import { useAuth } from "@workos-inc/authkit-react";
import { useLocation } from "react-router";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  Feather,
  Zap,
  Search,
  Pin,
  ArrowRight,
  Sun,
  Moon,
} from "lucide-react";
import { useTheme } from "@/hooks/use-theme";

type LocationState = {
  authError?: string;
};

export function LandingPage() {
  const { signIn } = useAuth();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const authError = (location.state as LocationState | null)?.authError;

  return (
    <div className="min-h-screen bg-page flex flex-col relative paper-texture">
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-5 max-w-6xl w-full mx-auto relative z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-accent rounded-sm flex items-center justify-center">
            <Feather size={18} className="text-white" />
          </div>
          <span className="text-xl sm:text-2xl font-display font-bold tracking-tight text-ink">
            Jotly
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-sm hover:bg-hover text-ink-muted hover:text-ink transition-colors cursor-pointer"
          >
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <Button variant="primary" size="sm" className="sm:hidden" onClick={() => signIn()}>
            Sign in
          </Button>
          <Button variant="primary" size="md" className="hidden sm:inline-flex" onClick={() => signIn()}>
            Sign in
            <ArrowRight size={16} />
          </Button>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-12 relative z-10">
        <div className="max-w-3xl text-center">
          {/* Accent line */}
          <div className="w-12 h-1 bg-accent mx-auto mb-6 sm:mb-8" />

          <h1 className="text-4xl sm:text-5xl md:text-7xl font-display font-extrabold tracking-tight text-ink leading-[1.1] sm:leading-[1.05]">
            Notes that
            <br />
            keep up with
            <br />
            <span className="text-accent">your brain</span>
          </h1>

          {authError && (
            <div className="mt-6 mx-auto max-w-lg flex items-start gap-2 rounded-sm border border-warning/30 bg-warning/10 px-3 py-2 text-left text-sm text-ink-secondary">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-warning" />
              <span>{authError}</span>
            </div>
          )}

          <p className="mt-6 sm:mt-8 text-base sm:text-lg text-ink-secondary max-w-lg mx-auto leading-relaxed">
            A fast, keyboard-first notes app for power users who end up with 30
            tabs open. Search, pin, switch, and write — without reaching for the
            mouse.
          </p>

          <div className="mt-8 sm:mt-10 flex items-center justify-center gap-4">
            <Button variant="primary" size="lg" onClick={() => signIn()}>
              Get started free
              <ArrowRight size={18} />
            </Button>
          </div>

          {/* Keyboard shortcut hints — hidden on mobile */}
          <div className="mt-12 hidden sm:flex items-center justify-center gap-6 text-sm text-ink-muted">
            <span className="flex items-center gap-1.5">
              <kbd className="font-mono text-xs bg-panel-alt border border-border-strong px-1.5 py-0.5 rounded-sm">
                Ctrl+K
              </kbd>
              quick open
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="font-mono text-xs bg-panel-alt border border-border-strong px-1.5 py-0.5 rounded-sm">
                Ctrl+N
              </kbd>
              new note
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="font-mono text-xs bg-panel-alt border border-border-strong px-1.5 py-0.5 rounded-sm">
                Ctrl+P
              </kbd>
              pin note
            </span>
          </div>

          {/* Features */}
          <div className="mt-16 sm:mt-24 grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-10 text-left">
            <Feature
              icon={<Zap size={22} />}
              title="Blazing fast"
              description="Instant startup, zero lag typing. Your notes should never slow you down."
            />
            <Feature
              icon={<Search size={22} />}
              title="Quick switch"
              description="Ctrl+K to search and jump to any note. Like VS Code, but for your thoughts."
            />
            <Feature
              icon={<Pin size={22} />}
              title="Tab control"
              description="Pin important notes, close the rest. Tame the 30-tab chaos."
            />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 sm:py-8 text-center text-sm text-ink-muted relative z-10">
        <div className="w-8 h-px bg-border-strong mx-auto mb-4" />
        Built with care. Your notes, your data.
      </footer>
    </div>
  );
}

function Feature({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="group">
      <div className="w-12 h-12 rounded-sm bg-accent-soft text-accent flex items-center justify-center mb-4 group-hover:bg-accent group-hover:text-white transition-all">
        {icon}
      </div>
      <h3 className="text-base font-display font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-sm text-ink-secondary leading-relaxed">
        {description}
      </p>
    </div>
  );
}
