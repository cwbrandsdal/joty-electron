; Joty's NSIS additions (electron-builder "nsis.include").
;
; Joty appears under "Open with" for text files but never becomes the
; default app for them. electron-builder's own fileAssociations would set
; each extension's default class (APP_ASSOCIATE writes .ext's default value),
; so it is not used on Windows; this writes only Joty's own ProgID, the
; extensions' OpenWithProgids entries and Applications\Joty.exe. Nothing
; another app wrote is changed, and uninstall removes only Joty's entries.

!define JOTY_PROGID "Joty.TextFile"

!macro JotyForEachExtension MACRO
  !insertmacro ${MACRO} "txt"
  !insertmacro ${MACRO} "log"
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "markdown"
  !insertmacro ${MACRO} "json"
  !insertmacro ${MACRO} "jsonc"
  !insertmacro ${MACRO} "csv"
  !insertmacro ${MACRO} "tsv"
  !insertmacro ${MACRO} "xml"
  !insertmacro ${MACRO} "yml"
  !insertmacro ${MACRO} "yaml"
  !insertmacro ${MACRO} "ini"
  !insertmacro ${MACRO} "conf"
  !insertmacro ${MACRO} "cfg"
  !insertmacro ${MACRO} "env"
  !insertmacro ${MACRO} "ps1"
  !insertmacro ${MACRO} "psm1"
  !insertmacro ${MACRO} "sql"
  !insertmacro ${MACRO} "cs"
  !insertmacro ${MACRO} "ts"
  !insertmacro ${MACRO} "js"
  !insertmacro ${MACRO} "py"
  !insertmacro ${MACRO} "sh"
  !insertmacro ${MACRO} "bat"
  !insertmacro ${MACRO} "cmd"
!macroend

!macro JotyAddOpenWith EXT
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${JOTY_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro JotyRemoveOpenWith EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${JOTY_PROGID}"
!macroend

; Joty 1.x made itself the default for these (ProgIDs "Text document" and
; "Markdown document"). Its uninstaller removes those ProgIDs during the
; update, which would leave the extensions pointing at nothing.
!macro JotyForgetLegacyDefault EXT
  Push $0
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${If} $0 == "Text document"
  ${OrIf} $0 == "Markdown document"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  !insertmacro JotyForgetLegacyDefault "txt"
  !insertmacro JotyForgetLegacyDefault "log"
  !insertmacro JotyForgetLegacyDefault "md"
  !insertmacro JotyForgetLegacyDefault "markdown"

  WriteRegStr SHELL_CONTEXT "Software\Classes\${JOTY_PROGID}" "" "Text file"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${JOTY_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${JOTY_PROGID}\shell\open" "" "Open with Joty"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${JOTY_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Joty"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'
  !insertmacro JotyForEachExtension JotyAddOpenWith

  ; SHCNE_ASSOCCHANGED: Explorer re-reads associations.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro JotyForEachExtension JotyRemoveOpenWith
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${JOTY_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
