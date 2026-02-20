// backend/routes/reservations.js (MariaDB 10.6)
const express = require('express');
const db = require('../db');
const { randomUUID } = require('crypto');
const router = express.Router();
const { emitTripUpdate } = require('../sockets/emitters');

const { logPersonNameChange } = require('./audit');

const { requireAuth, requireRole } = require('../middleware/auth');
const { normalizeDirection, isReturnDirection, ensureDirection } = require('../utils/direction');
const { getOnlineSettings, buildDateTimeFromDateAndTime } = require('../utils/onlineSettings');

// ✅ Acces pentru rutele interne (admin, operator_admin, agent, driver)
router.use(['/', '/:id'], (req, res, next) => {
  // lăsăm să treacă public doar cererile de tip POST /public_reservation
  if (req.path.startsWith('/public_reservation')) return next();
  requireAuth(req, res, (err) => {
    if (err) return;
    requireRole('admin', 'operator_admin', 'agent', 'driver')(req, res, next);
  });
});




// ── Config fiscală din .env (asemenea routes/cash.js)
const FISCAL_URL = process.env.FISCAL_PRINTER_URL || '';
const FISCAL_ON = String(process.env.FISCAL_ENABLED || 'true').toLowerCase() === 'true';
const FISCAL_TO = Number(process.env.FISCAL_TIMEOUT_MS || 6000);

// Mapare operator -> device A/B din .env: FISCAL_DEV_FOR_OPERATOR_1=A, FISCAL_DEV_FOR_OPERATOR_2=B
function devForOperatorId(opId) {
  const envKey = `FISCAL_DEV_FOR_OPERATOR_${Number(opId)}`;
  return (process.env[envKey] || '').toUpperCase() || (Number(opId) === 1 ? 'A' : 'B');
}
function toMoneyDot(x, decimals = 2) {
  const n = Number(String(x).replace(',', '.').trim() || '0');
  return n.toFixed(decimals);
}
function safeJson(x) {
  try { return JSON.parse(x); } catch { return { raw: String(x) }; }
}

function normalizeStationToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function detectTripSense({ route_name, from_stop, to_stop }) {
  const routeName = String(route_name || '').trim();
  const from = normalizeStationToken(from_stop);
  const to = normalizeStationToken(to_stop);
  if (!routeName || !from || !to) return '';

  const stops = routeName
    .split(/\s*(?:-|–|—|→|>|\/|\|)\s*/)
    .map((part) => normalizeStationToken(part))
    .filter(Boolean);

  if (stops.length < 2) return '';

  const first = stops[0];
  const last = stops[stops.length - 1];

  if (from === first && to === last) return 'TUR';
  if (from === last && to === first) return 'RETUR';
  return '';
}

async function getFiscalReceiptTemplate() {
  try {
    const res = await db.query(
      'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
      ['receipt_note']
    );

    const rows = Array.isArray(res)
      ? (Array.isArray(res[0]) ? res[0] : res)
      : res?.rows;

    const value = rows?.[0]?.setting_value;
    return typeof value === 'string' ? value.trim() : '';
  } catch (err) {
    console.warn('[reservations] Nu am putut citi receipt_note din app_settings:', err?.message || err);
    return '';
  }
}

async function loadReservationReceiptMeta(reservationId) {
  const metaRes = await db.query(
    `SELECT
       ro.name AS route_name,
       t.date  AS trip_date,
       t.time  AS trip_time,
       s.label AS seat_label,
       sb.name AS from_stop,
       se.name AS to_stop
     FROM reservations r
     JOIN trips t   ON t.id = r.trip_id
     JOIN routes ro ON ro.id = t.route_id
     LEFT JOIN seats s     ON s.id = r.seat_id
     LEFT JOIN stations sb ON sb.id = r.board_station_id
     LEFT JOIN stations se ON se.id = r.exit_station_id
     WHERE r.id = ?
     LIMIT 1`,
    [reservationId]
  );

  const rows = Array.isArray(metaRes)
    ? (Array.isArray(metaRes[0]) ? metaRes[0] : metaRes)
    : metaRes?.rows;

  return rows?.[0] || {};
}

function renderReceiptDescription({ reservationId, template, meta, fallbackText }) {
  const fallback = String(fallbackText || `Rezervare #${reservationId}`);
  const tpl = String(template || '').trim();
  if (!tpl) return fallback;

  const tokens = {
    '%REZERVARE_ID%': String(reservationId || ''),
    '%PLECARE%': String(meta?.from_stop || ''),
    '%SOSIRE%': String(meta?.to_stop || ''),
    '%SENS%': detectTripSense(meta || {}),
    '%ORA%': String(meta?.trip_time || '').slice(0, 5),
    '%DATA%': String(meta?.trip_date || ''),
    '%LOC%': String(meta?.seat_label || ''),
    '%RUTA%': String(meta?.route_name || ''),
  };

  let rendered = tpl.replace(/\\n/g, '\n');
  for (const [token, value] of Object.entries(tokens)) {
    rendered = rendered.split(token).join(value);
  }

  const normalized = rendered.trim();
  return normalized || fallback;
}


// 🔒 LOCK GLOBAL: dacă există agent_job activ (queued/in_progress) pe terminal
async function rejectIfActiveAgentJob(req, res) {
  const terminalId = Number(req.user?.terminal_id);
  if (!terminalId) {
    // dacă nu avem terminal, nu putem decide lock-ul corect
    return false;
  }

  const q = await db.query(
    `SELECT id, job_type, status
       FROM agent_jobs
      WHERE target_terminal_id = ?
        AND status IN ('queued','in_progress')
      ORDER BY id DESC
      LIMIT 1`,
    [terminalId]
  );

  const rows = Array.isArray(q)
    ? (Array.isArray(q[0]) ? q[0] : q)
    : q?.rows;

  if (rows?.length) {
    return res.status(423).json({
      error: 'Există o tranzacție în curs.',
      active_job: rows[0],
    });
  }

  return false;
}





/* ---------------------- helpers: stații/valideri ---------------------- */


const sanitizePhone = (raw) => {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
};


/**
 * Upsert pentru persoana asociată unei rezervări, pe baza nume/telefon.
 * Reguli:
 *  - dacă currentPersonId are phone NULL și primim telefon -> îl setăm (UPDATE)
 *  - dacă currentPersonId are phone diferit:
 *      - dacă noul telefon aparține altcuiva -> returnăm acel alt ID (rezervarea se mută pe acea persoană)
 *      - altfel -> actualizăm phone la persoana curentă
 *  - dacă nu avem currentPersonId:
 *      - dacă găsim persoană cu telefon -> o folosim
 *      - altfel creăm persoană nouă
 * Întoarce { personId, changed } unde changed=true dacă s-a făcut UPDATE/realocare.
 */
async function upsertPersonForReservation({ name, phone, currentPersonId, actorId }) {
  const cleanPhone = (phone || '').replace(/\D/g, '') || null;
  const normalizedName = (name || '').trim();

  // 1) dacă avem deja persoana curentă
  if (currentPersonId) {
    const cur = await db.query(
      `SELECT id, name, phone FROM people WHERE id = ?`,
      [currentPersonId]
    );
    if (!cur.rows.length) {
      // nu există în DB -> cădem pe logica „ca și cum n-am avea current”
    } else {
      const row = cur.rows[0];
      const curPhone = row.phone ? String(row.phone).replace(/\D/g, '') : null;
      const curName = (row.name || '').trim();

      // a) dacă nu primim telefon nou -> eventual doar numele
      if (!cleanPhone) {
        if (normalizedName && normalizedName !== curName) {
          await db.query(`UPDATE people SET name=? WHERE id=?`, [normalizedName, row.id]);
          await logPersonNameChange({
            personId: row.id,
            phone: row.phone,
            beforeName: row.name,
            afterName: normalizedName,
            actorId,
          });
          return { personId: row.id, changed: true };
        }
        return { personId: row.id, changed: false };
      }

      // b) avem telefon nou
      if (!curPhone) {
        // setăm telefonul pe aceeași persoană
        await db.query(`UPDATE people SET phone=?, name=COALESCE(NULLIF(?, ''), name) WHERE id=?`,
          [cleanPhone, normalizedName, row.id]);
        if (normalizedName && normalizedName !== curName) {
          await logPersonNameChange({
            personId: row.id,
            phone: cleanPhone,
            beforeName: row.name,
            afterName: normalizedName,
            actorId,
          });
        }
        return { personId: row.id, changed: true };
      }

      if (curPhone === cleanPhone) {
        // doar numele eventual
        if (normalizedName && normalizedName !== curName) {
          await db.query(`UPDATE people SET name=? WHERE id=?`, [normalizedName, row.id]);
          await logPersonNameChange({
            personId: row.id,
            phone: cleanPhone,
            beforeName: row.name,
            afterName: normalizedName,
            actorId,
          });
          return { personId: row.id, changed: true };
        }
        return { personId: row.id, changed: false };
      }

      // telefonul diferă; verificăm dacă aparține altcuiva
      const other = await db.query(`SELECT id, name FROM people WHERE phone = ?`, [cleanPhone]);
      if (other.rows.length) {
        // realocăm rezervarea pe acea persoană
        const newId = other.rows[0].id;
        const otherName = (other.rows[0].name || '').trim();
        // putem ajusta numele acelei persoane dacă am primit unul non-gol
        if (normalizedName && normalizedName !== otherName) {
          await db.query(`UPDATE people SET name=COALESCE(NULLIF(?, ''), name) WHERE id=?`, [normalizedName, newId]);
          await logPersonNameChange({
            personId: newId,
            phone: cleanPhone,
            beforeName: other.rows[0].name,
            afterName: normalizedName,
            actorId,
          });
        }
        return { personId: newId, changed: true };
      }
      // nu există altcineva cu telefonul -> îl mutăm pe persoana curentă
      await db.query(`UPDATE people SET phone=?, name=COALESCE(NULLIF(?, ''), name) WHERE id=?`,
        [cleanPhone, normalizedName, row.id]);
      if (normalizedName && normalizedName !== curName) {
        await logPersonNameChange({
          personId: row.id,
          phone: cleanPhone,
          beforeName: row.name,
          afterName: normalizedName,
          actorId,
        });
      }
      return { personId: row.id, changed: true };
    }
  }

  // 2) nu avem currentPersonId
  if (cleanPhone) {
    const found = await db.query(`SELECT id, name, phone FROM people WHERE phone = ?`, [cleanPhone]);
    if (found.rows.length) {
      const pid = found.rows[0].id;
      const prevName = (found.rows[0].name || '').trim();
      if (normalizedName && normalizedName !== prevName) {
        await db.query(`UPDATE people SET name=COALESCE(NULLIF(?, ''), name) WHERE id=?`, [normalizedName, pid]);
        await logPersonNameChange({
          personId: pid,
          phone: cleanPhone,
          beforeName: found.rows[0].name,
          afterName: normalizedName,
          actorId,
        });
        return { personId: pid, changed: true };
      }
      return { personId: pid, changed: false };
    }
    const ins = await db.query(
      `INSERT INTO people (name, phone) VALUES (?, ?)`,
      [name && name.trim() ? name.trim() : null, cleanPhone]
    );
    return { personId: ins.insertId, changed: true };
  }

  // fără telefon -> identificăm după nume (nume+NULL phone)
  if (name && name.trim()) {
    const sameName = await db.query(
      `SELECT id FROM people WHERE name = ? AND phone IS NULL`,
      [name.trim()]
    );
    if (sameName.rows.length) return { personId: sameName.rows[0].id, changed: false };
    const ins = await db.query(`INSERT INTO people (name, phone) VALUES (?, NULL)`, [name.trim()]);
    return { personId: ins.insertId, changed: true };
  }
  return { personId: null, changed: false };
}



// ——— utils audit & booking-channel ———
// Scrie în audit_logs. Mapează acțiunile vechi:
//   'create' -> 'reservation.create', 'update' -> 'reservation.update',
//   'cancel' -> 'reservation.cancel', 'move' -> 'reservation.move',
//   'pay'    -> 'payment.capture' (entity='payment', related_id=reservationId)
async function logEvent(reservationId, action, actorId, details = null) {
  try {
    const correlation_id = details?.correlation_id || randomUUID();
    const channel = details?.channel || null;
    const amount = details?.amount || null;
    const payment_method = details?.method || null;
    const provider_transaction_id = details?.provider_transaction_id || null;
    const related_id = details?.from_reservation_id || details?.related_reservation_id || null;
    const note = details?.note || null;
    const serialize = (payload) => {
      if (!payload) return null;
      if (typeof payload === 'string') return payload;
      try {
        return JSON.stringify(payload);
      } catch {
        return null;
      }
    };
    const before_json = serialize(details?.before);
    const after_json = serialize(details?.after);


    let entity = 'reservation';
    let finalAction = action && action.startsWith('reservation.') ? action : `reservation.${action}`;

    // plăți -> entitate 'payment', acțiune 'payment.capture', legată de rezervare prin related_id
    if (action === 'pay' || action === 'payment.capture') {
      entity = 'payment';
      finalAction = 'payment.capture';
    }

    await db.query(
      `
      INSERT INTO audit_logs
        (created_at, actor_id, entity, entity_id, action, related_entity, related_id,
         correlation_id, channel, amount, payment_method, provider_transaction_id, note, before_json, after_json)
      VALUES (NOW(), ?, ?, ?, ?, 'reservation', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        actorId || null,
        entity,
        reservationId || null,
        finalAction,
        related_id || null,
        correlation_id,
        channel,
        amount,
        payment_method,
        provider_transaction_id,
        note,
        before_json,
        after_json
      ]
    );
  } catch (e) {
    console.warn('[audit] failed', e.message);
  }
}

function deriveBookingChannel(role, requested) {
  // agenții / șoferii / operatorii -> 'agent'; altfel 'online' (sau ce vine explicit)
  if (role === 'agent' || role === 'driver' || role === 'operator_admin' || role === 'admin') {
    return 'agent';
  }
  return requested === 'agent' ? 'agent' : 'online';
}



async function touchTravelerDefault(phone, routeId, boardStationId, exitStationId, direction) {
  try {
    const cleanPhone = sanitizePhone(phone);
    const normDirection = ensureDirection(direction);
    if (
      !cleanPhone ||
      !Number.isInteger(routeId) ||
      !Number.isInteger(boardStationId) ||
      !Number.isInteger(exitStationId) ||
      !normDirection
    ) {
      return;
    }

    const existing = await db.query(
      'SELECT id FROM traveler_defaults WHERE phone = ? AND route_id = ? AND direction = ? LIMIT 1',
      [cleanPhone, routeId, normDirection],
    );

    let targetId = existing.rows[0]?.id || null;
    if (!targetId) {
      const legacy = await db.query(
        'SELECT id FROM traveler_defaults WHERE phone = ? AND route_id = ? LIMIT 1',
        [cleanPhone, routeId],
      );
      targetId = legacy.rows[0]?.id || null;
    }

    if (targetId) {
      await db.query(
        `
          UPDATE traveler_defaults
             SET board_station_id = ?,
                 exit_station_id  = ?,
                 direction        = ?,
                 use_count        = use_count + 1,
                 last_used_at     = NOW()
           WHERE id = ?
        `,
        [boardStationId, exitStationId, normDirection, targetId],
      );
    } else {
      await db.query(
        `
          INSERT INTO traveler_defaults
            (phone, route_id, direction, board_station_id, exit_station_id, use_count, last_used_at)
          VALUES
            (?, ?, ?, ?, ?, 1, NOW())
        `,
        [cleanPhone, routeId, normDirection, boardStationId, exitStationId],
      );
    }
  } catch (err) {
    console.error('[reservations] traveler_defaults update error', err);
  }
}

async function getStops(routeId, direction = 'tur') {
  const norm = normalizeDirection(direction);

  const result = await db.query(
    `
    SELECT rs.station_id, s.name
    FROM route_stations rs
    JOIN stations s ON s.id = rs.station_id
    WHERE rs.route_id = ?
    ORDER BY rs.sequence
    `,
    [routeId]
  );

  const base = result.rows.map(r => ({ id: r.station_id, name: r.name }));
  const orderedStops = isReturnDirection(norm) ? base.slice().reverse() : base;

  const ordered = orderedStops.map((stop, index) => ({ ...stop, index }));
  const indexById = new Map(ordered.map(stop => [String(stop.id), stop.index]));

  return { ordered, indexById };
}

async function validateSegmentAvailability({
  tripId,
  seatId,
  boardStationId,
  exitStationId,
  excludeReservationId = null,
}) {
  if (!tripId || !seatId || !boardStationId || !exitStationId) {
    return { ok: false, error: 'Date segment incomplete' };
  }

  const stationRes = await db.query(
    `SELECT station_id, sequence
       FROM trip_stations
      WHERE trip_id = ?
        AND station_id IN (?, ?)` ,
    [tripId, boardStationId, exitStationId]
  );

  if (stationRes.rowCount < 2) {
    return { ok: false, error: 'Stațiile nu aparțin cursei selectate' };
  }

  const seqMap = new Map(
    stationRes.rows.map((row) => [Number(row.station_id), Number(row.sequence)])
  );
  const boardSeq = seqMap.get(Number(boardStationId));
  const exitSeq = seqMap.get(Number(exitStationId));

  if (boardSeq === undefined || exitSeq === undefined) {
    return { ok: false, error: 'Stațiile nu aparțin cursei selectate' };
  }

  if (boardSeq >= exitSeq) {
    return { ok: false, error: 'Segment invalid' };
  }

  let overlapSql = `
    SELECT r.id, b.sequence AS board_seq, e.sequence AS exit_seq
      FROM reservations r
      JOIN trip_stations b
        ON b.trip_id = r.trip_id AND b.station_id = r.board_station_id
      JOIN trip_stations e
        ON e.trip_id = r.trip_id AND e.station_id = r.exit_station_id
     WHERE r.trip_id = ?
       AND r.seat_id = ?
       AND r.status = 'active'
  `;
  const params = [tripId, seatId];
  if (excludeReservationId) {
    overlapSql += ' AND r.id <> ?';
    params.push(excludeReservationId);
  }

  const existing = await db.query(overlapSql, params);
  const conflict = existing.rows.find((row) => {
    const existingBoard = Number(row.board_seq);
    const existingExit = Number(row.exit_seq);
    return !(existingExit <= boardSeq || existingBoard >= exitSeq);
  });

  if (conflict) {
    return { ok: false, error: 'Loc ocupat pe segment' };
  }

  return { ok: true, boardSeq, exitSeq };
}

async function resolveSchedule(routeId, { scheduleId, time, directionHint }) {
  const normDirection = directionHint ? normalizeDirection(directionHint) : null;

  if (scheduleId) {
    const { rows } = await db.query(
      `SELECT id, route_id, direction, TIME_FORMAT(departure, '%H:%i') AS departure
         FROM route_schedules
        WHERE id = ?
        LIMIT 1`,
      [scheduleId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (routeId && Number(row.route_id) !== Number(routeId)) {
      return { mismatch: true };
    }
    return {
      id: row.id,
      direction: normalizeDirection(row.direction),
      departure: row.departure,
    };
  }

  const timeVal = typeof time === 'string' ? time.slice(0, 5) : time;
  if (!timeVal) return null;

  let sql = `SELECT id, direction, TIME_FORMAT(departure, '%H:%i') AS departure
               FROM route_schedules
              WHERE route_id = ?
                AND TIME(departure) = TIME(?)`;
  const params = [routeId, timeVal];
  if (normDirection) {
    sql += ' AND direction = ?';
    params.push(normDirection);
  }
  sql += ' LIMIT 1';

  const { rows } = await db.query(sql, params);
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    direction: normalizeDirection(rows[0].direction),
    departure: rows[0].departure,
  };
}

const parseStationId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
};

const ensureStationId = (stopsInfo, value) => {
  const parsed = parseStationId(value);
  if (parsed === null) return null;
  return stopsInfo.indexById.has(String(parsed)) ? parsed : null;
};

const getStationIndex = (stopsInfo, stationId) => {
  if (stationId === null || stationId === undefined) return -1;
  const idx = stopsInfo.indexById.get(String(stationId));
  return idx === undefined ? -1 : idx;
};

function isPassengerValid(passenger) {
  const { name, phone } = passenger;
  const nameValid = !name || /^[a-zA-Z0-9ăîâșțĂÎÂȘȚ \-]+$/.test(name.trim());
  const cleanedPhone = phone?.replace(/\s+/g, '') || '';
  const phoneValid = !phone || /^(\+)?\d{10,}$/.test(cleanedPhone);
  const hasAtLeastOne = (name && name.trim()) || (phone && phone.trim());
  return hasAtLeastOne && nameValid && phoneValid;
}

/* ----------------------------- CREATE ----------------------------- */
/**
 * POST /api/reservations
 * Body: { date, time, route_id, vehicle_id, price_list_id, booking_channel, passengers: [...] }
 */
// POST /api/reservations
router.post('/', async (req, res) => {
  console.log('Primit payload:', req.body);
  if (await rejectIfActiveAgentJob(req, res)) return;

  const {
    date,
    time,
    route_id,
    route_schedule_id,
    direction,
    vehicle_id,
    price_list_id,
    booking_channel,
    pay_cash_now = false,
    cash_description,
    passengers,
  } = req.body;

  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing Idempotency-Key' });
  }

  const scheduleId = route_schedule_id ? Number(route_schedule_id) : null;
  const directionHint = direction || null;
  const timeValue = typeof time === 'string' ? time.slice(0, 5) : time;

  if (
    !date ||
    !route_id ||
    !vehicle_id ||
    (!scheduleId && !timeValue) ||
    !Array.isArray(passengers) ||
    passengers.length === 0
  ) {
    return res
      .status(400)
      .json({ error: 'date/time sau schedule_id/route_id/vehicle_id/passengers lipsă sau invalide' });
  }

  const userIdCandidate = Number(req.user?.id);
  const rawUserId = Number.isInteger(userIdCandidate) ? userIdCandidate : null;
  const idempotencyUserId = rawUserId ?? 0;

  const fetchIdempotencyRow = async () => {
    if (idempotencyUserId === 0) {
      const result = await db.query(
        `SELECT id, reservation_id
           FROM idempotency_keys
          WHERE idem_key = ? AND (user_id IS NULL OR user_id = 0)
          LIMIT 1`,
        [idempotencyKey]
      );
      return result.rows[0] || null;
    }

    const result = await db.query(
      `SELECT id, reservation_id
         FROM idempotency_keys
        WHERE user_id = ? AND idem_key = ?
        LIMIT 1`,
      [idempotencyUserId, idempotencyKey]
    );
    return result.rows[0] || null;
  };

  let existingIdempotency = await fetchIdempotencyRow();
  if (existingIdempotency) {
    return res.status(200).json({
      id: existingIdempotency.reservation_id !== null
        ? Number(existingIdempotency.reservation_id)
        : null,
      idempotent: true,
    });
  }

  let idempotencyRowId = null;
  let recordedReservationId = null;

  try {
    const insert = await db.query(
      `INSERT INTO idempotency_keys (user_id, idem_key) VALUES (?, ?)`,
      [idempotencyUserId, idempotencyKey]
    );
    idempotencyRowId = insert.insertId;
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      existingIdempotency = await fetchIdempotencyRow();
      if (!existingIdempotency) {
        console.warn('[Idempotency] ER_DUP_ENTRY dar nu găsesc rând pentru cheia asta');
      }
      const recordedId = existingIdempotency?.reservation_id;
      return res.status(200).json({
        id: recordedId != null ? Number(recordedId) : null,
        idempotent: true,
      });
    }

    console.error('[POST /api/reservations] idempotency insert failed', err);
    return res.status(500).json({ error: 'Eroare la inițializarea Idempotency-Key' });
  }

  const cleanupIdempotency = async () => {
    if (idempotencyRowId && recordedReservationId === null) {
      try {
        await db.query('DELETE FROM idempotency_keys WHERE id = ?', [idempotencyRowId]);
      } catch (cleanupErr) {
        console.warn('[POST /api/reservations] cleanup idempotency failed', cleanupErr);
      } finally {
        idempotencyRowId = null;
      }
    }
  };

  // ID-urile rezervărilor NOI create în acest request (pt. tipărire fiscală imediată)
  const createdReservationIds = [];
  const updatedReservations = [];

  const hasNewPassengers = passengers.some((p) => {
    const rid = Number(p?.reservation_id);
    return !Number.isInteger(rid) || rid <= 0;
  });

  // ─────────────────────────────────────────────────────────────────────
  // 0) PREP PROMO: O singură tranzacție dedicată promo-ului pe tot request-ul
  // ─────────────────────────────────────────────────────────────────────
  const promoPayload = req.body?.promo_apply || null;
  let promoConn = null;     // conexiune tranzacțională pt. lock
  let promoMeta = null;     // { id, code, value_off, max_total_uses }
  let promoRemaining = 0;   // cât mai e de împărțit din reducerea totală

  const abortWithError = async (status, payload) => {
    if (promoConn) {
      try { await promoConn.rollback(); } catch (_) { /* ignore */ }
      try { promoConn.release(); } catch (_) { /* ignore */ }
      promoConn = null;
    }
    await cleanupIdempotency();
    return res.status(status).json(payload);
  };

  // validare pasageri (minim: nume/telefon conform utilitarului tău)
  for (const p of passengers) {
    if (!isPassengerValid(p)) {
      return abortWithError(400, { error: 'Datele pasagerului nu sunt valide (nume sau telefon).' });
    }
  }

  if (promoPayload && promoPayload.code && Number(promoPayload.discount_amount) > 0) {
    try {
      promoConn = await db.getConnection();
      await promoConn.beginTransaction();

      const [lockRows] = await promoConn.query(
        `SELECT id, code, max_total_uses, value_off
           FROM promo_codes
          WHERE id = ? AND UPPER(code) = UPPER(?) AND active = 1
          FOR UPDATE`,
        [promoPayload.promo_code_id || 0, promoPayload.code]
      );
      const row = lockRows?.[0] || null;
      if (!row) {
        // cod inactiv/invalid → nu blocăm salvarea
        await promoConn.rollback();
        promoConn.release();
        promoConn = null;
      } else {
        const [usedRows] = await promoConn.query(
          `SELECT COUNT(*) AS c FROM promo_code_usages WHERE promo_code_id = ?`,
          [row.id]
        );
        const usedCount = Number(usedRows?.[0]?.c || 0);
        if (row.max_total_uses && usedCount >= row.max_total_uses) {
          // limită atinsă
          await promoConn.rollback();
          promoConn.release();
          promoConn = null;
        } else {
          promoMeta = row;
          promoRemaining = Number(promoPayload.discount_amount || 0);
        }
      }
    } catch (e) {
      // orice eroare pe promo nu trebuie să oprească rezervarea
      try { if (promoConn) { await promoConn.rollback(); promoConn.release(); } } catch { }
      promoConn = null;
      promoMeta = null;
      promoRemaining = 0;
      console.warn('Promo init skipped:', e.message);
    }
  }

  try {
    const onlineSettings = await getOnlineSettings();
    const scheduleInfo = await resolveSchedule(route_id, {
      scheduleId,
      time: timeValue,
      directionHint,
    });

    if (!scheduleInfo) {
      return abortWithError(404, { error: 'Programare inexistentă pentru rută/oră' });
    }
    if (scheduleInfo.mismatch) {
      return abortWithError(400, { error: 'Programarea nu aparține rutei selectate' });
    }

    const resolvedScheduleId = scheduleInfo.id;
    const resolvedDirection = scheduleInfo.direction;
    const canonicalTime = timeValue || scheduleInfo.departure;

    if (!canonicalTime) {
      return abortWithError(400, { error: 'Ora plecării nu a putut fi determinată' });
    }

    if (onlineSettings?.blockPastReservations && hasNewPassengers) {
      const tripDateTime = buildDateTimeFromDateAndTime(date, canonicalTime);
      if (tripDateTime && tripDateTime.getTime() < Date.now()) {
        return abortWithError(409, {
          error: 'Nu poți crea rezervări noi pentru curse care au plecat deja.',
        });
      }
    }

    // 1) stațiile rutei
    const stopsInfo = await getStops(route_id, resolvedDirection);
    if (!stopsInfo.ordered.length) {
      return abortWithError(400, { error: 'Ruta nu are stații definite' });
    }

    // 2) trip existent sau îl creăm
    let trip_id;
    const tripRes = await db.query(
      `SELECT
          t.id,
          tv.id AS trip_vehicle_id,
          COALESCE(tv.boarding_started, 0) AS boarding_started
        FROM trips t
        LEFT JOIN trip_vehicles tv ON tv.trip_id = t.id AND tv.vehicle_id = ?
        WHERE t.route_schedule_id = ?
          AND t.date = DATE(?)
          AND TIME(t.time) = TIME(?)
        LIMIT 1`,
      [vehicle_id, resolvedScheduleId, date, canonicalTime]
    );
    if (tripRes.rows.length > 0) {
      const existingTrip = tripRes.rows[0];
      if (Number(existingTrip.boarding_started)) {
        if (hasNewPassengers) {
          return abortWithError(409, { error: 'Îmbarcarea a început pentru această cursă. Nu se mai pot face rezervări noi.' });
        }
      }
      trip_id = existingTrip.id;
      const { rows: tvRows } = await db.query(
        `SELECT id, is_primary FROM trip_vehicles WHERE trip_id = ? AND vehicle_id = ? LIMIT 1`,
        [trip_id, vehicle_id]
      );
      if (!tvRows.length) {
        await db.query(
          `INSERT INTO trip_vehicles (trip_id, vehicle_id, is_primary)
           VALUES (?, ?, 0)
           ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary)`,
          [trip_id, vehicle_id]
        );
        const { rows: primaryRows } = await db.query(
          `SELECT 1 FROM trip_vehicles WHERE trip_id = ? AND is_primary = 1 LIMIT 1`,
          [trip_id]
        );
        if (!primaryRows.length) {
          await db.query(
            `UPDATE trip_vehicles SET is_primary = 1 WHERE trip_id = ? AND vehicle_id = ?`,
            [trip_id, vehicle_id]
          );
        }
      }
    } else {
      const ins = await db.query(
        `INSERT INTO trips (route_schedule_id, route_id, date, time)
         VALUES (?, ?, ?, TIME(?))`,
        [resolvedScheduleId, route_id, date, canonicalTime]
      );
      trip_id = ins.insertId;
      await db.query(
        `INSERT INTO trip_vehicles (trip_id, vehicle_id, is_primary)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary)`,
        [trip_id, vehicle_id]
      );
    }

    // 3) pasageri (creăm/actualizăm rezervări, calcule, plăți)
    for (const p of passengers) {
      const boardStationId = ensureStationId(stopsInfo, p.board_station_id);
      const exitStationId = ensureStationId(stopsInfo, p.exit_station_id);
      if (boardStationId === null || exitStationId === null) {
        return abortWithError(400, { error: 'Stație de urcare/coborâre invalidă pentru pasager.' });
      }

      // 3.1) persoana (UPSERȚ + realocare după telefon, dacă aparține altcuiva)
      const name = (p.name || '').trim();
      const phone = p.phone ? p.phone.replace(/\D/g, '') : null;

      const seatId = Number(p.seat_id);
      if (!Number.isInteger(seatId)) {
        return abortWithError(400, { error: 'seat_id invalid' });
      }

      let existingReservation = null;
      if (p.reservation_id) {
        const existingRes = await db.query(
          `SELECT r.id,
                  r.person_id,
                  r.trip_id,
                  r.seat_id,
                  r.board_station_id,
                  r.exit_station_id,
                  r.version,
                  r.observations,
                  p.name  AS person_name,
                  p.phone AS person_phone
             FROM reservations r
        LEFT JOIN people p ON p.id = r.person_id
            WHERE r.id = ?
            LIMIT 1`,
          [p.reservation_id]
        );
        existingReservation = existingRes.rows[0] || null;
        if (!existingReservation) {
          return abortWithError(404, { error: 'Rezervarea nu a fost găsită' });
        }
      }

      // persoana curentă, dacă e editare (din payload sau din rezervarea existentă)
      let currentPersonId = null;
      if (p.person_id && Number.isInteger(Number(p.person_id))) {
        currentPersonId = Number(p.person_id);
      } else if (existingReservation) {
        currentPersonId = existingReservation.person_id || null;
      }

      // folosim helper-ul deja definit în fișier
      const { personId: resolvedPersonId } = await upsertPersonForReservation({
        name,
        phone,
        currentPersonId,
        actorId: Number(req.user?.id) || null,
      });
      const person_id = resolvedPersonId || currentPersonId || null;

      const targetTripId = existingReservation ? Number(existingReservation.trip_id) : Number(trip_id);

      const segmentCheck = await validateSegmentAvailability({
        tripId: targetTripId,
        seatId,
        boardStationId,
        exitStationId,
        excludeReservationId: existingReservation ? Number(existingReservation.id) : null,
      });

      if (!segmentCheck.ok) {
        const statusCode = segmentCheck.error === 'Loc ocupat pe segment' ? 409 : 400;
        return abortWithError(statusCode, { error: segmentCheck.error });
      }

      // 3.2) rezervare: update sau insert nou
      if (existingReservation) {
        const expectedVersion = Number(p.version);
        if (!Number.isInteger(expectedVersion)) {
          return abortWithError(400, { error: 'Lipsește câmpul version' });
        }

        const updateRes = await db.query(
          `
          UPDATE reservations
             SET person_id        = ?,
                 seat_id          = ?,
                 board_station_id = ?,
                 exit_station_id  = ?,
                 observations     = ?,
                 version          = version + 1
          WHERE id = ? AND version = ?
          `,
          [person_id, seatId, boardStationId, exitStationId, p.observations || null, p.reservation_id, expectedVersion]
        );

        if (updateRes.rowCount === 0) {
          return abortWithError(409, { error: 'Versiune depășită' });
        }

        const newVersion = expectedVersion + 1;
        updatedReservations.push({ id: Number(p.reservation_id), version: newVersion });

        await touchTravelerDefault(phone, Number(route_id), boardStationId, exitStationId, resolvedDirection);
        await logEvent(p.reservation_id, 'update', Number(req.user?.id) || null, {
          person_id,
          seat_id: seatId,
          board_station_id: boardStationId,
          exit_station_id: exitStationId,
          version: newVersion,
          before: existingReservation
            ? {
              person_id: existingReservation.person_id,
              name: existingReservation.person_name || null,
              phone: existingReservation.person_phone || null,
              seat_id: existingReservation.seat_id,
              board_station_id: existingReservation.board_station_id,
              exit_station_id: existingReservation.exit_station_id,
              observations: existingReservation.observations || null,
            }
            : null,
          after: {
            person_id,
            name,
            phone,
            seat_id: seatId,
            board_station_id: boardStationId,
            exit_station_id: exitStationId,
            observations: p.observations || null,
          },
        });

        await db.query(
          `DELETE FROM reservation_intents WHERE trip_id = ? AND seat_id = ?`,
          [targetTripId, seatId]
        );

        // Recalculăm pricing/discount și la update (schimbare segment, tip reducere etc.)
        const basePrice = Number(p.price ?? 0);
        let typeDiscountAmount = 0;

        await db.query(
          `DELETE FROM reservation_discounts WHERE reservation_id = ?`,
          [p.reservation_id]
        );

        if (p.discount_type_id) {
          const qDisc = await db.query(
            `SELECT id, code, label, value_off, type FROM discount_types WHERE id = ?`,
            [p.discount_type_id]
          );
          if (!qDisc.rows.length) throw new Error('Tip de discount inexistent');
          const disc = qDisc.rows[0];

          typeDiscountAmount =
            disc.type === 'percent'
              ? +(basePrice * Number(disc.value_off) / 100).toFixed(2)
              : +Number(disc.value_off);
          if (typeDiscountAmount > basePrice) typeDiscountAmount = basePrice;

          await db.query(
            `
            INSERT INTO reservation_discounts
              (reservation_id, discount_type_id, discount_amount, discount_snapshot)
            VALUES (?, ?, ?, ?)
            `,
            [p.reservation_id, disc.id, typeDiscountAmount, Number(disc.value_off)]
          );
        }

        const netPrice = Math.max(0, basePrice - Number(typeDiscountAmount || 0));
        const listId = p.price_list_id || price_list_id;
        if (!listId) throw new Error('price_list_id lipsă în payload');

        const effChannel = deriveBookingChannel(req.user?.role, booking_channel);
        const pricingUpdate = await db.query(
          `
          UPDATE reservation_pricing
             SET price_value = ?,
                 price_list_id = ?,
                 pricing_category_id = ?,
                 booking_channel = ?,
                 employee_id = ?
           WHERE reservation_id = ?
          `,
          [netPrice, listId, p.category_id, effChannel, Number(req.user?.id) || null, p.reservation_id]
        );

        if (pricingUpdate.rowCount === 0) {
          await db.query(
            `
            INSERT INTO reservation_pricing
              (reservation_id, price_value, price_list_id, pricing_category_id, booking_channel, employee_id)
            VALUES (?, ?, ?, ?, ?, ?)
            `,
            [p.reservation_id, netPrice, listId, p.category_id, effChannel, Number(req.user?.id) || null]
          );
        }

      } else {
        // INSERT rezervare
        const insRes = await db.query(
          `
          INSERT INTO reservations
            (trip_id, seat_id, person_id, board_station_id, exit_station_id, observations, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
          `,
          [trip_id, seatId, person_id, boardStationId, exitStationId, p.observations || null, Number(req.user?.id) || null]
        );
        const newResId = insRes.insertId;
        createdReservationIds.push(newResId);

        await touchTravelerDefault(phone, Number(route_id), boardStationId, exitStationId, resolvedDirection);
        await logEvent(newResId, 'create', Number(req.user?.id) || null, {
          trip_id, seat_id: seatId, person_id, board_station_id: boardStationId, exit_station_id: exitStationId
        });

        await db.query(
          `DELETE FROM reservation_intents WHERE trip_id = ? AND seat_id = ?`,
          [trip_id, seatId]
        );

        // 3.3) Discount (opțional) — tipuri standard (elev/student/etc.)
        let typeDiscountAmount = 0;
        if (p.discount_type_id) {
          const qDisc = await db.query(
            `SELECT id, code, label, value_off, type FROM discount_types WHERE id = ?`,
            [p.discount_type_id]
          );
          if (!qDisc.rows.length) throw new Error('Tip de discount inexistent');
          const disc = qDisc.rows[0];

          const basePrice = Number(p.price ?? 0);
          typeDiscountAmount =
            disc.type === 'percent'
              ? +(basePrice * Number(disc.value_off) / 100).toFixed(2)
              : +Number(disc.value_off);
          if (typeDiscountAmount > basePrice) typeDiscountAmount = basePrice;

          await db.query(
            `
            INSERT INTO reservation_discounts
              (reservation_id, discount_type_id, discount_amount, discount_snapshot)
            VALUES (?, ?, ?, ?)
            `,
            [newResId, disc.id, typeDiscountAmount, Number(disc.value_off)]
          );
        }

        // 3.4) APLICARE PROMO (dacă există și mai avem sumă disponibilă)
        let promoPiece = 0;
        if (promoConn && promoMeta && promoRemaining > 0) {
          // baza după discountul de tip
          const baseAfterType = Math.max(0, Number(p.price ?? 0) - Number(typeDiscountAmount || 0));
          if (baseAfterType > 0) {
            promoPiece = Math.min(promoRemaining, baseAfterType);
            if (promoPiece > 0) {
              // înregistrăm reducerea promo pe rezervare
              await promoConn.query(
                `
                INSERT INTO reservation_discounts
                  (reservation_id, discount_type_id, promo_code_id, discount_amount, discount_snapshot)
                VALUES (?, NULL, ?, ?, ?)
                `,
                [newResId, promoMeta.id, promoPiece, Number(promoMeta.value_off)]
              );
              // log folosire (pentru limitări/statistici)
              await promoConn.query(
                `
                INSERT INTO promo_code_usages (promo_code_id, reservation_id, phone, discount_amount)
                VALUES (?, ?, ?, ?)
                `,
                [promoMeta.id, newResId, phone || null, promoPiece]
              );
              promoRemaining = +(promoRemaining - promoPiece).toFixed(2);
            }
          }
        }

        // 3.5) Pricing (după discount de tip + promo)
        const netPrice = Math.max(
          0,
          Number(p.price ?? 0) - Number(typeDiscountAmount || 0) - Number(promoPiece || 0)
        );
        const listId = p.price_list_id || price_list_id;
        if (!listId) throw new Error('price_list_id lipsă în payload');


        // booking_channel corect + employee_id real la pricing
        const effChannel = deriveBookingChannel(req.user?.role, booking_channel);
        await db.query(
          `
          INSERT INTO reservation_pricing
            (reservation_id, price_value, price_list_id, pricing_category_id, booking_channel, employee_id)
          VALUES (?, ?, ?, ?, ?, ?)
          `,
          [newResId, netPrice, listId, p.category_id, effChannel, Number(req.user?.id) || null]
        );

        // 3.6) Plată (opțional) – DOAR CARD aici.
        // CASH se face ulterior prin POST /api/reservations/:id/payments/cash (tipărește și marchează paid)
        if (p.payment_method === 'card' && p.provider_transaction_id) {
          await db.query(
            `
            INSERT INTO payments
              (reservation_id, amount, status, payment_method, provider_transaction_id, timestamp)
            VALUES (?, ?, 'paid', 'card', ?, NOW())
            `,
            [newResId, netPrice, p.provider_transaction_id]
          );
          await logEvent(newResId, 'pay', Number(req.user?.id) || null, { method: 'card', amount: netPrice });
        }
        // Pentru cash: frontend va apela ulterior
        //   POST /api/reservations/:id/payments/cash
        // care tipărește și DOAR apoi marchează plata în DB.
      }
    } // end for passengers

    // finalizează tranzacția promo (dacă a existat)
    if (promoConn) {
      await promoConn.commit();
      promoConn.release();
      promoConn = null;
    }

    recordedReservationId = createdReservationIds[0] ?? updatedReservations[0]?.id ?? null;
    if (idempotencyRowId) {
      await db.query(
        'UPDATE idempotency_keys SET reservation_id = ? WHERE id = ?',
        [recordedReservationId, idempotencyRowId]
      );
      idempotencyRowId = null;
    }

    const responsePayload = {
      ok: true,
      message: 'Rezervare salvată',
      createdReservationIds,
    };

    if (updatedReservations.length) {
      responsePayload.updatedReservations = updatedReservations;
    }

    if (recordedReservationId !== null) {
      responsePayload.id = Number(recordedReservationId);
    }
    emitTripUpdate(trip_id);

    return res.status(201).json(responsePayload);
  } catch (err) {
    console.error('Eroare la salvarea rezervării:', err);
    // dacă a existat promoConn, asigură-te că nu rămâne deschisă
    try { if (promoConn) { await promoConn.rollback(); promoConn.release(); promoConn = null; } } catch { }
    await cleanupIdempotency();
    return res.status(500).json({ error: 'Eroare internă la salvare' });
  }
});








/* ----------------------------- PAYMENT SUMMARY ----------------------------- */
/**
 * GET /api/reservations/:id/summary
 * Returnează price_value din reservation_pricing și statusul plăților existente.
 */
router.get('/:id/summary', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    if (!reservationId) return res.status(400).json({ error: 'reservationId invalid' });

    // --- normalizează răspunsul la SELECT (merge cu mysql2 [rows,fields], cu rows simple sau cu .rows) ---
    const pricingRes = await db.query(
      `SELECT price_value FROM reservation_pricing WHERE reservation_id = ? LIMIT 1`,
      [reservationId]
    );
    const pricingRows = Array.isArray(pricingRes)
      ? (Array.isArray(pricingRes[0]) ? pricingRes[0] : pricingRes)
      : pricingRes?.rows;
    const price_value = pricingRows?.[0]?.price_value ?? null;

    const paidRes = await db.query(
      `SELECT IFNULL(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_amount
       FROM payments WHERE reservation_id = ?`,
      [reservationId]
    );
    const paidRows = Array.isArray(paidRes)
      ? (Array.isArray(paidRes[0]) ? paidRes[0] : paidRes)
      : paidRes?.rows;
    const paid_amount = paidRows?.[0]?.paid_amount ?? 0;

    res.json({
      reservationId,
      price: Number(price_value || 0),
      amountPaid: Number(paid_amount || 0),
      paid: Number(price_value || 0) > 0 ? Number(paid_amount) >= Number(price_value) : paid_amount > 0
    });
  } catch (err) {
    console.error('[GET /api/reservations/:id/summary]', err);
    res.status(500).json({ error: 'Eroare la summary' });
  }
});


// ---------------------- CARD INTENT (no DB write) ----------------------
const POS_BASE_URL = process.env.POS_BASE_URL || 'http://127.0.0.1:9100';

router.post('/:id/payments/card-intent', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    if (!reservationId) {
      return res.status(400).json({ error: 'reservationId invalid' });
    }

    const employeeId = Number(req.body?.employeeId || req.user?.id || 0) || null;

    // 1) suma rămasă = price_value - SUM(paid)
    const pricingRes = await db.query(
      `SELECT price_value FROM reservation_pricing WHERE reservation_id = ? LIMIT 1`,
      [reservationId]
    );
    const pricingRows = Array.isArray(pricingRes)
      ? (Array.isArray(pricingRes[0]) ? pricingRes[0] : pricingRes)
      : pricingRes?.rows;
    const price_value = Number(pricingRows?.[0]?.price_value || 0);

    const paidRes = await db.query(
      `SELECT IFNULL(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_amount
         FROM payments WHERE reservation_id = ?`,
      [reservationId]
    );
    const paidRows = Array.isArray(paidRes)
      ? (Array.isArray(paidRes[0]) ? paidRes[0] : paidRes)
      : paidRes?.rows;
    const alreadyPaid = Number(paidRows?.[0]?.paid_amount || 0);

    const amount = +(price_value - alreadyPaid).toFixed(2);
    if (!(amount > 0)) {
      return res.status(409).json({ error: 'Rezervare deja achitată' });
    }

    // 2) operatorul din cursă (rezervare -> trip -> route_schedule -> operator_id)
    const opRow = await db.query(
      `SELECT rs.operator_id
         FROM reservations r
         JOIN trips t ON t.id = r.trip_id
         JOIN route_schedules rs ON rs.id = t.route_schedule_id
        WHERE r.id = ?
        LIMIT 1`,
      [reservationId]
    );
    const opId = Number(
      (Array.isArray(opRow) ? (Array.isArray(opRow[0]) ? opRow[0] : opRow) : opRow?.rows)?.[0]?.operator_id || 0
    );
    if (!opId) {
      return res.status(409).json({ error: 'Nu am putut determina operatorul cursei' });
    }

    const dev = devForOperatorId(opId); // 'A' | 'B'
    const base = POS_BASE_URL;
    const priceStr = toMoneyDot(amount, 2); // "12.34"

    // Aici DEFINIM protocolul cu serverul POS.
    // Tu vei face un server gen "server-multi-device.js" pentru POS,
    // care va expune /pos/sale?dev=A și primește { amount: "12.34", currency: "RON" }.
    return res.json({
      ok: true,
      status: 'pending',
      reservationId,
      amount,
      dev,
      employeeId,
      pos: {
        sale: {
          url: `${base}/pos/sale?dev=${dev}`,
          body: {
            amount: priceStr,
            currency: 'RON',
            description: `Rezervare #${reservationId}`,
          },
        },
      },
    });
  } catch (err) {
    console.error('[POST /api/reservations/:id/payments/card-intent]', err);
    return res.status(500).json({ error: 'Eroare la generarea intent-ului pentru card' });
  }
});


// ---------------------- CASH INTENT (no DB write) ----------------------
router.post('/:id/payments/cash-intent', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    if (!reservationId) return res.status(400).json({ error: 'reservationId invalid' });

    const employeeId = Number(req.body?.employeeId || req.user?.id || 0) || null;

    // 1) suma rămasă = price_value - SUM(paid)
    const pricingRes = await db.query(
      `SELECT price_value FROM reservation_pricing WHERE reservation_id = ? LIMIT 1`,
      [reservationId]
    );
    const pricingRows = Array.isArray(pricingRes)
      ? (Array.isArray(pricingRes[0]) ? pricingRes[0] : pricingRes)
      : pricingRes?.rows;
    const price_value = Number(pricingRows?.[0]?.price_value || 0);

    const paidRes = await db.query(
      `SELECT IFNULL(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_amount
         FROM payments WHERE reservation_id = ?`,
      [reservationId]
    );
    const paidRows = Array.isArray(paidRes)
      ? (Array.isArray(paidRes[0]) ? paidRes[0] : paidRes)
      : paidRes?.rows;
    const alreadyPaid = Number(paidRows?.[0]?.paid_amount || 0);

    const amount = +(price_value - alreadyPaid).toFixed(2);
    if (!(amount > 0)) return res.status(409).json({ error: 'Rezervare deja achitată' });

    // 2) operatorul din cursă (rezervare -> trip -> route_schedule -> operator_id)
    const opRow = await db.query(
      `SELECT rs.operator_id
         FROM reservations r
         JOIN trips t ON t.id = r.trip_id
         JOIN route_schedules rs ON rs.id = t.route_schedule_id
        WHERE r.id = ?
        LIMIT 1`,
      [reservationId]
    );
    const opId = Number(
      (Array.isArray(opRow) ? (Array.isArray(opRow[0]) ? opRow[0] : opRow) : opRow?.rows)?.[0]?.operator_id || 0
    );
    if (!opId) return res.status(409).json({ error: 'Nu am putut determina operatorul cursei' });

    const dev = devForOperatorId(opId);     // 'A' | 'B'
    const base = 'http://127.0.0.1:9000';
    const receiptTemplate = await getFiscalReceiptTemplate();
    const receiptMeta = await loadReservationReceiptMeta(reservationId);
    const desc = renderReceiptDescription({
      reservationId,
      template: receiptTemplate,
      meta: receiptMeta,
      fallbackText: `Rezervare #${reservationId}`
    });

    const priceStr = toMoneyDot(amount, 2);

    // ✅ Împărțim descrierea în linii
    const lines = desc.split('\n').filter(l => l.trim());
    const firstLine = lines[0] || `Bilet calatorie #${reservationId}`;
    const additionalLines = lines.slice(1);

    // Construim array-ul de comenzi fiscale
    const fiscalCommands = [
      { url: `${base}/fiscal/open?dev=${dev}`, body: { operator: '30', password: '0030', till: '1' } },
      { url: `${base}/fiscal/sale?dev=${dev}`, body: { name: firstLine.slice(0, 72), tax: '1', price: priceStr, quantity: '1.000', department: '1', unit: 'BUC' } }
    ];

    // Adăugăm liniile suplimentare ca text fiscal
    for (const line of additionalLines) {
      if (line.trim()) {
        fiscalCommands.push({
          url: `${base}/fiscal/text?dev=${dev}`,
          body: { text: line.slice(0, 48) }
        });
      }
    }

    // Adăugăm plata și închiderea
    fiscalCommands.push(
      { url: `${base}/fiscal/pay?dev=${dev}`, body: { mode: 'cash', amount: priceStr } },
      { url: `${base}/fiscal/close?dev=${dev}`, body: {} }
    );

    return res.json({
      ok: true,
      status: 'pending',
      print_in_browser: true,
      reservationId,
      amount,
      dev,
      fiscal: fiscalCommands  // ✅ Array complet de comenzi
    });
  } catch (err) {
    console.error('[POST /api/reservations/:id/payments/cash-intent]', err);
    return res.status(500).json({ error: 'Eroare la inițierea plății cash' });
  }
});


// ---------------------- CASH VIA AGENT (payments + agent_jobs) ----------------------
router.post('/:id/payments/cash-agent', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    if (!reservationId) {
      return res.status(400).json({ error: 'reservationId invalid' });
    }

    const employeeId = Number(req.body?.employeeId || req.user?.id || 0) || null;

    const terminalId = Number(req.user?.terminal_id);
    if (!terminalId) {
      return res.status(409).json({ error: 'Terminal lipsă în sesiune. Re-login necesar.' });
    }
    if (await rejectIfActiveAgentJob(req, res)) return;


    // 1) suma rămasă = price_value - SUM(paid)
    const pricingRes = await db.query(
      `SELECT price_value FROM reservation_pricing WHERE reservation_id = ? LIMIT 1`,
      [reservationId]
    );
    const pricingRows = Array.isArray(pricingRes)
      ? (Array.isArray(pricingRes[0]) ? pricingRes[0] : pricingRes)
      : pricingRes?.rows;
    const price_value = Number(pricingRows?.[0]?.price_value || 0);

    const paidRes = await db.query(
      `SELECT IFNULL(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_amount
         FROM payments WHERE reservation_id = ?`,
      [reservationId]
    );
    const paidRows = Array.isArray(paidRes)
      ? (Array.isArray(paidRes[0]) ? paidRes[0] : paidRes)
      : paidRes?.rows;
    const alreadyPaid = Number(paidRows?.[0]?.paid_amount || 0);

    const amount = +(price_value - alreadyPaid).toFixed(2);
    if (!(amount > 0)) {
      return res.status(409).json({ error: 'Rezervare deja achitată' });
    }

    // 1.5) operatorul din cursă (rezervare -> trip -> route_schedule -> operator_id)
    const opRow = await db.query(
      `SELECT rs.operator_id
         FROM reservations r
         JOIN trips t ON t.id = r.trip_id
         JOIN route_schedules rs ON rs.id = t.route_schedule_id
        WHERE r.id = ?
        LIMIT 1`,
      [reservationId]
    );
    const opId = Number(
      (Array.isArray(opRow) ? (Array.isArray(opRow[0]) ? opRow[0] : opRow) : opRow?.rows)?.[0]?.operator_id || 0
    );
    if (!opId) return res.status(409).json({ error: 'Nu am putut determina operatorul cursei' });

    const dev = devForOperatorId(opId); // 'A' | 'B'

    const receiptTemplate = await getFiscalReceiptTemplate();
    const receiptMeta = await loadReservationReceiptMeta(reservationId);
    const desc = renderReceiptDescription({
      reservationId,
      template: receiptTemplate,
      meta: receiptMeta,
      fallbackText: `Rezervare #${reservationId}`
    });

    // 2) INSERT în payments: pending, cash, fără bon deocamdată
    const payIns = await db.query(
      `INSERT INTO payments
         (reservation_id, amount, status, payment_method, provider_transaction_id, timestamp, collected_by, receipt_status)
       VALUES (?, ?, 'pending', 'cash', NULL, NOW(), ?, 'none')`,
      [reservationId, amount, employeeId]
    );
    const paymentId = payIns.insertId;

    // 3) INSERT în agent_jobs: job pentru bon cash
    // ✅ Împărțim descrierea în linii
    const lines = desc.split('\n').filter(l => l.trim());

    const payload = {
      reservation_id: reservationId,
      payment_id: paymentId,
      amount,
      currency: 'RON',
      description: desc,  // ✅ Păstrăm întreaga descriere (agent.js o va împărți)
      dev,
    };


    const jobIns = await db.query(
      `INSERT INTO agent_jobs
     (reservation_id, payment_id, target_terminal_id, job_type, status, payload)
   VALUES (?, ?, ?, 'cash_receipt_only', 'queued', ?)`,
      [
        reservationId,
        paymentId,
        terminalId,
        JSON.stringify(payload),
      ]
    );

    req.app
      .get('io')
      ?.of('/agent')
      ?.to(`terminal:${terminalId}`)
      ?.emit('agent:wakeup');


    const jobId = jobIns.insertId;

    // (opțional) log în audit, dacă vrei
    // await logEvent(reservationId, 'pay_request', employeeId, { method: 'cash', amount });

    return res.json({
      ok: true,
      reservationId,
      amount,
      status: 'pending',
      payment_id: paymentId,
      job_id: jobId,
    });
  } catch (err) {
    console.error('[POST /api/reservations/:id/payments/cash-agent]', err);
    return res.status(500).json({ error: 'Eroare inițiere plată cash (agent)' });
  }
});


// ---------------------- CARD VIA AGENT (POS + fiscal, payments + agent_jobs) ----------------------
router.post('/:id/payments/card-agent', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    if (!reservationId) {
      return res.status(400).json({ error: 'reservationId invalid' });
    }

    const employeeId = Number(req.body?.employeeId || req.user?.id || 0) || null;

    const terminalId = Number(req.user?.terminal_id);
    if (!terminalId) {
      return res.status(409).json({ error: 'Terminal lipsă în sesiune. Re-login necesar.' });
    }
    if (await rejectIfActiveAgentJob(req, res)) return;


    // 1) suma rămasă = price_value - SUM(paid)
    const pricingRes = await db.query(
      `SELECT price_value FROM reservation_pricing WHERE reservation_id = ? LIMIT 1`,
      [reservationId]
    );
    const pricingRows = Array.isArray(pricingRes)
      ? (Array.isArray(pricingRes[0]) ? pricingRes[0] : pricingRes)
      : pricingRes?.rows;
    const price_value = Number(pricingRows?.[0]?.price_value || 0);

    const paidRes = await db.query(
      `SELECT IFNULL(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END),0) AS paid_amount
         FROM payments WHERE reservation_id = ?`,
      [reservationId]
    );
    const paidRows = Array.isArray(paidRes)
      ? (Array.isArray(paidRes[0]) ? paidRes[0] : paidRes)
      : paidRes?.rows;
    const alreadyPaid = Number(paidRows?.[0]?.paid_amount || 0);

    const amount = +(price_value - alreadyPaid).toFixed(2);
    if (!(amount > 0)) {
      return res.status(409).json({ error: 'Rezervare deja achitată' });
    }

    // 2) operatorul din cursă (rezervare -> trip -> route_schedule -> operator_id)
    const opRow = await db.query(
      `SELECT rs.operator_id
         FROM reservations r
         JOIN trips t ON t.id = r.trip_id
         JOIN route_schedules rs ON rs.id = t.route_schedule_id
        WHERE r.id = ?
        LIMIT 1`,
      [reservationId]
    );
    const opId = Number(
      (Array.isArray(opRow) ? (Array.isArray(opRow[0]) ? opRow[0] : opRow) : opRow?.rows)?.[0]?.operator_id || 0
    );
    if (!opId) {
      return res.status(409).json({ error: 'Nu am putut determina operatorul cursei' });
    }

    const dev = devForOperatorId(opId); // 'A' | 'B'
    const receiptTemplate = await getFiscalReceiptTemplate();
    const receiptMeta = await loadReservationReceiptMeta(reservationId);
    const desc = renderReceiptDescription({
      reservationId,
      template: receiptTemplate,
      meta: receiptMeta,
      fallbackText: `Rezervare #${reservationId}`
    });

    // 3) INSERT în payments: pending, card, fără bon deocamdată
    const payIns = await db.query(
      `INSERT INTO payments
         (reservation_id, amount, status, payment_method, provider_transaction_id, timestamp, collected_by, receipt_status)
       VALUES (?, ?, 'pending', 'card', NULL, NOW(), ?, 'none')`,
      [reservationId, amount, employeeId]
    );
    const paymentId = payIns.insertId;

    // 4) INSERT în agent_jobs: job pentru POS + bon fiscal
    // ✅ Împărțim descrierea în linii
    const lines = desc.split('\n').filter(l => l.trim());

    const payload = {
      reservation_id: reservationId,
      payment_id: paymentId,
      pos_unique_id: paymentId,
      amount,
      currency: 'RON',
      description: desc,  // ✅ Păstrăm întreaga descriere (agent.js o va împărți)
      dev,
    };

    const jobIns = await db.query(
      `INSERT INTO agent_jobs
     (reservation_id, payment_id, target_terminal_id, job_type, status, payload)
   VALUES (?, ?, ?, 'card_and_receipt', 'queued', ?)`,
      [
        reservationId,
        paymentId,
        terminalId,
        JSON.stringify(payload),
      ]
    );

    req.app
      .get('io')
      ?.of('/agent')
      ?.to(`terminal:${terminalId}`)
      ?.emit('agent:wakeup');


    const jobId = jobIns.insertId;

    return res.json({
      ok: true,
      reservationId,
      amount,
      status: 'pending',
      payment_id: paymentId,
      job_id: jobId,
    });
  } catch (err) {
    console.error('[POST /api/reservations/:id/payments/card-agent]', err);

    const msgDetaliu = err && err.message ? ` (${err.message})` : '';
    return res.status(500).json({
      error: `Eroare inițiere plată card (agent)${msgDetaliu}`,
    });
  }
});

;

// ---------------------- CARD REFUND VIA AGENT (POS) ----------------------
router.post('/:id/refunds/card-agent', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    if (!reservationId) {
      return res.status(400).json({ error: 'reservationId invalid' });
    }

    const employeeId = Number(req.body?.employeeId || req.user?.id || 0) || null;
    const terminalId = Number(req.user?.terminal_id);
    if (!terminalId) {
      return res.status(409).json({ error: 'Terminal lipsă în sesiune. Re-login necesar.' });
    }
    if (await rejectIfActiveAgentJob(req, res)) return;

    const paymentRes = await db.query(
      `SELECT id, amount, status, payment_method, provider_transaction_id
         FROM payments
        WHERE reservation_id = ?
          AND payment_method = 'card'
          AND status IN ('paid','pos_ok_waiting_receipt')
        ORDER BY id DESC
        LIMIT 1`,
      [reservationId]
    );
    const paymentRows = Array.isArray(paymentRes)
      ? (Array.isArray(paymentRes[0]) ? paymentRes[0] : paymentRes)
      : paymentRes?.rows;

    const payment = paymentRows?.[0] || null;
    if (!payment) {
      return res.status(409).json({ error: 'Nu există o plată cu cardul finalizată pentru această rezervare.' });
    }
    if (payment.status === 'refunded') {
      return res.status(409).json({ error: 'Plata este deja refundată.' });
    }

    const existingRefunds = await db.query(
      `SELECT id, status FROM payment_refunds WHERE payment_id = ? AND status IN ('pending','succeeded') LIMIT 1`,
      [payment.id]
    );
    const existingRows = Array.isArray(existingRefunds)
      ? (Array.isArray(existingRefunds[0]) ? existingRefunds[0] : existingRefunds)
      : existingRefunds?.rows;

    if (existingRows?.length) {
      return res.status(409).json({ error: 'Există deja un refund pentru această plată.' });
    }

    const posMeta = safeJson(payment.provider_transaction_id || '');
    const posUniqueId = posMeta?.unique_id || payment.provider_transaction_id || null;
    if (!posUniqueId) {
      return res.status(409).json({ error: 'Lipsesc datele POS necesare pentru refund.' });
    }

    const posStanRaw = posMeta?.tags?.A109 ?? null; // STAN / Receipt number
    const posStan = posStanRaw != null ? String(posStanRaw).trim() : null;
    if (!posStan || !/^\d{6}$/.test(posStan)) {
      return res.status(409).json({
        error: 'Lipseste STAN (A109) pentru refund/void. Nu se poate face refund pe POS fara STAN.',
      });
    }

    const opRow = await db.query(
      `SELECT rs.operator_id
         FROM reservations r
         JOIN trips t ON t.id = r.trip_id
         JOIN route_schedules rs ON rs.id = t.route_schedule_id
        WHERE r.id = ?
        LIMIT 1`,
      [reservationId]
    );
    const opId = Number(
      (Array.isArray(opRow) ? (Array.isArray(opRow[0]) ? opRow[0] : opRow) : opRow?.rows)?.[0]?.operator_id || 0
    );
    if (!opId) {
      return res.status(409).json({ error: 'Nu am putut determina operatorul cursei' });
    }

    const dev = devForOperatorId(opId);
    const amount = Number(payment.amount || 0);
    if (!(amount > 0)) {
      return res.status(409).json({ error: 'Suma refund-ului nu este validă.' });
    }

    const refundIns = await db.query(
      `INSERT INTO payment_refunds
         (payment_id, amount, currency, status, provider, provider_transaction_id, provider_payload, reason, requested_by, requested_by_type, created_at)
       VALUES (?, ?, 'RON', 'pending', 'pos', ?, ?, 'pos_refund', ?, 'employee', NOW())`,
      [
        payment.id,
        amount,
        String(payment.provider_transaction_id || posUniqueId),
        JSON.stringify({ pos_meta: posMeta }),
        employeeId,
      ]
    );
    const refundId = refundIns.insertId;

    const payload = {
      reservation_id: reservationId,
      payment_id: payment.id,
      refund_id: refundId,
      amount,
      currency: 'RON',
      dev,
      pos_unique_id: posUniqueId,
      pos_stan: posStan,
      extra_tags: [],
    };

    const jobIns = await db.query(
      `INSERT INTO agent_jobs
         (reservation_id, payment_id, target_terminal_id, job_type, status, payload)
       VALUES (?, ?, ?, 'card_refund', 'queued', ?)`,
      [reservationId, payment.id, terminalId, JSON.stringify(payload)]
    );

    req.app
      .get('io')
      ?.of('/agent')
      ?.to(`terminal:${terminalId}`)
      ?.emit('agent:wakeup');

    const jobId = jobIns.insertId;

    return res.json({
      ok: true,
      reservationId,
      payment_id: payment.id,
      refund_id: refundId,
      job_id: jobId,
      status: 'pending',
    });
  } catch (err) {
    console.error('[POST /api/reservations/:id/refunds/card-agent]', err);
    return res.status(500).json({ error: 'Eroare inițiere refund POS (card)' });
  }
});

;




// ---------------------- RETRY BON FISCAL (manual, din agenție) ----------------------
// ---------------------- RETRY BON FISCAL (manual, din agenție) ----------------------
router.post('/:id/payments/:paymentId/retry-receipt', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);

    if (!reservationId || !paymentId) {
      return res.status(400).json({ error: 'ID rezervare sau plată invalid' });
    }

    const terminalId = Number(req.user?.terminal_id);
    if (!terminalId) {
      return res.status(409).json({ error: 'Terminal lipsă în sesiune. Re-login necesar.' });
    }
    if (await rejectIfActiveAgentJob(req, res)) return;


    // 1) Luăm plata + operatorul cursei
    const payRes = await db.query(
      `SELECT 
         p.*,
         r.trip_id,
         rs.operator_id
       FROM payments p
       JOIN reservations r ON r.id = p.reservation_id
       JOIN trips t ON t.id = r.trip_id
       JOIN route_schedules rs ON rs.id = t.route_schedule_id
       WHERE p.id = ? AND p.reservation_id = ?
       LIMIT 1`,
      [paymentId, reservationId]
    );

    const payRows = Array.isArray(payRes)
      ? (Array.isArray(payRes[0]) ? payRes[0] : payRes)
      : payRes?.rows;

    const payment = payRows?.[0];

    if (!payment) {
      return res.status(404).json({ error: ' găsită pentru această rezervare' });
    }

    // 2) Verificăm că e într-o stare care permite retry
    //    - pentru CARD: POS a luat banii, bonul a eșuat => nu repetăm POS
    //    - pentru CASH: retry înseamnă doar re-emitere bon fiscal (nu creăm payment nou)
    if ((payment.payment_method || '').toLowerCase() === 'card') {
      if (
        payment.status !== 'pos_ok_waiting_receipt' &&
        payment.status !== 'paid'
      ) {
        return res.status(409).json({
          error:
            'Plata nu este într-o stare potrivită pentru retry (CARD: trebuie să fie pos_ok_waiting_receipt sau paid)',
        });
      }
    }


    if (payment.receipt_status !== 'error_needs_retry') {
      return res.status(409).json({
        error: 'Bonul fiscal nu este marcat pentru retry (receipt_status trebuie să fie error_needs_retry)',
      });
    }

    const operatorId = Number(payment.operator_id || 0);
    if (!operatorId) {
      return res.status(409).json({
        error: 'Nu am putut determina operatorul pentru această plată',
      });
    }

    // 3) Resetăm doar receipt_status -> none (NU mai atingem error_message)
    await db.query(
      `UPDATE payments
         SET receipt_status = 'none'
       WHERE id = ?`,
      [paymentId]
    );

    // 4) Creăm un job nou retry_receipt pentru agent
    const dev = devForOperatorId(operatorId); // A / B

    const receiptTemplate = await getFiscalReceiptTemplate();
    const receiptMeta = await loadReservationReceiptMeta(payment.reservation_id);
    const description = renderReceiptDescription({
      reservationId: payment.reservation_id,
      template: receiptTemplate,
      meta: receiptMeta,
      fallbackText: `Rezervare #${payment.reservation_id}`
    });

    const payload = {
      reservation_id: payment.reservation_id,
      payment_id: payment.id,
      amount: payment.amount,
      currency: 'RON',
      description,
      dev,
      payment_method: payment.payment_method,
    };

    const jobIns = await db.query(
      `INSERT INTO agent_jobs
     (reservation_id, payment_id, target_terminal_id, job_type, status, payload)
   VALUES (?, ?, ?, 'retry_receipt', 'queued', ?)`,
      [
        payment.reservation_id,
        payment.id,
        terminalId,
        JSON.stringify(payload),
      ]
    );
    req.app
      .get('io')
      ?.of('/agent')
      ?.to(`terminal:${terminalId}`)
      ?.emit('agent:wakeup');


    const jobId =
      jobIns.insertId ||
      (Array.isArray(jobIns) && jobIns[0] && jobIns[0].insertId) ||
      null;

    console.log(
      '[retry-receipt] job nou creat',
      { reservationId, paymentId, jobId }
    );

    return res.json({
      ok: true,
      reservationId,
      paymentId,
      job_id: jobId,
    });
  } catch (err) {
    console.error(
      '[POST /api/reservations/:id/payments/:paymentId/retry-receipt] EROARE:',
      err
    );
    return res
      .status(500)
      .json({ error: 'Eroare inițiere retry bon fiscal' });
  }
});
;


/* ---------------------- CASH/CARD CONFIRM (writes DB) ---------------------- */
/* POST /api/reservations/:id/payments/confirm */
router.post('/:id/payments/confirm', async (req, res) => {
  try {
    const reservationId = Number(req.params.id);
    const employeeId = Number(req.body?.employeeId || req.user?.id || 0) || null;
    const amount = Number(req.body?.amount || 0);
    const paymentMethod = (req.body?.payment_method === 'card') ? 'card' : 'cash';
    const transactionId = (req.body?.provider_transaction_id || null) || null;

    if (!reservationId || !(amount > 0)) {
      return res.status(400).json({ error: 'invalid data' });
    }

    await db.query(
      `INSERT INTO payments (reservation_id, amount, status, payment_method, provider_transaction_id, timestamp, collected_by)
       VALUES (?, ?, 'paid', ?, ?, NOW(), ?)`,
      [reservationId, amount, paymentMethod, transactionId, employeeId]
    );

    await logEvent(reservationId, 'pay', employeeId, {
      method: paymentMethod,
      amount,
      transactionId,
    });

    return res.json({ ok: true, reservationId, status: 'paid' });
  } catch (err) {
    console.error('[POST /api/reservations/:id/payments/confirm]', err);
    return res.status(500).json({ error: 'confirm failed' });
  }
});





/* ----------------------------- BACKUP LIST ----------------------------- */

router.get('/backup', async (req, res) => {
  try {
    const { trip_id } = req.query;
    const query = `
      SELECT b.id AS backup_id, b.reservation_id, b.seat_id, s.label, b.trip_id, b.backup_time,
             p.name AS passenger_name, p.phone
      FROM reservations_backup b
      LEFT JOIN people p ON b.person_id = p.id
      LEFT JOIN seats s ON b.seat_id = s.id
      ${trip_id ? 'WHERE b.trip_id = ?' : ''}
      ORDER BY b.backup_time DESC
    `;
    const result = await db.query(query, trip_id ? [trip_id] : []);
    res.json(result.rows);
  } catch (err) {
    console.error('Eroare la interogarea backupurilor:', err);
    res.status(500).json({ error: 'Eroare la interogarea backupurilor' });
  }
});

/* ----------------------------- DELETE by composite ----------------------------- */

router.post('/delete', async (req, res) => {
  const { seat_id, trip_id } = req.body;
  const boardStationId = parseStationId(req.body.board_station_id);
  const exitStationId = parseStationId(req.body.exit_station_id);

  if (!seat_id || !trip_id || boardStationId === null || exitStationId === null) {
    return res.status(400).json({ error: 'Parametri lipsă' });
  }
  if (await rejectIfActiveAgentJob(req, res)) return;

  try {
    // 1) determină ID-urile (pentru backup + audit)
    const { rows } = await db.query(
      `
      SELECT id, trip_id, seat_id, person_id
      FROM reservations
      WHERE seat_id = ? AND trip_id = ? AND board_station_id = ? AND exit_station_id = ?
      `,
      [seat_id, trip_id, boardStationId, exitStationId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Rezervarea nu a fost găsită' });
    }

    // 2) backup pentru toate
    for (const r of rows) {
      await db.query(
        `
        INSERT INTO reservations_backup (reservation_id, trip_id, seat_id, label, person_id)
        VALUES (?, ?, ?, '', ?)
        `,
        [r.id, r.trip_id, r.seat_id, r.person_id]
      );
    }

    // 3) soft delete pentru toate
    await db.query(
      `
      UPDATE reservations
         SET status = 'cancelled'
       WHERE seat_id = ? AND trip_id = ? AND board_station_id = ? AND exit_station_id = ? AND status <> 'cancelled'
      `,
      [seat_id, trip_id, boardStationId, exitStationId]
    );

    // 4) audit pentru fiecare — etichetă clară
    const single = rows.length === 1;
    const details = single
      ? {
        by: 'ui_delete_passenger',               // ȘTERGERE UNICĂ din meniul din UI
        route: 'POST /api/reservations/delete',
        seat_id,
        trip_id,
        board_station_id: boardStationId,
        exit_station_id: exitStationId,
      }
      : {
        by: 'ui_delete_seat_bulk',               // caz rar: dacă ar nimeri mai multe rânduri
        route: 'POST /api/reservations/delete',
        seat_id,
        trip_id,
        exit_station_id: exitStationId,
        count: rows.length,
      };

    for (const r of rows) {
      await logEvent(r.id, 'cancel', Number(req.user?.id) || null, details);
    }

    emitTripUpdate(trip_id);


    return res.json({ success: true, cancelled: rows.map(r => r.id) });
  } catch (err) {
    console.error('Eroare la soft delete (compozit):', err);
    return res.status(500).json({ error: 'Eroare la anulare' });
  }
});


/* ----------------------------- DELETE by id ----------------------------- */

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // 1) backup (include și seat + label, dacă vrei extinde SELECT)
    await db.query(
      `
      INSERT INTO reservations_backup (reservation_id, trip_id, seat_id, label, person_id)
      SELECT r.id, r.trip_id, r.seat_id, '' AS label, r.person_id
      FROM reservations r
      WHERE r.id = ?
      `,
      [id]
    );

    // 2) soft delete (idempotent)
    const upd = await db.query(
      `UPDATE reservations SET status = 'cancelled' WHERE id = ? AND status <> 'cancelled'`,
      [id]
    );
    if (upd.rowCount === 0) {
      return res.status(404).json({ error: 'Rezervarea nu a fost găsită sau era deja anulată' });
    }

    // 3) audit
    await logEvent(Number(id), 'cancel', Number(req.user?.id) || null, {
      by: 'ui_delete_passenger',
      route: 'DELETE /api/reservations/:id'
    });

    const t = await db.query(`SELECT trip_id FROM reservations WHERE id = ? LIMIT 1`, [id]);
    const tripId = t?.rows?.[0]?.trip_id;
    if (tripId) emitTripUpdate(tripId);

    return res.json({ success: true });
  } catch (err) {
    console.error('Eroare la DELETE (soft) /reservations/:id', err);
    return res.status(500).json({ error: 'Eroare internă la anulare' });
  }
});


/* ----------------------------- MOVE TO OTHER TRIP ----------------------------- */

router.post('/moveToOtherTrip', async (req, res) => {
  console.log('[moveToOtherTrip] payload primit:', req.body);
  if (await rejectIfActiveAgentJob(req, res)) return;

  const {
    old_reservation_id,
    new_trip_id,
    new_seat_id,
    board_station_id,
    exit_station_id,
    phone,
    name,
    booking_channel = 'online',
    observations, // opțional
  } = req.body;

  const parsedBoardId = parseStationId(board_station_id);
  const parsedExitId = parseStationId(exit_station_id);

  if (!old_reservation_id || !new_trip_id || !new_seat_id || parsedBoardId === null || parsedExitId === null) {
    return res.status(400).json({ error: 'Missing required data' });
  }

  try {

    const oldInfo = await db.query(
      `SELECT trip_id, observations FROM reservations WHERE id = ? LIMIT 1`,
      [old_reservation_id]
    );
    const oldTripId = oldInfo?.rows?.[0]?.trip_id || null;
    const oldObservations = oldInfo?.rows?.[0]?.observations ?? null;

    const oldPricing = await db.query(
      `SELECT booking_channel FROM reservation_pricing WHERE reservation_id = ? ORDER BY created_at DESC LIMIT 1`,
      [old_reservation_id]
    );
    const oldBookingChannel = oldPricing?.rows?.[0]?.booking_channel || null;



    const cid = randomUUID();
    // info trip nou + stații
    const tripInfoRes = await db.query(
      `SELECT
          t.route_id,
          rs.direction,
          s.vehicle_id,
          COALESCE(tv.boarding_started, 0) AS boarding_started
         FROM trips t
         JOIN route_schedules rs ON rs.id = t.route_schedule_id
         JOIN seats s ON s.id = ?
         LEFT JOIN trip_vehicles tv ON tv.trip_id = t.id AND tv.vehicle_id = s.vehicle_id
        WHERE t.id = ?`,
      [new_seat_id, new_trip_id]
    );
    if (!tripInfoRes.rowCount) {
      return res.status(400).json({ error: 'Cursa selectată nu există' });
    }

    if (Number(tripInfoRes.rows[0].boarding_started)) {
      return res.status(409).json({ error: 'Îmbarcarea a început pentru această cursă. Nu se mai pot face mutări către ea.' });
    }

    const stopsInfo = await getStops(
      tripInfoRes.rows[0].route_id,
      tripInfoRes.rows[0].direction
    );
    if (!stopsInfo.ordered.length) {
      return res.status(400).json({ error: 'Ruta nu are stații definite' });
    }

    const boardStationId = ensureStationId(stopsInfo, parsedBoardId);
    const exitStationId = ensureStationId(stopsInfo, parsedExitId);
    if (boardStationId === null || exitStationId === null) {
      return res.status(400).json({ error: 'Stații invalide pentru mutare' });
    }

    const newBoardIndex = getStationIndex(stopsInfo, boardStationId);
    const newExitIndex = getStationIndex(stopsInfo, exitStationId);
    if (newBoardIndex === -1 || newExitIndex === -1 || newBoardIndex >= newExitIndex) {
      return res.status(400).json({ error: 'Segment invalid pentru mutare' });
    }

    // 1. backup rezervare veche
    await db.query(
      `
      INSERT INTO reservations_backup (reservation_id, trip_id, seat_id, label, person_id)
      SELECT id, trip_id, seat_id, '', person_id FROM reservations WHERE id = ?
      `,
      [old_reservation_id]
    );

    // 2. anulare rezervare veche
    const updateRes = await db.query(
      `UPDATE reservations SET status = 'cancelled' WHERE id = ?`,
      [old_reservation_id]
    );
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: 'Rezervarea veche nu a fost găsită' });
    }
    await logEvent(old_reservation_id, 'cancel', Number(req.user?.id) || null, {
      reason: 'moveToOtherTrip',
      correlation_id: cid
    });


    // 3. persoana
    let person_id;
    if (phone) {
      const personRes = await db.query(`SELECT id FROM people WHERE phone = ?`, [phone]);
      if (personRes.rows.length) {
        person_id = personRes.rows[0].id;
      } else {
        const ins = await db.query(`INSERT INTO people (name, phone) VALUES (?, ?)`, [name || '', phone]);
        person_id = ins.insertId;
      }
    } else {
      const oldRes = await db.query(`SELECT person_id FROM reservations WHERE id = ?`, [old_reservation_id]);
      person_id = oldRes.rows[0]?.person_id;
    }

    // 4. verifică coliziune pe noul loc/segment
    const overlapRes = await db.query(
      `
      SELECT board_station_id, exit_station_id
      FROM reservations
      WHERE trip_id = ? AND seat_id = ? AND status = 'active'
      `,
      [new_trip_id, new_seat_id]
    );

    const hasOverlap = overlapRes.rows.some((r) => {
      const rBoard = getStationIndex(stopsInfo, r.board_station_id);
      const rExit = getStationIndex(stopsInfo, r.exit_station_id);
      return Math.max(newBoardIndex, rBoard) < Math.min(newExitIndex, rExit);
    });

    if (hasOverlap) {
      return res.status(400).json({ error: 'Loc deja ocupat pe segmentul respectiv!' });
    }

    // 5. rezervare nouă
    const nextObservations = observations || oldObservations || null;
    const insRes = await db.query(
      `
      INSERT INTO reservations
        (trip_id, seat_id, person_id, board_station_id, exit_station_id, observations, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `,
      [new_trip_id, new_seat_id, person_id, boardStationId, exitStationId, nextObservations, Number(req.user?.id) || null]
    );
    const newReservationId = insRes.insertId;
    await logEvent(newReservationId, 'create', Number(req.user?.id) || null, {
      source: 'moveToOtherTrip',
      from_reservation_id: old_reservation_id,
      correlation_id: cid
    });
    // 6. copiere pricing din vechea rezervare (booking_channel actualizat)
    const effChannel = oldBookingChannel || 'online';
    await db.query(
      `
      INSERT INTO reservation_pricing
        (reservation_id, price_value, price_list_id, pricing_category_id, booking_channel, employee_id)
      SELECT ?, price_value, price_list_id, pricing_category_id, ?, employee_id
      FROM reservation_pricing
      WHERE reservation_id = ?
      `,
      [newReservationId, effChannel, old_reservation_id]
    );


    // 6.bis) copiere reduceri (tip + promo) din rezervarea veche
    await db.query(
      `
      INSERT INTO reservation_discounts
        (reservation_id, discount_type_id, promo_code_id, discount_amount, discount_snapshot)
      SELECT
        ?, discount_type_id, promo_code_id, discount_amount, discount_snapshot
      FROM reservation_discounts
      WHERE reservation_id = ?
      `,
      [newReservationId, old_reservation_id]
    );

    // 6.ter) mută plățile pe noua rezervare (păstrează starea de plată)
    await db.query(
      `
      UPDATE payments
      SET reservation_id = ?
      WHERE reservation_id = ?
      `,
      [newReservationId, old_reservation_id]
    );


    // 6. log de sinteză "reservation.move" (from -> to)
    await logEvent(newReservationId, 'move', Number(req.user?.id) || null, {
      from_reservation_id: old_reservation_id,
      to_trip_id: new_trip_id,
      to_seat_id: new_seat_id,
      board_station_id: boardStationId,
      exit_station_id: exitStationId,
      channel: effChannel,
      correlation_id: cid
    });
    if (oldTripId) emitTripUpdate(oldTripId);
    emitTripUpdate(new_trip_id);



    res.json({ success: true, new_reservation_id: newReservationId });

  } catch (err) {
    console.error('Eroare la mutare pe alt trip:', err);
    res.status(500).json({ error: 'Eroare la mutare pe altă cursă' });
  }
});

/* ----------------------------- CONFLICT CHECK ----------------------------- */
/**
 * GET /api/reservations/conflict?person_id=..&date=YYYY-MM-DD&time=HH:MM&board_station_id=..&exit_station_id=..
 */
router.get('/conflict', async (req, res) => {
  const { person_id: qPersonId, date, time } = req.query;
  const boardStationId = parseStationId(req.query.board_station_id);
  const exitStationId = parseStationId(req.query.exit_station_id);

  if (!date || !time || boardStationId === null || exitStationId === null) {
    return res.status(400).json({ error: 'Lipsește date/stații/time' });
  }

  try {
    const pid = Number(qPersonId);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: 'person_id lipsă sau invalid' });
    }
    const person_id = pid;

    const sql = `
      SELECT
        r.id               AS reservation_id,
        ro.id              AS route_id,
        ro.name            AS route_name,
        t.time             AS time,
        s.label            AS seat_label,
        r.board_station_id AS board_station_id,
        r.exit_station_id  AS exit_station_id,
        rs.direction       AS trip_direction
      FROM reservations r
      JOIN trips   t  ON t.id  = r.trip_id
      JOIN route_schedules rs ON rs.id = t.route_schedule_id
      JOIN routes  ro ON ro.id = t.route_id
      JOIN seats   s  ON s.id  = r.seat_id
      WHERE r.person_id = ?
        AND t.date      = ?
        AND r.status    = 'active'
        AND TIME_FORMAT(t.time, '%H:%i') <> ?
    `;

    const result = await db.query(sql, [person_id, date, time]);

    const conflictInfos = [];
    for (const r of result.rows) {
      const stopsInfo = await getStops(r.route_id, r.trip_direction);
      const iOldBoard = getStationIndex(stopsInfo, r.board_station_id);
      const iOldExit = getStationIndex(stopsInfo, r.exit_station_id);
      const iNewBoard = getStationIndex(stopsInfo, boardStationId);
      const iNewExit = getStationIndex(stopsInfo, exitStationId);

      if ([iOldBoard, iOldExit, iNewBoard, iNewExit].includes(-1)) continue;

      const overlap =
        iOldBoard < iOldExit &&
        iNewBoard < iNewExit &&
        Math.max(iOldBoard, iNewBoard) <= Math.min(iOldExit, iNewExit);

      if (overlap) conflictInfos.push(r);
    }

    res.json({
      conflict: conflictInfos.length > 0,
      infos: conflictInfos.map((r) => ({
        id: r.reservation_id,
        route: r.route_name,
        time: r.time,
        seatLabel: r.seat_label,
        board_station_id: r.board_station_id,
        exit_station_id: r.exit_station_id,
      })),
    });
  } catch (err) {
    console.error('Eroare la /reservations/conflict:', err);
    res.status(500).json({ error: 'server error' });
  }
});


/* ----------------------------- DOUBLE CHECK (same-day same-segment) ----------------------------- */
/**
 * GET /api/reservations/double-check-segment?person_id=..&date=YYYY-MM-DD&board_station_id=..&exit_station_id=..&exclude_trip_id=..
 * Regula: avertizare dacă persoana are deja rezervare în aceeași zi pe ACELAȘI sens (board->exit),
 * indiferent de rută/operator.
 */
router.get('/double-check-segment', async (req, res) => {
  const { person_id: qPersonId, date } = req.query;
  const boardStationId = parseStationId(req.query.board_station_id);
  const exitStationId = parseStationId(req.query.exit_station_id);
  const excludeTripId = req.query.exclude_trip_id ? Number(req.query.exclude_trip_id) : null;

  if (!date || boardStationId === null || exitStationId === null) {
    return res.status(400).json({ error: 'Lipsește date/stații' });
  }

  try {
    const pid = Number(qPersonId);
    if (!Number.isInteger(pid) || pid <= 0) {
      return res.status(400).json({ error: 'person_id lipsă sau invalid' });
    }

    let sql = `
      SELECT
        r.id               AS reservation_id,
        ro.name            AS route_name,
        t.time             AS time,
        s.label            AS seat_label,
        r.board_station_id AS board_station_id,
        r.exit_station_id  AS exit_station_id
      FROM reservations r
      JOIN trips   t  ON t.id  = r.trip_id
      JOIN routes  ro ON ro.id = t.route_id
      JOIN seats   s  ON s.id  = r.seat_id
      WHERE r.person_id = ?
        AND t.date      = ?
        AND r.status    = 'active'
        AND r.board_station_id = ?
        AND r.exit_station_id  = ?
    `;

    const params = [pid, date, boardStationId, exitStationId];

    if (excludeTripId && Number.isInteger(excludeTripId)) {
      sql += ` AND t.id <> ?`;
      params.push(excludeTripId);
    }

    sql += ` ORDER BY t.time ASC`;

    const result = await db.query(sql, params);
    const rows = result?.rows || [];

    res.json({
      hasDouble: rows.length > 0,
      infos: rows.map((r) => ({
        id: r.reservation_id,
        route: r.route_name,
        time: r.time,
        seatLabel: r.seat_label,
        board_station_id: r.board_station_id,
        exit_station_id: r.exit_station_id,
      })),
    });
  } catch (err) {
    console.error('Eroare la /reservations/double-check-segment:', err);
    res.status(500).json({ error: 'server error' });
  }
});








// POST /api/reservations/move
router.post('/move', async (req, res) => {
  try {
    if (await rejectIfActiveAgentJob(req, res)) return;

    const {
      reservation_id,     // dacă muți o rezervare existentă
      from_seat_id,
      to_seat_id,
      trip_id,
      trip_vehicle_id,    // dacă îl știi; altfel îl obții din seats/trip_seats
      board_station_id,
      exit_station_id
    } = req.body;

    if (!reservation_id || !to_seat_id || !trip_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // exemplu simplu; adaptează la schema ta (poți folosi și tranzacție)
    const boardId = Number(board_station_id);
    const exitId = Number(exit_station_id);
    const boardValue = Number.isInteger(boardId) && boardId > 0 ? boardId : null;
    const exitValue = Number.isInteger(exitId) && exitId > 0 ? exitId : null;

    // 0) citește înainte valorile vechi (pt. audit)
    const beforeQ = await db.query(
      `SELECT trip_id, seat_id, board_station_id, exit_station_id
         FROM reservations
        WHERE id = ?
        LIMIT 1`,
      [reservation_id]
    );
    const before = beforeQ.rows?.[0] || null;



    await db.query(
      `UPDATE reservations
         SET seat_id = ?, trip_id = ?, board_station_id = ?, exit_station_id = ?
       WHERE id = ?`,
      [to_seat_id, trip_id, boardValue, exitValue, reservation_id]
    );

    if (boardValue && exitValue) {
      try {
        const { rows } = await db.query(
          `
            SELECT
              p.phone,
              t.route_id,
              rs.direction
            FROM reservations r
            LEFT JOIN people p ON p.id = r.person_id
            LEFT JOIN trips t ON t.id = r.trip_id
            LEFT JOIN route_schedules rs ON rs.id = t.route_schedule_id
            WHERE r.id = ?
            LIMIT 1
          `,
          [reservation_id],
        );

        if (rows.length) {
          const row = rows[0];
          const routeId = Number(row.route_id);
          const direction = row.direction ? normalizeDirection(row.direction) : null;
          if (Number.isInteger(routeId) && routeId > 0) {
            await touchTravelerDefault(row.phone, routeId, boardValue, exitValue, direction);
          }
        }
      } catch (err) {
        console.warn('[reservations/move] traveler default update failed', err);
      }
    }

    // 3) audit: reservation.move (same trip / same vehicle)
    try {
      await logEvent(reservation_id, 'move', Number(req.user?.id) || null, {
        // îl legăm de aceeași rezervare (from_reservation_id = self)
        from_reservation_id: reservation_id,
        // „to” = valorile noi
        to_trip_id: trip_id,
        to_seat_id: to_seat_id,
        board_station_id: boardValue,
        exit_station_id: exitValue,
        // notă cu valorile „from” (dacă au fost găsite)
        note: before
          ? `from_trip_id=${before.trip_id};from_seat_id=${before.seat_id};from_board=${before.board_station_id};from_exit=${before.exit_station_id}`
          : null,
      });
    } catch (e) {
      console.warn('[reservations/move] audit failed', e.message);
    }

    emitTripUpdate(trip_id);

    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/reservations/move] error:', err);
    return res.status(500).json({ error: 'internal' });
  }
});

/* // ✅ Rută publică pentru site-ul clienților (fără autentificare)
// - primește doar rezervări noi (nu permite modificări/ștergeri)
router.post('/public_reservation', async (req, res) => {
  try {
    const { route_id, date, name, phone, board_at, exit_at } = req.body;
    if (!route_id || !date || !name || !board_at || !exit_at) {
      return res.status(400).json({ error: 'Date incomplete pentru rezervare.' });
    }

    // TODO: verificare antiflood / blacklist etc. ulterior
    const result = await db.query(
      `INSERT INTO reservations (route_id, date, name, phone, board_at, exit_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'public') RETURNING id`, // sintaxa de postgresql?
      [route_id, date, name, phone || null, board_at, exit_at]
    );

    res.status(201).json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Eroare la rezervare publică:', err);
    res.status(500).json({ error: 'Eroare la salvarea rezervării.' });
  }
}); */


// GET /api/reservations/:id/payments/status
router.get('/:id/payments/status', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id invalid' });
    }

    const { rows: payments } = await db.query(
      `
      SELECT
        payments.id           AS payment_id,
        payments.amount       AS amount,
        payments.status       AS status,
        payments.receipt_status AS receipt_status,
        payments.payment_method,
        payments.provider_transaction_id,
        DATE_FORMAT(payments.timestamp, '%d.%m.%Y %H:%i:%s') AS ts,
        payments.collected_by
      FROM payments
      WHERE payments.reservation_id = ?
      ORDER BY payments.id DESC
      LIMIT 1
      `,
      [id]
    );

    const p = (payments && payments[0]) || null;

    let lastJob = null;

    if (p && p.payment_id) {
      const { rows: jobs } = await db.query(
        `
    SELECT
      status,
      error_message,
      job_type
    FROM agent_jobs
    WHERE payment_id = ?
    ORDER BY id DESC
    LIMIT 1
    `,
        [p.payment_id]
      );

      lastJob = (jobs && jobs[0]) || null;
    }

    return res.json({
      ok: true,
      payment: p,
      last_job: lastJob,
    });

  } catch (err) {
    console.error('[GET /api/reservations/:id/payments/status]', err);
    return res.status(500).json({ ok: false, error: 'Eroare internă la status plăți' });
  }
});


// GET /api/reservations/:id/details
router.get('/:id/details', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id invalid' });

    // 1) rez + trip + route + stații + loc
    const { rows: info } = await db.query(
      `
      SELECT
        r.id                 AS reservation_id,
        r.status,
        r.observations,
        r.reservation_time,
        r.created_by,
        e.name               AS created_by_name,

        p.name               AS passenger_name,

        t.id                 AS trip_id,
        DATE_FORMAT(t.date, '%d.%m.%Y') AS trip_date,
        DATE_FORMAT(t.time, '%H:%i')    AS trip_time,

        op.id                AS operator_id,
        op.name              AS operator_name,

        ro.id                AS route_id,
        ro.name              AS route_name,

        s.id                 AS seat_id,
        s.label              AS seat_label,

        sb.id                AS board_station_id,
        sb.name              AS board_name,
        se.id                AS exit_station_id,
        se.name              AS exit_name
      FROM reservations r
      JOIN trips   t  ON t.id  = r.trip_id
      LEFT JOIN route_schedules rs ON rs.id = t.route_schedule_id
      LEFT JOIN operators op       ON op.id = rs.operator_id
      JOIN routes  ro ON ro.id = t.route_id
      JOIN seats   s  ON s.id  = r.seat_id
      LEFT JOIN people p   ON p.id  = r.person_id
      LEFT JOIN employees e ON e.id = r.created_by
      LEFT JOIN stations sb ON sb.id = r.board_station_id
      LEFT JOIN stations se ON se.id = r.exit_station_id
      WHERE r.id = ?
      `,
      [id]
    );

    if (info.length === 0) return res.status(404).json({ error: 'Rezervare inexistentă' });

    // 2) pricing curent (dacă există)
    const { rows: pricing } = await db.query(
      `
      SELECT
        rp.price_value,
        rp.price_list_id,
        rp.pricing_category_id,
        rp.booking_channel,
        rp.employee_id,
        e.name AS employee_name,
        DATE_FORMAT(rp.created_at, '%d.%m.%Y %H:%i') AS created_at
      FROM reservation_pricing rp
      LEFT JOIN employees e ON e.id = rp.employee_id
      WHERE rp.reservation_id = ?
      ORDER BY rp.created_at DESC
      LIMIT 1
      `,
      [id]
    );

    // 3) plăți
    const { rows: payments } = await db.query(
      `
SELECT
  payments.id AS payment_id,
  payments.amount,
  payments.status,
  payments.payment_method,
  payments.provider_transaction_id,
  DATE_FORMAT(payments.timestamp, '%d.%m.%Y %H:%i') AS ts,
  payments.collected_by,
  e.name AS collected_by_name
FROM payments
LEFT JOIN employees e ON e.id = payments.collected_by
WHERE payments.reservation_id = ?
ORDER BY payments.id DESC

      `,
      [id]
    );

    // 4) timeline (evenimente) din audit_logs
    const evRes = await db.query(
      `
  SELECT
    audit_logs.id                        AS event_id,
    DATE_FORMAT(audit_logs.created_at, '%d.%m.%Y %H:%i') AS at,
    audit_logs.action,
    audit_logs.actor_id,
    e.name AS actor_name,
    audit_logs.entity,
    audit_logs.entity_id,
    audit_logs.related_id,
    audit_logs.channel,
    audit_logs.amount,
    audit_logs.payment_method,
    audit_logs.provider_transaction_id
  FROM audit_logs
  LEFT JOIN employees e ON e.id = audit_logs.actor_id
  WHERE
    (audit_logs.entity = 'reservation' AND audit_logs.entity_id = ?)
    OR
    (audit_logs.entity = 'payment'     AND audit_logs.related_id = ?)
  ORDER BY audit_logs.created_at ASC, audit_logs.id ASC
  `,
      [id, id]
    );


    res.json({
      reservation: info[0],
      pricing: pricing[0] || null,
      payments,
      events: (evRes.rows || evRes) || []
    });
  } catch (err) {
    console.error('[GET /reservations/:id/details]', err);
    res.status(500).json({ error: 'Eroare la detalii rezervare' });
  }
});



// ⚠️ DEPRECATED – NU SE MAI FOLOSEȘTE
// Înlocuit de POST /api/reservations/:id/payments/cash-agent
// ======================================================
// POST /api/reservations/:id/pay/cash-agent
// Inițiază plată CASH + bon fiscal prin agent
// ======================================================
/* router.post('/:id/pay/cash-agent', async (req, res) => {
  const reservationId = Number(req.params.id);

  if (!Number.isFinite(reservationId)) {
    return res.status(400).json({ error: 'reservation_id invalid' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 🔎 Rezervare
    const [[reservation]] = await conn.query(
      'SELECT id, price FROM reservations WHERE id = ? LIMIT 1',
      [reservationId]
    );

    if (!reservation) {
      await conn.rollback();
      return res.status(404).json({ error: 'Rezervare inexistentă' });
    }

    const amount = reservation.price;

    // 1️⃣ Creăm payment
    const [paymentRes] = await conn.query(
      `INSERT INTO payments
        (reservation_id, amount, payment_method, status)
       VALUES (?, ?, 'cash', 'pending')`,
      [reservationId, amount]
    );

    const paymentId = paymentRes.insertId;

    // 2️⃣ Creăm agent_job
    const payload = {
      amount,
      currency: 'RON',
      reservation_id: reservationId,
      payment_id: paymentId,
    };

    const [jobRes] = await conn.query(
      `INSERT INTO agent_jobs
        (reservation_id, payment_id, job_type, status, payload)
       VALUES (?, ?, 'cash_receipt_only', 'queued', ?)`,
      [
        reservationId,
        paymentId,
        JSON.stringify(payload),
      ]
    );

    await conn.commit();

    return res.json({
      ok: true,
      payment_id: paymentId,
      job_id: jobRes.insertId,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[pay/cash-agent] eroare:', err);
    return res.status(500).json({ error: 'Eroare inițiere plată cash' });
  } finally {
    conn.release();
  }
}); */



module.exports = router;
