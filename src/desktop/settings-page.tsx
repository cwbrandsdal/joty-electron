import { SettingsPage as SharedSettingsPage } from "@/components/settings/settings-page";
import { SettingsSection } from "@/components/settings/settings-sections";
import { NativeSettings } from "./native-settings";
import { UpdatePanel } from "./update-panel";

interface SettingsPageProps {
  onBack: () => void;
  onOpenNote?: (id: string, title: string) => void;
}

/**
 * Desktop settings = the shared web settings surface plus native-only sections
 * (system integration + auto-update) injected at the bottom.
 */
export function SettingsPage({ onBack, onOpenNote }: SettingsPageProps) {
  return (
    <SharedSettingsPage
      onBack={onBack}
      onOpenNote={onOpenNote}
      extraSections={
        <>
          <SettingsSection
            title="Desktop"
            description="System integration for the Joty desktop app."
          >
            <NativeSettings />
          </SettingsSection>
          <SettingsSection title="App updates">
            <UpdatePanel />
          </SettingsSection>
        </>
      }
    />
  );
}
