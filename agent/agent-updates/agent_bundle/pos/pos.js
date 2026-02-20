/**
 * SmartPay POS bridge – la fel ca la casa de marcat
 *
 * - HTTP server pe port 9100 (configurabil)
 * - /pos/sale?dev=A|B  → porneste tranzactie de plata cu cardul
 * - Comunicare seriala cu POS SmartPay (ENQ / TLV / CRC16/BUYPASS)
 *
 * IMPORTANT:
 *   - Seteaza corect porturile COM pentru cele doua POS-uri.
 *   - In frontend noi deja chemam:  http://127.0.0.1:9100/pos/sale?dev=A|B
 */
require("dotenv").config({ path: __dirname + "\\.env" });

const express = require("express");
const { SerialPort } = require("serialport");

// ───────────────── CONFIG ──────────────────────────────────────

// HTTP port pentru POS bridge (la fel ca la casa de marcat, dar separat)
const HTTP_PORT = Number(process.env.POS_HTTP_PORT || 9100);

// Porturi COM pentru cele doua POS-uri (le poti schimba din .env)
const POS_DEVS = {
  A: process.env.POS_DEV_A || "COM12", // POS agentie A
  B: process.env.POS_DEV_B || "COM12", // POS agentie B
};

const POS_BAUD = Number(process.env.POS_BAUD || 115200);

// Timeout scurt doar pentru handshake (ENQ -> ACK). Daca POS-ul e deconectat / COM gresit,
// vrem raspuns rapid catre agent (fara sa asteptam timeout-ul tranzactiei).
const ENQ_ACK_TIMEOUT_MS = Number(process.env.POS_ENQ_ACK_TIMEOUT_MS || 2500);

// Timeout maxim pentru o tranzactie completa pe POS (introducere card, PIN, autorizare).
// NU e folosit pentru detectia de "POS neconectat" (aia se face cu ENQ_ACK_TIMEOUT_MS).
const POS_TX_TIMEOUT_MS = Number(process.env.POS_TX_TIMEOUT_MS || 200000);


// Normalizează portul COM pe Windows (COM10+ trebuie prefixat cu \\.\)
function normalizeWinComPath(name) {
  // Dacă e COM10+ -> \\.\COM10
  // dacă e deja \\.\COMxx -> îl lăsăm
  const s = String(name || "").trim();
  if (s.startsWith("\\\\.\\")) return s;
  const m = /^COM(\d+)$/i.exec(s);
  if (!m) return s;
  const n = Number(m[1]);
  if (Number.isFinite(n) && n >= 10) return `\\\\.\\COM${n}`;
  return `COM${n}`;
}


// ───────────── CRC-16 / BUYPASS (din documentatie) ────────────
// Appendix 2 – SmartPay_ECR_Link_v1.8
function crc16(buf) {
  let usCRC = 0;
  for (let j = 0; j < buf.length; j++) {
    const b = buf[j];
    let high = (usCRC >> 8) & 0xff;
    let low = usCRC & 0xff;
    high ^= b;
    usCRC = ((high << 8) | low) & 0xffff;

    for (let i = 0; i <= 7; i++) {
      if (usCRC & 0x8000) {
        usCRC = ((usCRC << 1) & 0xffff) ^ 0x8005;
      } else {
        usCRC = (usCRC << 1) & 0xffff;
      }
    }
  }
  return usCRC & 0xffff;
}

// ─────────── TLV helpers (A000, A001, ...) ─────────────────────

function tlv(tag, valueBuf) {
  const tagBuf = Buffer.from([(tag >> 8) & 0xff, tag & 0xff]);
  const lenBuf = Buffer.from([valueBuf.length]);
  return Buffer.concat([tagBuf, lenBuf, valueBuf]);
}

function ascii(str) {
  return Buffer.from(str, "ascii");
}

// frame = STX | LEN(2) | TLVS... | ETX | CRC(2)
// In aceasta varianta, CRC se calculeaza DOAR peste TLV (exact ca in scriptul tau de test).
function buildFrameFromTLV(tlvBuf) {
  const len = tlvBuf.length;

  const header = Buffer.from([
    0x02, // STX
    (len >> 8) & 0xff, // LEN MSB
    len & 0xff, // LEN LSB
  ]);

  const etx = Buffer.from([0x03]);

  const crcVal = crc16(tlvBuf);
  const crcBuf = Buffer.from([
    (crcVal >> 8) & 0xff, // MSB
    crcVal & 0xff, // LSB
  ]);

  return Buffer.concat([header, tlvBuf, etx, crcBuf]);
}

// TLV pentru "Get POS Information" (optional, pentru test conexiune)
function buildGetInfoTLV() {
  // A000 = 01 (Get POS information)
  return tlv(0xA000, Buffer.from([0x01]));
}

// TLV pentru "Sale by card"
function buildSaleTLV(amountLei, uniqueIdStr = "000000000001") {
  // amountLei → 12 caractere, in bani: 1.00 -> "000000000100"
  const amountStr = Number(amountLei).toFixed(2).replace(".", "");
  const amount12 = amountStr.padStart(12, "0");

  const unique12 = String(uniqueIdStr).padStart(12, "0").slice(0, 12);

  return Buffer.concat([
    tlv(0xA000, Buffer.from([0x02])), // 02 – Sale by card
    tlv(0xA001, ascii(amount12)), // Amount
    tlv(0xA002, ascii("RON")), // Currency name
    tlv(0xA003, ascii("946")), // Currency code
    tlv(0xA008, ascii(unique12)), // Unique ID (optional, dar e ok sa-l trimitem)
    tlv(0xA007, ascii("000000000000")), // Cash back amount = 0,00
  ]);
}

function buildRefundTLV(amountLei, stan6, extraTags = []) {
  const amountStr = Number(amountLei).toFixed(2).replace(".", "");
  const amount12 = amountStr.padStart(12, "0");

 const stan = String(stan6 || "").trim().padStart(6, "0").slice(0, 6);
 if (!/^\d{6}$/.test(stan)) {
   throw new Error("STAN invalid/missing pentru VOID (A006).");
 }
  const tlvs = [
   tlv(0xA000, Buffer.from([0x06])), // ✅ 06 – Perform void
   tlv(0xA006, ascii(stan)),         // ✅ STAN (6)
   tlv(0xA001, ascii(amount12)),     // ✅ Amount (12)
  ];



  for (const entry of extraTags || []) {
    if (!entry || !entry.tag || entry.value == null) continue;
    const tagHex = String(entry.tag).toUpperCase().replace(/^0X/, "");
    const tagNum = Number.parseInt(tagHex, 16);
    if (!Number.isFinite(tagNum)) continue;
    tlvs.push(tlv(tagNum, ascii(String(entry.value))));
  }

  return Buffer.concat(tlvs);
}

// ────────────── Parsare TLV din raspuns ────────────────────────

function parseTlvResponse(tlvBuf) {
  const tags = {};
  let offset = 0;

  while (offset + 3 <= tlvBuf.length) {
    const tag = (tlvBuf[offset] << 8) | tlvBuf[offset + 1]; // ex: 0xA100, 0xA107
    const len = tlvBuf[offset + 2];
    const start = offset + 3;
    const end = start + len;
    if (end > tlvBuf.length) break;

    const value = tlvBuf.slice(start, end);

    // tag este de forma A100, A107 etc.
    // îl transformăm în string "A100", "A107", "A10A" etc.
    const hex = tag.toString(16).toUpperCase().padStart(4, "0"); // ex: "A100"
    const key = "A" + hex.slice(1); // "A100" (fără AA)

    tags[key] = value;
    offset = end;
  }

  return tags;
}


function bufToAscii(b) {
  return b ? b.toString("ascii") : "";
}

// ───────────── Low-level comunicatie cu un POS ─────────────────

const ENQ = 0x05;
const ACK = 0x06;
const NAK = 0x15;
const EOT = 0x04;
const STX = 0x02;

/**
 * Trimite o comanda la POS:
 *  - face ENQ / ACK
 *  - trimite frame TLV
 *  - asteapta raspuns (frame TLV)
 *  - intoarce: { raw, tags, ok, errorCode, hostResp }
 *
 * @param {string} dev   "A" sau "B"
 * @param {Buffer} tlvBuf payload TLV cerere
 */
async function sendPosCommand(dev, tlvBuf) {
  const portNameRaw = String(POS_DEVS[dev] || POS_DEVS.A || "").trim();
  const portName = normalizeWinComPath(portNameRaw);




  console.log(`\n=== POS ${dev} @ ${portName} – start command ===`);

  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path: portName,
      baudRate: POS_BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      autoOpen: false,
    });

    let state = "waitAckEnq";
    let enqTries = 0;
    let frame;
    let respBuf = Buffer.alloc(0);
    let dataLen = null;
    let fullFrameLen = null;
    let done = false;
    let enqTimer = null;

    function safeDone(err, result) {
      if (done) return;
      done = true;

      if (enqTimer) {
        clearTimeout(enqTimer);
        enqTimer = null;
      }

      const finish = () => {
        if (err) return reject(err);
        resolve(result);
      };

      // IMPORTANT: dacă portul nu s-a deschis niciodată (ex: COM inexistent),
      // nu încercăm write/close – unele drivere nu mai apelează callback-ul.
      if (!port || !port.isOpen) {
        return finish();
      }

      try {
        port.write(Buffer.from([EOT]), () => {
          port.close(() => finish());
        });
      } catch (_) {
        finish();
      }
    }

    port.on("error", (err) => {
      console.error("POS serial error:", err);
      safeDone(err);
    });

    port.on("data", (chunk) => {
      if (done) return;
      // console.log("[RX]", chunk.toString("hex"));
      for (const b of chunk) {
        if (state === "waitAckEnq") {
          if (b === ACK) {
            console.log("POS ACK la ENQ → trimit frame TLV");
            frame = buildFrameFromTLV(tlvBuf);
            // log frumos
            try {
              console.log(
                "TX frame:",
                frame.toString("hex").match(/.{1,2}/g).join(" ")
              );
            } catch {}
            port.write(frame);
            state = "waitResponseStart";
          } else if (b === NAK) {
            enqTries++;
            console.log(`POS NAK la ENQ (incercarea ${enqTries})`);
            if (enqTries >= 3) {
              return safeDone(new Error("POS_NAK_ENQ_3_TIMES"));
            }
            // retrimitem ENQ
            port.write(Buffer.from([ENQ]));
          } else {
            // altceva → ignoram, dar logam
            console.log("POS raspuns neasteptat la ENQ:", b.toString(16));
          }
        } else if (state === "waitResponseStart") {
          if (b === STX) {
            respBuf = Buffer.from([b]);
            dataLen = null;
            fullFrameLen = null;
            state = "waitResponseBody";
          } else if (b === ACK) {
            // ACK de la POS pentru frame-ul nostru – ok, ignoram
          } else if (b === NAK) {
            // POS cere retrimiterea comenzii – pentru simplitate, o singura data
            console.log("POS NAK la frame – retrimit o data");
            frame && port.write(frame);
          }
        } else if (state === "waitResponseBody") {
          respBuf = Buffer.concat([respBuf, Buffer.from([b])]);
          if (respBuf.length === 3) {
            // avem STX + LEN(2)
            dataLen = (respBuf[1] << 8) | respBuf[2];
            // STX + LEN(2) + dataLen (TLV) + ETX(1) + CRC(2)
            fullFrameLen = 1 + 2 + dataLen + 1 + 2;
          }
          if (fullFrameLen && respBuf.length >= fullFrameLen) {
            // avem frame complet
            console.log(
              "RX frame:",
              respBuf.toString("hex").match(/.{1,2}/g).join(" ")
            );
            // trimitem ACK catre POS
            port.write(Buffer.from([ACK]));

// TLV este intre index 3 si 3+dataLen
const tlvPart = respBuf.slice(3, 3 + dataLen);
const tags = parseTlvResponse(tlvPart);

// A100 este 1 byte HEX (00, 01, 02...)
// Nu e text "00", deci îl citim ca hex, nu ASCII.
const resTagBuf = tags.A100;
const resTagHex = resTagBuf ? resTagBuf.toString("hex").toUpperCase() : null;

// A107 este text ("00", "Y1", "Y3" etc.) – aici ASCII este corect
const hostResp = bufToAscii(tags.A107);

// Tranzacția este aprobată doar când:
// A100 = 00 (HEX) și A107 = 00 / Y1 / Y3
const ok =
  resTagHex === "00" &&
  (hostResp === "00" || hostResp === "Y1" || hostResp === "Y3");

console.log("A100 (terminal) =", resTagHex || "(lipsa)");
console.log("A107 (host)     =", hostResp || "(lipsa)");
console.log("=> OK =", ok);

safeDone(null, {
  raw: respBuf,
  tags,
  ok,
  errorCode: resTagHex || null,
  hostResp: hostResp || null,
});

          }
        }
      }
    });

    port.open((err) => {
      if (err) {
        console.error("Nu pot deschide portul POS:", err.message);
        // Trimitem o eroare clară, nu lăsăm request-ul să se blocheze.
        return safeDone(new Error("POS_NOT_CONNECTED"));
      }

      console.log(`Port POS ${dev} deschis @${POS_BAUD}, trimit ENQ...`);
      state = "waitAckEnq";
      enqTries = 0;

      // Timeout scurt doar pentru handshake ENQ->ACK (POS deconectat/COM greșit)
      enqTimer = setTimeout(() => {
        if (!done && state === "waitAckEnq") {
          console.log("TIMEOUT ENQ/ACK – POS probabil deconectat sau COM greșit");
          safeDone(new Error("POS_NOT_CONNECTED"));
        }
      }, ENQ_ACK_TIMEOUT_MS);

      port.write(Buffer.from([ENQ]));
    });

    // timeout global tranzacție (card+PIN etc.) – limită maximă
    setTimeout(() => {
      if (!done) {
        console.log("TIMEOUT global la tranzactie POS");
        safeDone(new Error("POS_TIMEOUT"));
      }
    }, POS_TX_TIMEOUT_MS);
  });
}

function mapPosDeclineMessageFromTags(tags, errorCodeHex, hostResp) {
  // 1) Mesaj text venit direct de la POS (A108) – cel mai bun dacă există
  const a108 = bufToAscii(tags?.A108 || "").trim();
  if (a108) {
    // Caz special: Terminal neinregistrat
    if (/NEINREGISTRAT/i.test(a108)) return "Terminal neinregistrat";

    // Caz special: POS a raportat anulare / timeout flow card.
    // În logurile tale apare: "ANULAT DE CATRE DETINATORUL DE CARD".
    // În contextul cerut (nu s-a introdus/apropiat cardul în timp), vrem mesajul prietenos:
    if (/ANULAT\s+DE\s+CATRE\s+DETINATORUL\s+DE\s+CARD/i.test(a108)) {
      return "Nu s-a introdus cardul in POS";
    }

    // Caz special: POS așteaptă card și a expirat (mesajele pot diferi între versiuni)
    if (/NO\s*CARD|CARD\s*NOT\s*PRESENT|INSERT\s*CARD|PRESENT\s*CARD|INTRODUC|APROPIE|TIMEOUT/i.test(a108)) {
      return "Nu s-a introdus cardul in POS";
    }
  }

  // 2) Caz special: nu s-a introdus cardul (documentația SmartPay: A10C == "**")
  const a10c = bufToAscii(tags?.A10C || "").trim();
  if (a10c === "**") return "Nu s-a introdus cardul in POS";

  // 2a) Caz special: host response = CC (în logurile tale apare la timeout fără card).
  // Exemplu log: A107 (host) = CC
  const a107cc = String(hostResp || "").toUpperCase().trim();
  if (a107cc === "CC") return "Nu s-a introdus cardul in POS";

  // 2b) Fallback robust pentru cazul "nu s-a introdus card" când POS nu trimite A10C,
  // dar întoarce doar A100=01 și fără cod host.
  const a100Fallback = String(errorCodeHex || "").toUpperCase();
  const a107Fallback = String(hostResp || "").toUpperCase().trim();
  if (a100Fallback === "01" && !a108 && !a107Fallback) {
    return "Nu s-a introdus cardul in POS";
  }

  // 3) Host response (A107)
  const a107 = String(hostResp || "").toUpperCase();
  if (a107 === "51") return "Fonduri insuficiente";
  if (a107 === "05") return "Tranzacție refuzată";
  if (a107 === "54") return "Card expirat";
  if (a107 === "91") return "Banca indisponibilă (încearcă din nou)";
  if (a107 === "96") return "Eroare sistem (încearcă din nou)";

  // 4) Terminal error (A100) – fallback
  const a100 = String(errorCodeHex || "").toUpperCase();
  if (a100 && a100 !== "00") return `Eroare terminal POS (A100=${a100})`;

  // 5) Ultimul fallback
  return "Tranzacție refuzată";
}

// ───────────── High-level helpers (sale, info) ─────────────────

// Pentru test / debugging manual
async function posGetInfo(dev = "A") {
  const tlvReq = buildGetInfoTLV();
  return sendPosCommand(dev, tlvReq);
}

async function posSale(dev, amountLei, uniqueId) {
  const tlvReq = buildSaleTLV(amountLei, uniqueId);
  return sendPosCommand(dev, tlvReq);
}

async function posRefund(dev, amountLei, stan, extraTags) {
  const tlvReq = buildRefundTLV(amountLei, stan, extraTags);
  return sendPosCommand(dev, tlvReq);
}

// ───────────── HTTP server (Express) ───────────────────────────

const app = express();
app.use(express.json());

// ✅ CORS pentru apeluri din frontend (http://localhost:5173)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    // răspuns la preflight
    return res.sendStatus(204);
  }

  next();
});

// sanity endpoint (opțional)
app.get("/pos/ping", (req, res) => {
  res.json({ ok: true, msg: "POS bridge running" });
});

// GET /pos/info?dev=A|B – pentru testare (nu e folosit de frontend acum)
app.get("/pos/info", async (req, res) => {
  const dev = (req.query.dev || "A").toUpperCase();
  try {
    const result = await posGetInfo(dev);
    res.json({
      ok: result.ok,
      errorCode: result.errorCode,
      tags: Object.fromEntries(
        Object.entries(result.tags).map(([k, v]) => [k, bufToAscii(v)])
      ),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /pos/sale?dev=A|B
// Body JSON: { amount: 12.34, uniqueId?: "123" }
app.post("/pos/sale", async (req, res) => {
  const dev = (req.query.dev || "A").toUpperCase();
  const amount = Number(req.body?.amount || 0);
  const uniqueId = req.body?.uniqueId || null;

  if (!amount || amount <= 0) {
    return res
      .status(400)
      .json({ ok: false, error: "AMOUNT_REQUIRED_OR_INVALID" });
  }

  console.log(`\n=== /pos/sale dev=${dev} amount=${amount.toFixed(2)} ===`);

  try {
    const result = await posSale(dev, amount, uniqueId);
    if (!result.ok) {
      const message = mapPosDeclineMessageFromTags(
        result.tags,
        result.errorCode,
        result.hostResp
      );
      return res.status(409).json({
        ok: false,
        error: "POS_DECLINED",
        message,
        errorCode: result.errorCode,
        hostResp: result.hostResp,
      });
    }

    res.json({
      ok: true,
      errorCode: result.errorCode,
      hostResp: result.hostResp,
      tags: Object.fromEntries(
        Object.entries(result.tags).map(([k, v]) => [k, bufToAscii(v)])
      ),
    });
  } catch (e) {
    console.error("Eroare /pos/sale:", e);
    const msg = String(e?.message || e);
    if (msg === "POS_NOT_CONNECTED") {
      return res
        .status(503)
        .json({ ok: false, error: "POS_NOT_CONNECTED", message: "POS nu este conectat" });
    }
    if (msg === "POS_TIMEOUT") {
      return res
        .status(504)
        .json({ ok: false, error: "POS_TIMEOUT", message: "Timeout POS" });
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

// POST /pos/refund?dev=A|B
// Body JSON: { amount: 12.34, uniqueId?: "123", extra_tags?: [{ tag: "A012", value: "..." }] }
app.post("/pos/refund", async (req, res) => {
  const dev = (req.query.dev || "A").toUpperCase();
  const amount = Number(req.body?.amount || 0);
  const stan = req.body?.stan || null;
  const extraTags = Array.isArray(req.body?.extra_tags) ? req.body.extra_tags : [];

  if (!amount || amount <= 0) {
    return res
      .status(400)
      .json({ ok: false, error: "AMOUNT_REQUIRED_OR_INVALID" });
  }
 if (!stan || !/^\d{6}$/.test(String(stan).trim())) {
   return res.status(400).json({ ok: false, error: "STAN_REQUIRED_OR_INVALID" });
 }
  console.log(`\n=== /pos/refund dev=${dev} amount=${amount.toFixed(2)} ===`);

  try {
    const result = await posRefund(dev, amount, stan, extraTags);
    if (!result.ok) {
      const message = mapPosDeclineMessageFromTags(
        result.tags,
        result.errorCode,
        result.hostResp
      );
      return res.status(409).json({
        ok: false,
        error: "POS_DECLINED",
        message,
        errorCode: result.errorCode,
        hostResp: result.hostResp,
      });
    }

    res.json({
      ok: true,
      errorCode: result.errorCode,
      hostResp: result.hostResp,
      tags: Object.fromEntries(
        Object.entries(result.tags).map(([k, v]) => [k, bufToAscii(v)])
      ),
    });
  } catch (e) {
    console.error("Eroare /pos/refund:", e);
    const msg = String(e?.message || e);
    if (msg === "POS_NOT_CONNECTED") {
      return res
        .status(503)
        .json({ ok: false, error: "POS_NOT_CONNECTED", message: "POS nu este conectat" });
    }
    if (msg === "POS_TIMEOUT") {
      return res
        .status(504)
        .json({ ok: false, error: "POS_TIMEOUT", message: "Timeout POS" });
    }
    res.status(500).json({ ok: false, error: msg });
  }
});

app.listen(HTTP_PORT, () => {
  console.log(
    `🚀 POS bridge pornit pe http://127.0.0.1:${HTTP_PORT} (A=${POS_DEVS.A}, B=${POS_DEVS.B})`
  );
});


// ───────────── Listare porturi seriale la start ────────────────

SerialPort.list().then((ports) => {
  console.log("=== PORTURI SERIALE DETECTATE DE NODE ===");
  for (const p of ports) {
    console.log(
      "-",
      p.path,
      "|",
      p.friendlyName || p.manufacturer || "fără nume"
    );
  }
}).catch(err => {
  console.error("Eroare SerialPort.list():", err);
});


// Export pentru eventuale scripturi externe (optional)
module.exports = {
  posGetInfo,
  posSale,
  posRefund,
};
