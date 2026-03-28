#define MyAppName "XBurger Local Print Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "XBurger"
#define MyAppExeName "xburger-print-agent.exe"

[Setup]
AppId={{A47C32E7-8A7A-4DAE-B49C-BE9B669F7D0E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\XBurgerPrintAgent
DefaultGroupName=XBurger Print Agent
OutputDir=dist
OutputBaseFilename=XBurgerPrintAgent-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\\BrazilianPortuguese.isl"

[Tasks]
Name: "autostart"; Description: "Iniciar automaticamente com o Windows"; Flags: checkedonce

[Files]
Source: "..\\dist\\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\\XBurger Print Agent"; Filename: "{app}\\{#MyAppExeName}"
Name: "{group}\\Painel do Agente"; Filename: "http://127.0.0.1:18181/ui"
Name: "{group}\\Desinstalar XBurger Print Agent"; Filename: "{uninstallexe}"
Name: "{userstartup}\\XBurger Print Agent"; Filename: "{app}\\{#MyAppExeName}"; Tasks: autostart

[Run]
Filename: "{app}\\{#MyAppExeName}"; Description: "Iniciar agente agora"; Flags: nowait postinstall skipifsilent
Filename: "http://127.0.0.1:18181/ui"; Description: "Abrir painel do agente"; Flags: shellexec postinstall skipifsilent
