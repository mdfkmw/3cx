const { app, Tray, Menu, Notification, dialog } = require("electron");
const { exec, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

// PM2 per-user, fara dependenta de PATH
const PM2 = `"${process.env.APPDATA}\\npm\\pm2.cmd"`;
function pm2Cmd(args) {
  return `${PM2} ${args}`;
}



let tray = null;
const SERVICE_LOGS_DIR = "C:\\agent\\logs";

function notify(title, body) {
  try {
    // Notification e ok pe Win11, dar poate fi dezactivat; nu aruncăm erori.
    new Notification({ title, body }).show();
  } catch (_) { }
}

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

async function doServiceAction(label, cmd) {
  try {
    await runCmd(cmd);
    notify("SERVICE", `${label} ✓`);
  } catch (e) {
    notify("SERVICE ERROR", `${label} ✗`);
    const msg = (e?.stderr || e?.stdout || e?.err?.message || "Unknown error")
      .toString()
      .replace(/"/g, '\\"');
    exec(`cmd /c start cmd.exe /k "echo ${label} FAILED & echo ${msg} & pause"`);
  } finally {
    setTimeout(() => tray?.setContextMenu(buildMenu()), 300);
  }
}



/**
 * Rulează o comandă PM2 fără să deschidă ferestre.
 * Returnează Promise ca să putem face refresh după ce se termină.
 */
function pm2(cmd) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject({ err, stdout, stderr });
        resolve({ stdout, stderr });
      }
    );
  });
}

function getStatus(name) {
  try {
    const out = execSync(`sc query "${name}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).toString();

    if (out.includes("RUNNING")) return "running";
    if (out.includes("PAUSED")) return "running";   // <-- IMPORTANT
    if (out.includes("STOPPED")) return "stopped";
    return "unknown";
  } catch (_) {
    return "unknown";
  }
}



function runPS(ps) {
  // logs LIVE în PowerShell separat (intentional)
  exec(`cmd /c start powershell -NoExit -Command "${ps}"`);
}

function openNotepad(filePath) {
  exec(`notepad "${filePath}"`);
}

async function doAction(label, cmd) {
  try {
    await pm2(cmd);
    notify("PM2", `${label} ✓`);
  } catch (e) {
    notify("PM2 ERROR", `${label} ✗`);
    // pentru debug rapid, deschidem un CMD cu detalii (doar la eroare)
    const msg = (e?.stderr || e?.stdout || e?.err?.message || "Unknown error")
      .toString()
      .replace(/"/g, '\\"');
    exec(`cmd /c start cmd.exe /k "echo ${label} FAILED & echo ${msg} & pause"`);
  } finally {
    // refresh meniu după acțiune
    setTimeout(() => tray?.setContextMenu(buildMenu()), 300);
  }
}

function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8").trim();
  } catch (_) {
    return null;
  }
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              return reject(new Error("HTTP " + res.statusCode));
            }
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function checkForUpdates({ showNoUpdatePopup = false } = {}) {
  try {
    const tokenPath = "C:\\agent\\.update_token";
    const versionPath = "C:\\agent\\version.txt";

    const token = readTextSafe(tokenPath);
    if (!token) return;

    const current = readTextSafe(versionPath) || "0.0.0";

    const url =
      "https://pris-com.ro/agent-updates/update.json?token=" +
      encodeURIComponent(token);

    const meta = await httpsGetJson(url);

    const latest = (meta?.version || "").toString().trim();
    const zip = (meta?.zip || "").toString().trim();
    if (!latest || !zip) return;

    if (latest !== current) {
      try {
        new Notification({
          title: "Update disponibil",
          body: `Versiune noua: ${current} -> ${latest}`,
        }).show();
      } catch (_) { }

      const result = dialog.showMessageBoxSync({
        type: "question",
        buttons: ["Update acum", "Mai tarziu"],
        defaultId: 0,
        cancelId: 1,
        title: "Update disponibil",
        message: "Exista o versiune noua pentru agent.",
        detail:
          `Versiunea curenta: ${current}\n` +
          `Versiunea noua: ${latest}\n\n` +
          `Vrei sa instalezi acum? (se vor reporni serviciile)`,
      });

      if (result === 0) {
        exec(
          `powershell -ExecutionPolicy Bypass -File "C:\\agent\\updater\\update.ps1"`,
          { windowsHide: true },
          (err) => {
            if (err) {
              try {
                dialog.showMessageBoxSync({
                  type: "error",
                  title: "Eroare update",
                  message: "Nu am reusit sa pornesc updater-ul.",
                  detail: String(err),
                });
              } catch (_) { }
            }
          }
        );
      }

      return;
    }

    if (showNoUpdatePopup) {
      dialog.showMessageBoxSync({
        type: "info",
        title: "Update",
        message: `Esti la zi (${current}).`,
      });
    }
  } catch (_) {
    // nu facem nimic daca nu ai net sau serverul nu raspunde
  }
}

function postJSON(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 9000,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on("error", (err) => resolve({ status: 0, body: err.message }));
    req.write(data);
    req.end();
  });
}

async function testFiscal(dev, label) {
  await postJSON(`/nf/open?dev=${dev}`);
  await postJSON(`/nf/text?dev=${dev}`, {
    text: `*** TEST ${label} ***`,
  });
  await postJSON(`/nf/text?dev=${dev}`, {
    text: `Data: ${new Date().toLocaleString()}`,
  });
  await postJSON(`/nf/close?dev=${dev}`);

  new Notification({
    title: "Test fiscal",
    body: `Test trimis pe casa ${label}`,
  }).show();
}



function buildMenu() {
  const sAgent = getStatus("AgentService");
  const sCase = getStatus("CaseService");
  const sPos = getStatus("PosService");


  return Menu.buildFromTemplate([
    { label: `Agent: ${sAgent}`, enabled: false },
    { label: `Case: ${sCase}`, enabled: false },
    { label: `POS: ${sPos}`, enabled: false },

    { type: "separator" },

    {
      label: "Refresh",
      click: () => tray.setContextMenu(buildMenu())
    },
    {
      label: "Check update",
      click: () => checkForUpdates({ showNoUpdatePopup: true })
    },


    { type: "separator" },




    {
      label: "Test Priscom (A)",
      click: () => testFiscal("A", "PRISCOM"),
    },

    {
      label: "Test Autodimas (B)",
      click: () => testFiscal("B", "AUTODIMAS"),
    },

    { type: "separator" },


    {
      label: "Stop ALL",
      click: async () => {
        await doServiceAction("Stop AGENT", `sc stop "AgentService"`);
        await doServiceAction("Stop CASE", `sc stop "CaseService"`);
        await doServiceAction("Stop POS", `sc stop "PosService"`);
      }
    },
    {
      label: "Start ALL",
      click: async () => {
        await doServiceAction("Start AGENT", `sc start "AgentService"`);
        await doServiceAction("Start CASE", `sc start "CaseService"`);
        await doServiceAction("Start POS", `sc start "PosService"`);
      }
    },

    { type: "separator" },

    {
      label: "Start AGENT",
      click: async () => {
        await doServiceAction("Start AGENT", `sc start "AgentService"`);
      }
    },
    {
      label: "Start CASE",
      click: async () => {

        await doServiceAction("Start CASE", `sc start "CaseService"`);
      }
    },
    {
      label: "Start POS",
      click: async () => {

        await doServiceAction("Start POS", `sc start "PosService"`);
      }
    },

    {
      label: "Stop AGENT",
      click: () => doServiceAction("Stop AGENT", `sc stop "AgentService"`)
    },
    {
      label: "Stop CASE",
      click: () => doServiceAction("Stop CASE", `sc stop "CaseService"`)
    },
    {
      label: "Stop POS",
      click: () => doServiceAction("Stop POS", `sc stop "PosService"`)
    },


    { type: "separator" },

    {
      label: "Edit AGENT .env",
      click: () => openNotepad("C:\\agent\\agent\\.env")
    },
    {
      label: "Edit CASE .env",
      click: () => openNotepad("C:\\agent\\case\\.env")
    },
    {
      label: "Edit POS .env",
      click: () => openNotepad("C:\\agent\\pos\\.env")
    },

    { type: "separator" },

    // Logs LIVE (NSSM -> C:\agent\logs)
    {
      label: "Logs Agent",
      click: () =>
        runPS(`Get-Content "${SERVICE_LOGS_DIR}\\agent-out.log" -Tail 200 -Wait`)
    },
    {
      label: "Logs Agent ERROR",
      click: () =>
        runPS(`Get-Content "${SERVICE_LOGS_DIR}\\agent-error.log" -Tail 200 -Wait`)
    },

    {
      label: "Logs Case",
      click: () =>
        runPS(`Get-Content "${SERVICE_LOGS_DIR}\\case-out.log" -Tail 200 -Wait`)
    },
    {
      label: "Logs Case ERROR",
      click: () =>
        runPS(`Get-Content "${SERVICE_LOGS_DIR}\\case-error.log" -Tail 200 -Wait`)
    },

    {
      label: "Logs POS",
      click: () =>
        runPS(`Get-Content "${SERVICE_LOGS_DIR}\\pos-out.log" -Tail 200 -Wait`)
    },
    {
      label: "Logs POS ERROR",
      click: () =>
        runPS(`Get-Content "${SERVICE_LOGS_DIR}\\pos-error.log" -Tail 200 -Wait`)
    },


    { type: "separator" },
    {
      label: "Open Services (services.msc)",
      click: () => exec(`cmd /c start "" services.msc`)
    },


    {
      label: "Exit Tray (keep services)",
      click: () => app.quit()
    },
    {
      label: "Exit Tray + Stop services",
      click: async () => {
        try {
          await runCmd(`sc stop "AgentService"`);
          await runCmd(`sc stop "CaseService"`);
          await runCmd(`sc stop "PosService"`);
        } catch (_) { }
        app.quit();
      }
    },


  ]);
}

app.whenReady().then(() => {
  tray = new Tray(path.join(__dirname, "icon.png"));
  tray.setToolTip("POS si Case de marcat");
  tray.setContextMenu(buildMenu());
  // Check update automat la pornire (dupa 5 secunde)
  setTimeout(() => {
    checkForUpdates({ showNoUpdatePopup: false });
  }, 5000);

  // Check update periodic (o data la 6 ore)
  setInterval(() => {
    checkForUpdates({ showNoUpdatePopup: false });
  }, 6 * 60 * 60 * 1000);


  // Refresh automat la 3 secunde (profi: status mereu actual)
  setInterval(() => {
    try {
      tray.setContextMenu(buildMenu());
    } catch (_) { }
  }, 3000);
});
