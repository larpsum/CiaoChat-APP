#define AppName "CiaoChat"
#define AppVersion "1.0.0"
#define AppPublisher "CiaoChat"
#define AppExeName "CiaoChat.exe"

[Setup]
AppId={{7FD2E40A-64C3-4E5B-8B1D-8A9F0C6E4D51}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=dist
OutputBaseFilename=CiaoChat-Client-Setup
SetupIconFile=
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest

[Files]
Source: "dist\CiaoChat.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"
