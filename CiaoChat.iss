#define AppName "CiaoChat"
#define AppVersion "1.0.0"
#define AppPublisher "CiaoChat"
#define AppExeName "CiaoChat.exe"

[Setup]
AppId={{6ECF1D39-53B2-4D1A-9A0C-7A6E8C7D5B40}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=dist
OutputBaseFilename=CiaoChat-Setup
SetupIconFile=
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "dist\CiaoChat.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"
