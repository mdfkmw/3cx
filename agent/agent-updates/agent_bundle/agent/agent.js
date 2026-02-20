// agent.js
// Agent local care face polling la backend și raportează rezultatele joburilor

require('dotenv').config();

// ← CONFIG (poți schimba doar valorile, nu codul)
const BACKEND_URL = process.env.AGENT_BACKEND_URL || "http://localhost:5000";
const AGENT_KEY = process.env.AGENT_KEY || "AGENT_DE_TEST"; // o să punem ceva real mai târziu
const FISCAL_BASE_URL = "http://127.0.0.1:9000";
const FISCAL_DEVICE_ID = "A"; // sau "B" dacă folosești a doua casă

const FISCAL_OPERATOR = process.env.FISCAL_OPERATOR || "30";
const FISCAL_PASSWORD = process.env.FISCAL_PASSWORD || "0030";
const FISCAL_TILL = process.env.FISCAL_TILL || "1";

const POS_BASE_URL = process.env.POS_BASE_URL || "http://127.0.0.1:9100";


const AGENT_TEST_DELAY_MS = Number(process.env.AGENT_TEST_DELAY_MS || 0);


const { io } = require("socket.io-client");



let pollIntervalMs = 15000; // default, backend poate recomanda altceva
let stopped = false;

// Mic helper de sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Trimite raport pentru un job
async function sendJobReport(jobId, payload) {
  const url = `${BACKEND_URL}/api/agent/jobs/${jobId}/report`;

  console.log(`[AGENT] Trimit raport pentru job #${jobId} → ${url}`);
  console.log("[AGENT] Payload report:", JSON.stringify(payload, null, 2));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  console.log("[AGENT] Răspuns backend la report:", res.status, json);

  if (!res.ok || json.error) {
    throw new Error(json.error || `Report failed with status ${res.status}`);
  }

  return json;
}


async function callFiscal(path, body) {
  const url = `${FISCAL_BASE_URL}${path}?dev=${encodeURIComponent(FISCAL_DEVICE_ID)}`;

  console.log("[AGENT] [FISCAL] POST", url, "body=", body);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  console.log("[AGENT] [FISCAL] response status=", res.status, "body=", data);

  // EROARE dacă:
  // - HTTP nu e 200
  // - body.ok este false sau lipsă
  if (!res.ok || !data || data.ok !== true) {
    // IMPORTANT: mesajul clar pentru agent/UI vine din `message` (când există)
    // iar `error` rămâne cod tehnic.
    const err = new Error(data?.message || data?.error || `FISCAL_HTTP_${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }

  return data;
}



// Aici vom implementa pe rând tipurile de job (POS + casă).
// Deocamdată doar simulăm.
// Aici implementăm tipurile de job (POS + casă).
async function handleJob(job) {
  console.log("[AGENT] job primit:", job);

  // TEST ONLY: folosit doar când setezi AGENT_TEST_DELAY_MS în .env
  if (AGENT_TEST_DELAY_MS > 0) {
    console.log(`[AGENT][TEST] delay ${AGENT_TEST_DELAY_MS}ms before processing job#${job.id}`);
    await sleep(AGENT_TEST_DELAY_MS);
  }


  if (job.payload) {
    console.log("[AGENT] payload job:", JSON.stringify(job.payload, null, 2));
  }

  const payload = job.payload || {};
  const amount = Number(payload.amount || 0);
  const itemName = String(payload.description || "BILET").slice(0, 48);
  const devLabel = String(payload.dev || "A");
  const posUniqueId = payload.pos_unique_id || payload.unique_id || payload.payment_id || null;

  // 1) CASH + bon fiscal (fără POS)
  if (job.job_type === "cash_receipt_only") {
    const report = {
      success: false,
      pos_ok: true, // POS nu e implicat aici
      fiscal_ok: false,
      error_message: null,
      result: {
        pos: { ok: true },
        fiscal: { ok: false },
      },
    };

    try {
      console.log("[AGENT] [FLOW] fiscal/open (cash)");
      await callFiscal("/fiscal/open", {
        operator: FISCAL_OPERATOR,
        password: FISCAL_PASSWORD,
        till: FISCAL_TILL,
      });

      console.log("[AGENT] [FLOW] fiscal/sale (cash)");
      await callFiscal("/fiscal/sale", {
        name: itemName,
        tax: "1",
        price: amount,
        quantity: 1,
        department: "1",
        unit: "BUC",
      });

      console.log("[AGENT] [FLOW] fiscal/pay CASH");
      await callFiscal("/fiscal/pay", {
        mode: "CASH",
        amount,
      });

      console.log("[AGENT] [FLOW] fiscal/close (cash)");
      await callFiscal("/fiscal/close", {});

      report.success = true;
      report.fiscal_ok = true;
      report.result.fiscal.ok = true;
      report.error_message = null;
    } catch (e) {
      console.error("[AGENT] Eroare în fluxul cash_receipt_only:", e);
      report.error_message = String(e.message || "FISCAL_ERROR");
      report.result.fiscal.ok = false;
    }

    try {
      console.log("[DBG] ABOUT TO REPORT job#", job.id, "type=", job.job_type, "success=", report.success, "err=", report.error_message);
      await sendJobReport(job.id, report);
      console.log("[DBG] REPORT SENT job#", job.id);

      console.log(`[AGENT] Report trimis pentru job #${job.id}`);
    } catch (err) {
      console.error(
        `[AGENT] Eroare la trimiterea report-ului pentru job #${job.id}:`,
        err
      );
    }

    return;
  }

  // 2) CARD + POS + bon fiscal (mod CASH pe casa, ca workaround)
  // 2) CARD + POS + bon fiscal
if (job.job_type === "card_and_receipt") {

  const report = {
    success: false,
    pos_ok: false,
    fiscal_ok: false,
    error_message: null,
    result: {
      pos: { ok: false },
      fiscal: { ok: false },
    },
  };

  try {
    // ---------- POS ----------
    const posUrl = `${POS_BASE_URL}/pos/sale?dev=${encodeURIComponent(devLabel)}`;
    const posBody = {
      amount: amount.toFixed(2),
      currency: payload.currency || "RON",
      description: itemName,
      uniqueId: posUniqueId,
    };

    console.log("[AGENT] [POS] SALE", posUrl, "body=", posBody);

    // IMPORTANT:
    // - NU folosim timeout scurt aici, pentru că tranzacția reală pe POS durează (card + PIN etc.)
    // - Timeout-ul de aici este doar o LIMITĂ MAXIMĂ de așteptare, ca să nu rămână jobul blocat.
    //   Dacă POS returnează refuz/eroare mai repede, primim imediat răspunsul și raportăm eroarea instant.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 180000); // 3 minute

    const posRes = await fetch(posUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(posBody),
      signal: controller.signal,
    });

    clearTimeout(t);

    const posData = await posRes.json().catch(() => ({}));
    console.log("[AGENT] [POS] response", posRes.status, posData);

    const approved =
      posRes.ok &&
      (posData?.ok === true ||
        posData?.approved === true ||
        String(posData?.status || "").toLowerCase() === "approved");

    if (!approved) {
      throw new Error(
        posData?.message ||
        posData?.error ||
        `POS_HTTP_${posRes.status}`
      );
    }

    report.pos_ok = true;
    report.result.pos.ok = true;
    report.result.pos.tags = posData?.tags || null;
    report.result.pos.hostResp = posData?.hostResp || null;
    report.result.pos.errorCode = posData?.errorCode || null;

    // ---------- FISCAL ----------
    await callFiscal("/fiscal/open", {
      operator: FISCAL_OPERATOR,
      password: FISCAL_PASSWORD,
      till: FISCAL_TILL,
    });

    await callFiscal("/fiscal/sale", {
      name: itemName,
      tax: "1",
      price: amount,
      quantity: 1,
      department: "1",
      unit: "BUC",
    });

    await callFiscal("/fiscal/pay", {
      mode: "CARD",
      amount,
    });

    await callFiscal("/fiscal/close", {});

    report.fiscal_ok = true;
    report.result.fiscal.ok = true;
    report.success = true;

  } catch (e) {
    console.error("[AGENT] card_and_receipt ERROR:", e);

    // Daca POS a fost OK dar casa de marcat a esuat, NU afisam "plata a esuat".
    // Afisam un mesaj business: POS reusit, bonul nu s-a putut emite, trebuie re-emis.
    if (report.pos_ok === true && report.fiscal_ok !== true) {
      const rawMsg = String(e?.message || "Eroare la casa de marcat");
      const reason = /hartie/i.test(rawMsg) ? "Lipsa hartie" : rawMsg;

      report.error_message = `Plata reusita la POS. NU s-a putut emite bonul prin casa de marcat - ${reason}! Re-emite bonul!`;
    } else {
      report.error_message = String(e.message || "CARD_AND_RECEIPT_FAILED");
    }
  }

  // ---------- REPORT (SE TRIMITE MEREU) ----------
  try {
    await sendJobReport(job.id, report);
    console.log("[AGENT] Report trimis pentru job", job.id);
  } catch (e) {
    console.error("[AGENT] Eroare trimitere report:", e);
  }

  return;
}

  // 4) CARD REFUND via POS
  if (job.job_type === "card_refund") {
    const report = {
      success: false,
      pos_ok: false,
      fiscal_ok: true, // nu avem fiscal la refund POS
      error_message: null,
      result: {
        pos: { ok: false },
        fiscal: { ok: true },
      },
    };

    try {
      const posUrl = `${POS_BASE_URL}/pos/refund?dev=${encodeURIComponent(devLabel)}`;
      const posStan = payload.pos_stan || null;
      const posBody = {
        amount: amount.toFixed(2),
        currency: payload.currency || "RON",
        stan: posStan,
        extra_tags: Array.isArray(payload.extra_tags) ? payload.extra_tags : [],
      };
 if (!posStan || !/^\d{6}$/.test(String(posStan).trim())) {
   throw new Error("Lipseste STAN (A109) pentru refund/void.");
 }
      console.log("[AGENT] [POS] REFUND", posUrl, "body=", posBody);

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 180000);

      const posRes = await fetch(posUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(posBody),
        signal: controller.signal,
      });

      clearTimeout(t);

      const posData = await posRes.json().catch(() => ({}));
      console.log("[AGENT] [POS] REFUND response", posRes.status, posData);

      const approved =
        posRes.ok &&
        (posData?.ok === true ||
          posData?.approved === true ||
          String(posData?.status || "").toLowerCase() === "approved");

      if (!approved) {
        throw new Error(
          posData?.message ||
          posData?.error ||
          `POS_HTTP_${posRes.status}`
        );
      }

      report.pos_ok = true;
      report.result.pos.ok = true;
      report.result.pos.tags = posData?.tags || null;
      report.result.pos.hostResp = posData?.hostResp || null;
      report.result.pos.errorCode = posData?.errorCode || null;
      report.success = true;
    } catch (e) {
      console.error("[AGENT] card_refund ERROR:", e);
      report.error_message = String(e.message || "CARD_REFUND_FAILED");
    }

    try {
      await sendJobReport(job.id, report);
      console.log("[AGENT] Report trimis pentru job", job.id);
    } catch (e) {
      console.error("[AGENT] Eroare trimitere report:", e);
    }

    return;
  }


  // 3) RETRY DOAR BON FISCAL (fără POS)
  if (job.job_type === "retry_receipt") {
    const report = {
      success: false,
      pos_ok: true, // POS a fost deja OK anterior
      fiscal_ok: false,
      error_message: null,
      result: {
        pos: { ok: true },
        fiscal: { ok: false },
      },
    };

    try {
      console.log("[AGENT] [RETRY] fiscal/open");
      await callFiscal("/fiscal/open", {
        operator: FISCAL_OPERATOR,
        password: FISCAL_PASSWORD,
        till: FISCAL_TILL,
      });

      console.log("[AGENT] [RETRY] fiscal/sale");
      await callFiscal("/fiscal/sale", {
        name: itemName,
        tax: "1",
        price: amount,
        quantity: 1,
        department: "1",
        unit: "BUC",
      });

      const payMethod = String(payload.payment_method || '').toLowerCase();
      const fiscalMode = payMethod === 'cash' ? 'CASH' : 'CARD';

      console.log(`[AGENT] [RETRY] fiscal/pay ${fiscalMode}`);
      await callFiscal("/fiscal/pay", {
        mode: fiscalMode,
        amount,
      });




      console.log("[AGENT] [RETRY] fiscal/close");
      await callFiscal("/fiscal/close", {});

      report.success = true;
      report.fiscal_ok = true;
      report.result.fiscal.ok = true;
    } catch (e) {
      console.error("[AGENT] Eroare în fluxul retry_receipt:", e);
      report.error_message = String(e.message || "FISCAL_RETRY_ERROR");
    }

    try {
      console.log("[DBG] ABOUT TO REPORT job#", job.id, "type=", job.job_type, "success=", report.success, "err=", report.error_message);
      await sendJobReport(job.id, report);
      console.log("[DBG] REPORT SENT job#", job.id);

      console.log(
        `[AGENT] Report trimis pentru job #${job.id} (retry_receipt)`
      );
    } catch (err) {
      console.error(
        `[AGENT] Eroare la trimiterea report-ului pentru job #${job.id}:`,
        err
      );
    }

    return;
  }

  // Orice alt tip de job (deocamdată neimplementat)
  console.warn("[AGENT] job_type necunoscut:", job.job_type);
  const fallback = {
    success: false,
    pos_ok: false,
    fiscal_ok: false,
    error_message: "UNKNOWN_JOB_TYPE",
    result: {
      pos: { ok: false },
      fiscal: { ok: false },
    },
  };
  await sendJobReport(job.id, fallback);
}

// ================= SOCKET.IO (agent) =================
let agentSocket = null;

function startAgentSocket() {
  const socketUrl = `${BACKEND_URL}/agent`;

  agentSocket = io(socketUrl, {
    auth: {
      agent_key: AGENT_KEY,
    },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 2000,
  });

  agentSocket.on("connect", () => {
    console.log("[AGENT][SOCKET] Conectat:", agentSocket.id);
    agentSocket.emit("agent:requestJob");
  });


  agentSocket.on("agent:welcome", (data) => {
    console.log("[AGENT][SOCKET] welcome:", data);
  });

  agentSocket.on("job:new", async (data) => {
    console.log("[AGENT][SOCKET] job:new:", JSON.stringify(data));

    const job = data?.job || null;
    if (!job || !job.id || job.id === 0) {
      // ignorăm test/invalid
      return;
    }

    const dbgStart = Date.now();
    let dbgLast = "job:new received";

    const dbgTimer = setInterval(() => {
      const sec = Math.round((Date.now() - dbgStart) / 1000);
      console.log(`[DBG] job #${job.id} încă rulează ${sec}s | last=${dbgLast}`);
    }, 5000);


    try {
      dbgLast = "before handleJob";
      await handleJob(job);
      dbgLast = "after handleJob";
    } catch (e) {
      dbgLast = "handleJob threw";
      console.error("[AGENT][SOCKET] Eroare handleJob:", e);
    } finally {
      clearInterval(dbgTimer);
      const sec = Math.round((Date.now() - dbgStart) / 1000);
      console.log(`[DBG] job #${job.id} handler finished in ${sec}s | last=${dbgLast}`);

      agentSocket.emit("agent:requestJob");
    }

  });


  agentSocket.on("job:none", (data) => {
    console.log("[AGENT][SOCKET] job:none:", data);
  });

  agentSocket.on("agent:wakeup", () => {
    console.log("[AGENT][SOCKET] wakeup primit");
    agentSocket.emit("agent:requestJob");
  });


  agentSocket.on("job:error", (data) => {
    console.error("[AGENT][SOCKET] job:error:", data);
  });



  agentSocket.on("disconnect", (reason) => {
    console.log("[AGENT][SOCKET] Deconectat:", reason);
  });

    const serializeSocketError = (err) => {
    if (!err) {
      return null;
    }

    const base = {
      name: err.name,
      message: err.message,
      stack: err.stack,
      description: err.description,
      context: err.context,
      data: err.data,
      type: err.type,
    };

    for (const key of Object.getOwnPropertyNames(err)) {
      if (!(key in base)) {
        base[key] = err[key];
      }
    }

    return base;
  };

  agentSocket.on("connect_error", (err) => {
    
    const serializedError = serializeSocketError(err);
    console.error(
      "[AGENT][SOCKET] Eroare conectare:",
      JSON.stringify(serializedError)
    );
  });
}


// Loop principal
async function mainLoop() {
  console.log("[AGENT] Pornit. Backend:", BACKEND_URL, "AgentKey:", AGENT_KEY);

  startAgentSocket();

  while (!stopped) {
    await sleep(1000);
  }
}


// Pornește agentul
mainLoop().catch((err) => {
  console.error("[AGENT] Eroare fatală:", err);
  process.exit(1);
});

// La CTRL+C oprim frumos
process.on("SIGINT", () => {
  console.log("\n[AGENT] Oprire cerută (SIGINT).");
  stopped = true;

  try {
    if (agentSocket) {
      console.log("[AGENT] Inchid socket...");
      agentSocket.disconnect();
      if (typeof agentSocket.close === "function") agentSocket.close();
    }
  } catch (e) {
    console.log("[AGENT] Eroare la inchiderea socket-ului:", e?.message || e);
  }

  // daca mai ramane ceva deschis, iesim fortat
  setTimeout(() => process.exit(0), 300);
});

