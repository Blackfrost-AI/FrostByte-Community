; Registry identity for the shipped FrostByte app. ProgIDs, RegisteredApplications
; entries, capabilities and executable paths are defined once here.
!define FROSTBYTE_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"
!define FROSTBYTE_TORRENT_PROGID "FrostByte.Torrent"
!define FROSTBYTE_MAGNET_PROGID "FrostByte.Magnet"
!define FROSTBYTE_PROTOCOL_PROGID "FrostByte.Protocol"
!define FROSTBYTE_APPLICATIONS_KEY "Software\Classes\Applications\FrostByte.exe"
!define FROSTBYTE_CAPABILITIES_ROOT "Software\FrostByte"
!define FROSTBYTE_REGISTERED_NAME "FrostByte"
!define FROSTBYTE_FRIENDLY_NAME "FrostByte"

; Per-user associations. Existing torrent/magnet defaults and UserChoice remain intact.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_TORRENT_PROGID}" "" "${FROSTBYTE_FRIENDLY_NAME} torrent"
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_TORRENT_PROGID}\DefaultIcon" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_TORRENT_PROGID}\shell\open\command" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegNone HKCU "Software\Classes\.torrent\OpenWithProgids" "${FROSTBYTE_TORRENT_PROGID}"
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_MAGNET_PROGID}" "" "URL:${FROSTBYTE_FRIENDLY_NAME} Magnet"
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_MAGNET_PROGID}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_MAGNET_PROGID}\DefaultIcon" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_MAGNET_PROGID}\shell\open\command" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_PROTOCOL_PROGID}" "" "URL:${FROSTBYTE_FRIENDLY_NAME} Sign-In"
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_PROTOCOL_PROGID}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_PROTOCOL_PROGID}\DefaultIcon" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\${FROSTBYTE_PROTOCOL_PROGID}\shell\open\command" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\frostbyte" "" "URL:${FROSTBYTE_FRIENDLY_NAME} Sign-In"
  WriteRegStr HKCU "Software\Classes\frostbyte" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\frostbyte\DefaultIcon" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\frostbyte\shell\open\command" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegStr HKCU "${FROSTBYTE_APPLICATIONS_KEY}" "FriendlyAppName" "${FROSTBYTE_FRIENDLY_NAME}"
  WriteRegStr HKCU "${FROSTBYTE_APPLICATIONS_KEY}\SupportedTypes" ".torrent" ""
  WriteRegStr HKCU "${FROSTBYTE_APPLICATIONS_KEY}\shell\open\command" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities" "ApplicationName" "${FROSTBYTE_FRIENDLY_NAME}"
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities" "ApplicationDescription" "Review and download torrents and model files."
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities" "ApplicationIcon" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities\FileAssociations" ".torrent" "${FROSTBYTE_TORRENT_PROGID}"
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities\URLAssociations" "magnet" "${FROSTBYTE_MAGNET_PROGID}"
  WriteRegStr HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities\URLAssociations" "frostbyte" "${FROSTBYTE_PROTOCOL_PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "${FROSTBYTE_REGISTERED_NAME}" "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities"

  ; Supply a fallback only when neither the merged registry nor Windows' chosen
  ; default identifies a handler. Never edit the protected UserChoice hash.
  ReadRegStr $0 HKCR ".torrent" ""
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.torrent\UserChoice" "ProgId"
  ${If} $0 == ""
  ${AndIf} $1 == ""
    WriteRegStr HKCU "Software\Classes\.torrent" "" "${FROSTBYTE_TORRENT_PROGID}"
  ${EndIf}
  ReadRegStr $0 HKCR "magnet\shell\open\command" ""
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\Shell\Associations\UrlAssociations\magnet\UserChoice" "ProgId"
  ${If} $0 == ""
  ${AndIf} $1 == ""
    WriteRegStr HKCU "Software\Classes\magnet" "" "URL:${FROSTBYTE_FRIENDLY_NAME} Magnet"
    WriteRegStr HKCU "Software\Classes\magnet" "URL Protocol" ""
    WriteRegStr HKCU "Software\Classes\magnet\DefaultIcon" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\",0'
    WriteRegStr HKCU "Software\Classes\magnet\shell\open\command" "" '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; Remove only entries still pointing at this installation. A newer install or
  ; a default subsequently chosen by the user must survive this uninstaller.
  ReadRegStr $0 HKCU "Software\Classes\${FROSTBYTE_TORRENT_PROGID}\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    ReadRegStr $1 HKCU "Software\Classes\.torrent" ""
    ${If} $1 == "${FROSTBYTE_TORRENT_PROGID}"
      DeleteRegValue HKCU "Software\Classes\.torrent" ""
    ${EndIf}
    DeleteRegValue HKCU "Software\Classes\.torrent\OpenWithProgids" "${FROSTBYTE_TORRENT_PROGID}"
    DeleteRegKey HKCU "Software\Classes\${FROSTBYTE_TORRENT_PROGID}"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\${FROSTBYTE_MAGNET_PROGID}\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\${FROSTBYTE_MAGNET_PROGID}"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\${FROSTBYTE_PROTOCOL_PROGID}\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey HKCU "Software\Classes\${FROSTBYTE_PROTOCOL_PROGID}"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\frostbyte\shell\open\command" ""
  ReadRegStr $1 HKCU "Software\Classes\frostbyte" ""
  ${If} $0 == '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  ${AndIf} $1 == "URL:${FROSTBYTE_FRIENDLY_NAME} Sign-In"
    DeleteRegKey HKCU "Software\Classes\frostbyte"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\magnet\shell\open\command" ""
  ReadRegStr $1 HKCU "Software\Classes\magnet" ""
  ${If} $0 == '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
  ${AndIf} $1 == "URL:${FROSTBYTE_FRIENDLY_NAME} Magnet"
    DeleteRegKey HKCU "Software\Classes\magnet"
  ${EndIf}
  ReadRegStr $0 HKCU "${FROSTBYTE_APPLICATIONS_KEY}\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${FROSTBYTE_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey HKCU "${FROSTBYTE_APPLICATIONS_KEY}"
  ${EndIf}
  ReadRegStr $0 HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities" "InstallPath"
  ${If} $0 == "$INSTDIR"
    ReadRegStr $1 HKCU "Software\RegisteredApplications" "${FROSTBYTE_REGISTERED_NAME}"
    ${If} $1 == "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities"
      DeleteRegValue HKCU "Software\RegisteredApplications" "${FROSTBYTE_REGISTERED_NAME}"
    ${EndIf}
    DeleteRegKey HKCU "${FROSTBYTE_CAPABILITIES_ROOT}\Capabilities"
    DeleteRegKey /ifempty HKCU "${FROSTBYTE_CAPABILITIES_ROOT}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
