Gata — tutorialul actualizat, cu încă 2 lucruri esențiale:

Permisiuni ca operatorul să poată da Start/Stop din tray (fără admin)

Restart ALL: în varianta curentă, dacă nu e implementat cu “wait STOPPED”, poate da eroarea 1056; workaround-ul corect în tutorial este Stop ALL → așteaptă 3–5 sec → Start ALL (până facem patch în tray.js).

✅ Tutorial final (Windows 11) — Agent/Case/Pos ca servicii + Tray pentru operator
1️⃣ Instalează Node.js LTS

✅ Add to PATH

Verifică:

node -v
npm -v

2️⃣ Copiază proiectul în C:\agent

Structură:

C:\agent\
  agent\
    agent.js
    .env
  case\
    case.js
  pos\
    pos.js
  tray.js
  package.json
  node_modules\


Creează folder log:

mkdir C:\agent\logs

3️⃣ Instalează dependențele
cd C:\agent
npm install

4️⃣ Instalează NSSM

Extrage:

C:\nssm\win64\nssm.exe

🟢 SERVICII (Agent / Case / Pos)

⚠️ Regulă obligatorie: Startup directory trebuie să fie folderul corect

AgentService → C:\agent\agent

CaseService → C:\agent\case

PosService → C:\agent\pos

Altfel .env nu se încarcă și agentul cade pe fallback (ex: localhost).

5️⃣ AgentService

CMD Administrator:

C:\nssm\win64\nssm.exe install AgentService


Application

Path: C:\Program Files\nodejs\node.exe

Startup directory: C:\agent\agent

Arguments: agent.js

I/O

Stdout: C:\agent\logs\agent-out.log

Stderr: C:\agent\logs\agent-error.log

6️⃣ CaseService
C:\nssm\win64\nssm.exe install CaseService


Application

Path: C:\Program Files\nodejs\node.exe

Startup directory: C:\agent\case

Arguments: case.js

I/O

Stdout: C:\agent\logs\case-out.log

Stderr: C:\agent\logs\case-error.log

7️⃣ PosService
C:\nssm\win64\nssm.exe install PosService


Application

Path: C:\Program Files\nodejs\node.exe

Startup directory: C:\agent\pos

Arguments: pos.js

I/O

Stdout: C:\agent\logs\pos-out.log

Stderr: C:\agent\logs\pos-error.log

8️⃣ Auto-start servicii
sc config AgentService start= auto
sc config CaseService start= auto
sc config PosService start= auto

9️⃣ Pornește serviciile (doar admin)
sc start AgentService
sc start CaseService
sc start PosService


Verificare:

sc query AgentService

🟣 TRAY (Electron) — pornește ascuns, pentru toți userii
🔟 Creează C:\agent\tray-start.vbs
Option Explicit

Dim sh, cmd
Set sh = CreateObject("WScript.Shell")

cmd = "cmd.exe /c """"C:\agent\node_modules\.bin\electron.cmd"" ""C:\agent\tray.js"""" "
sh.Run cmd, 0, False


Test:
Win+R:

wscript C:\agent\tray-start.vbs

1️⃣1️⃣ Task Scheduler la logon (pentru orice user)

CMD Administrator:

schtasks /delete /tn "AgentTray" /f

schtasks /create /tn "AgentTray" ^
/tr "\"wscript.exe\" \"C:\agent\tray-start.vbs\"" ^
/sc onlogon ^
/rl limited ^
/f

🟠 PERMISIUNI (operatorul trebuie să poată Start/Stop din tray)

Fără pasul ăsta, tray-ul va da:

[SC] OpenService FAILED 5 (Access denied)

✅ Rulezi o singură dată ca Administrator (PowerShell Admin):

$services = @("AgentService","CaseService","PosService")
$ace = "(A;;CCLCSWRPWPDTLOCRRC;;;BU)"   # Builtin Users

foreach ($svc in $services) {
  $cur = (sc.exe sdshow $svc | Out-String).Trim()
  if (-not $cur) { Write-Host ("Nu pot citi SDDL pentru " + $svc); continue }

  if ($cur -like "*;;;BU)*") {
    Write-Host ("${svc}: are deja ACE pentru Users")
    continue
  }

  if ($cur -match "S:") { $new = $cur -replace "S:", ($ace + "S:") }
  else { $new = $cur + $ace }

  sc.exe sdset $svc $new | Out-Null
  Write-Host ("${svc}: OK (Users pot start/stop/query)")
}


După asta, operatorul poate folosi butoanele din tray fără admin.