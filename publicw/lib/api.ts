export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

const rawApiBase = process.env.NEXT_PUBLIC_BACKEND_URL;

if (!rawApiBase) {
  throw new Error('NEXT_PUBLIC_BACKEND_URL is not defined');
}

export const API_BASE = rawApiBase.replace(/\/$/, '');


type RequestOptions = RequestInit & { parseJson?: boolean };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const { parseJson = true, headers, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
  });

  let payload: any = null;
  if (parseJson) {
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
  }

  if (!response.ok) {
    const message = payload?.error || `A apărut o eroare (HTTP ${response.status}).`;
    throw new ApiError(message, response.status, payload);
  }

  return (payload ?? null) as T;
}

export interface StationOption {
  id: number;
  name: string;
}

export interface StationRelation {
  from_station_id: number;
  to_station_id: number;
}

export interface RouteStopDetail {
  route_id: number;
  station_id: number;
  station_name: string;
  direction: 'tur' | 'retur';
  sequence: number;
  offset_minutes: number;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface RouteSummary {
  id: number;
  name: string;
  stations: string[];
}

export interface RoutesMeta {
  stations: StationOption[];
  relations: StationRelation[];
  routes: RouteSummary[];
  stopDetails: RouteStopDetail[];
}

export interface PublicTrip {
  trip_id: number;
  route_id: number;
  route_name: string;
  direction: 'tur' | 'retur';
  departure_time: string;
  arrival_time: string | null;
  duration_minutes: number | null;
  price: number | null;
  currency: string | null;
  price_list_id: number | null;
  pricing_category_id: number | null;
  available_seats: number | null;
  can_book: boolean;
  block_reason?: string | null;
  boarding_started: boolean;
  board_station_id: number;
  exit_station_id: number;
  date: string;
  schedule_id: number | null;
}

export interface SeatInfo {
  id: number;
  label: string;
  row: number;
  seat_col: number;
  seat_type: string;
  status: 'free' | 'partial' | 'full' | 'blocked';
  is_available: boolean;
  hold_status?: 'mine' | 'other' | null;
  blocked_online?: boolean;
}

export interface SeatVehicle {
  vehicle_id: number;
  vehicle_name: string;
  plate_number: string | null;
  is_primary: boolean;
  boarding_started: boolean;
  seats: SeatInfo[];
}

export interface SeatMapResponse {
  trip_id: number;
  board_station_id: number;
  exit_station_id: number;
  available_seats: number | null;
  boarding_started: boolean;
  vehicles: SeatVehicle[];
}

export interface IntentInfo {
  seat_id: number;
  expires_at: string | null;
  is_mine: 0 | 1;
}

export interface SearchTripsParams {
  fromStationId: number;
  toStationId: number;
  date: string;
  passengers?: number;
}

export interface CreateReservationPayload {
  trip_id: number;
  board_station_id: number;
  exit_station_id: number;
  seats: number[];
  contact: {
    name: string;
    phone: string;
    email: string;
  };
  passengers?: {
    seat_id: number;
    name: string;
    discount_type_id?: number | null;
  }[];
  note?: string;
  promo?: PromoApplyPayload | null;
}

export interface CreateReservationResponse {
  success: boolean;
  order_id: number;
  trip_id: number;
  operator_id: number;
  payment_provider: string;
  expires_in_seconds: number;
  amount_total: number;
  discount_total: number;
  currency: string;
}


export interface AccountReservation {
  id: number;
  trip_id: number | null;
  route_id: number | null;
  status: string;
  reservation_time: string | null;
  trip_date: string | null;
  trip_time: string | null;
  travel_datetime: string | null;
  route_name: string | null;
  direction: string | null;
  seat_label: string | null;
  board_station_id: number | null;
  exit_station_id: number | null;
  board_name: string | null;
  exit_name: string | null;
  passenger_name: string | null;
  price_value: number | null;
  discount_total: number | null;
  discount_type_id: number | null;
  discount_label: string | null;
  paid_amount: number | null;
  payment_method: string | null;
  is_paid: boolean;
  order_id: number | null;
  is_refunded: boolean;
  refund_time: string | null;
  currency: string | null;
}

export interface AccountReservationsResponse {
  upcoming: AccountReservation[];
  past: AccountReservation[];
}

export interface PromoValidationPayload {
  code: string;
  trip_id: number;
  board_station_id: number;
  exit_station_id: number;
  seat_count: number;
  phone?: string;
  discount_type_id?: number | null;
  discount_type_ids?: (number | null)[];
}

export interface PromoValidationResponse {
  valid: boolean;
  reason?: string;
  promo_code_id?: number;
  code?: string;
  type?: string;
  value_off?: number;
  discount_amount?: number;
  combinable?: boolean;
}

export interface PromoApplyPayload {
  code: string;
  promo_code_id: number;
  discount_amount: number;
  value_off: number;
}

export interface DiscountTypeOption {
  id: number;
  code: string | null;
  label: string;
  value_off: number;
  type: 'percent' | 'fixed';
}

export async function fetchRoutesMeta(): Promise<RoutesMeta> {
  return request<RoutesMeta>('/api/public/routes');
}

export async function searchPublicTrips(params: SearchTripsParams): Promise<PublicTrip[]> {
  const query = new URLSearchParams({
    from_station_id: String(params.fromStationId),
    to_station_id: String(params.toStationId),
    date: params.date,
  });
  if (params.passengers) {
    query.set('passengers', String(params.passengers));
  }
  return request<PublicTrip[]>(`/api/public/trips?${query.toString()}`);
}

export async function fetchTripSeatMap(tripId: number, boardStationId: number, exitStationId: number): Promise<SeatMapResponse> {
  const query = new URLSearchParams({
    board_station_id: String(boardStationId),
    exit_station_id: String(exitStationId),
  });
  return request<SeatMapResponse>(`/api/public/trips/${tripId}/seats?${query.toString()}`);
}

export async function createPublicReservation(payload: CreateReservationPayload): Promise<CreateReservationResponse> {
  return request<CreateReservationResponse>('/api/public/reservations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchTripDiscountTypes(tripId: number): Promise<DiscountTypeOption[]> {
  return request<DiscountTypeOption[]>(`/api/public/trips/${tripId}/discount-types`);
}

export async function fetchTripIntents(tripId: number): Promise<IntentInfo[]> {
  return request<IntentInfo[]>(`/api/intents?trip_id=${tripId}`);
}

export async function createIntent(payload: { trip_id: number; seat_id: number }): Promise<void> {
  await request('/api/intents', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteIntent(tripId: number, seatId: number): Promise<void> {
  await request(`/api/intents/${tripId}/${seatId}`, {
    method: 'DELETE',
  });
}

export async function validatePromoCode(payload: PromoValidationPayload): Promise<PromoValidationResponse> {
  return request<PromoValidationResponse>('/api/public/promo/validate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface AuthUser {
  id: number;
  email: string;
  name?: string | null;
  phone?: string | null;
  emailVerified?: boolean;
  phoneVerified?: boolean;
}

export interface AuthSessionInfo {
  user: AuthUser;
  accessToken?: string;
  refreshToken?: string;
}

export interface AuthSuccessResponse {
  success: true;
  message?: string | null;
  session?: AuthSessionInfo;
  pendingVerification?: boolean;
  emailSent?: boolean;
}

export interface AuthErrorResponse {
  success: false;
  message: string;
  needsVerification?: boolean;
  emailSent?: boolean;
  expired?: boolean;
}

export type AuthResponse = AuthSuccessResponse | AuthErrorResponse;

export interface StartPhoneLinkPayload {
  phone: string;
}

export interface StartPhoneLinkResponse {
  requestId: string;
  message?: string | null;
}

export interface VerifyPhoneLinkPayload {
  requestId: string;
  code: string;
}

export interface VerifyPhoneLinkResponse {
  success: boolean;
  message?: string | null;
}

export interface EmailRegisterPayload {
  name?: string | null;
  email: string;
  password: string;
  phone: string;
}

export interface UpdateProfilePayload {
  name?: string | null;
  phone: string;
}

export interface UpdateProfileResponse {
  success: boolean;
  message?: string | null;
  session: AuthSessionInfo;
}

export interface EmailLoginPayload {
  email: string;
  password: string;
  remember?: boolean;
}

export interface VerifyEmailPayload {
  token: string;
}

export interface ResendEmailVerificationPayload {
  email: string;
}

export interface PasswordResetRequestPayload {
  email: string;
}

export interface PasswordResetConfirmPayload {
  token: string;
  password: string;
}

export async function registerWithEmail(payload: EmailRegisterPayload): Promise<AuthResponse> {
  return request<AuthResponse>('/api/public/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updatePublicProfile(payload: UpdateProfilePayload): Promise<UpdateProfileResponse> {
  return request<UpdateProfileResponse>('/api/public/auth/profile', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function loginWithEmail(payload: EmailLoginPayload): Promise<AuthResponse> {
  return request<AuthResponse>('/api/public/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function verifyEmailToken(payload: VerifyEmailPayload): Promise<AuthResponse> {
  return request<AuthResponse>('/api/public/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function resendEmailVerification(
  payload: ResendEmailVerificationPayload,
): Promise<{ success: boolean; message: string; emailSent?: boolean }> {
  return request<{ success: boolean; message: string; emailSent?: boolean }>('/api/public/auth/email/resend', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function requestPasswordReset(
  payload: PasswordResetRequestPayload,
): Promise<{ success: boolean; message: string; emailSent?: boolean }> {
  return request<{ success: boolean; message: string; emailSent?: boolean }>('/api/public/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function confirmPasswordReset(
  payload: PasswordResetConfirmPayload,
): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/api/public/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function startPhoneLink(payload: StartPhoneLinkPayload): Promise<StartPhoneLinkResponse> {
  return request<StartPhoneLinkResponse>('/api/public/auth/phone-link/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function verifyPhoneLink(payload: VerifyPhoneLinkPayload): Promise<VerifyPhoneLinkResponse> {
  return request<VerifyPhoneLinkResponse>('/api/public/auth/phone-link/verify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export type OAuthProvider = 'google' | 'apple';

export interface OAuthProviderAvailability {
  id: OAuthProvider;
  enabled: boolean;
  url?: string | null;
  reason?: string | null;
}

export async function fetchOAuthProviders(
  redirectTo?: string | null,
  variant?: 'login' | 'register',
): Promise<OAuthProviderAvailability[]> {
  const search = new URLSearchParams();
  if (redirectTo) {
    search.set('redirect', redirectTo);
  }
  if (variant) {
    search.set('variant', variant);
  }
  const query = search.toString();
  const response = await request<{ providers?: OAuthProviderAvailability[] }>(
    `/api/public/auth/oauth/providers${query ? `?${query}` : ''}`,
  );
  return Array.isArray(response?.providers) ? response.providers : [];
}

export async function fetchPublicSession(): Promise<AuthSessionInfo | null> {
  const response = await request<{ success: boolean; session: AuthSessionInfo | null }>(
    '/api/public/auth/session',
  );
  return response.session ?? null;
}


export async function logoutPublicSession(): Promise<void> {
  await request<{ success: boolean; message?: string }>('/api/public/auth/logout', {
    method: 'POST',
  });
}

export async function fetchAccountReservations(): Promise<AccountReservationsResponse> {
  return request<AccountReservationsResponse>('/api/public/account/reservations');
}

export async function refundPublicOrder(orderId: number): Promise<{ success: boolean; message?: string }> {
  return request<{ success: boolean; message?: string }>(`/api/public/orders/${orderId}/refund`, {
    method: 'POST',
  });
}

type ReceiptApiResponse = {
  success: boolean;
  order: {
    id: number;
    status: string;
    trip_id: number;
    trip_date: string;
    departure_time: string;
route_name: string;
vehicle_route_text?: string | null;
route_id: number;

    direction: string;
    total_amount: number;
    discount_total: number;
    currency?: string | undefined;
    board_station_id: number;
    exit_station_id: number;
    board_station_name?: string | null;
    exit_station_name?: string | null;
  };

  items: Array<{
    seat_id: number;
    seat_label?: string | null;
    traveler_name: string;
    discount_type_id?: number | null;
    price_amount?: number;
  }>;
  reservation_ids: number[];
};

export async function retryPublicCheckout(orderId: number): Promise<{ form_url?: string | null }> {
  const resp = await request<{ success: boolean; redirect_url?: string }>(`/api/public/orders/${orderId}/start-payment`, {
    method: 'POST',
  });
  return { form_url: resp.redirect_url || null };
}

function addMinutesToTime(timeHHmm: string, minutesToAdd: number) {
  const raw = String(timeHHmm || '').trim();
  const [hhStr, mmStr] = raw.split(':');
  const hh = Number(hhStr);
  const mm = Number(mmStr);

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return raw;

  const base = hh * 60 + mm;
  const total = base + (Number(minutesToAdd) || 0);

  const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  const outH = Math.floor(normalized / 60);
  const outM = normalized % 60;

  return `${String(outH).padStart(2, '0')}:${String(outM).padStart(2, '0')}`;
}


export async function fetchCheckoutStatus(orderId: number): Promise<{
  paid: boolean;
  expired: boolean;
  reservation_ids: number[];
  summary?: {
    trip_date: string;
    departure_time: string;
    route_name: string;
    board_at: string;
    exit_at: string;
    seat_count: number;
    seat_labels: string[];
    discount_total: number;
    promo_total: number;
    paid_amount: number;
    currency: string;
  } | null;
}> {
  const receipt = await request<ReceiptApiResponse>(`/api/public/orders/${orderId}/receipt`);

  // status
  const status = String(receipt.order.status || '').toLowerCase();
  const paid = status === 'paid';
  const expired = status === 'expired';

// map station ids -> names (din meta)
let boardName = `#${receipt.order.board_station_id}`;
let exitName = `#${receipt.order.exit_station_id}`;

let boardOffset = 0;

try {
  const meta = await fetchRoutesMeta();
  const stopDetails = meta?.stopDetails || [];

  const dir = receipt.order.direction || 'tur';

  const board = stopDetails.find(
    (s) =>
      Number(s.route_id) === Number(receipt.order.route_id) &&
      String(s.direction) === String(dir) &&
      Number(s.station_id) === Number(receipt.order.board_station_id)
  );

  const exit = stopDetails.find(
    (s) =>
      Number(s.route_id) === Number(receipt.order.route_id) &&
      String(s.direction) === String(dir) &&
      Number(s.station_id) === Number(receipt.order.exit_station_id)
  );

if (receipt.order.board_station_name) boardName = String(receipt.order.board_station_name);
else if (board?.station_name) boardName = String(board.station_name);

if (receipt.order.exit_station_name) exitName = String(receipt.order.exit_station_name);
else if (exit?.station_name) exitName = String(exit.station_name);



  if (Number.isFinite(Number(board?.offset_minutes))) {
    boardOffset = Number(board!.offset_minutes);
  }
} catch {
  // daca meta nu poate fi incarcata, lasam fallback-ul (#id)
}
;
  

  const currency = (receipt.order.currency || 'RON').toUpperCase();
  const seatItems = Array.isArray(receipt.items) ? receipt.items : [];
  const seatCount = seatItems.length;
  const seatLabels = seatItems.map((item) => {
    if (item.seat_label) return String(item.seat_label);
    if (Number.isFinite(Number(item.seat_id))) return String(item.seat_id);
    return '';
  }).filter(Boolean);

  return {
    paid,
    expired,
    reservation_ids: receipt.reservation_ids || [],
    summary: {
      trip_date: receipt.order.trip_date,
      departure_time: receipt.order.departure_time,


      route_name: (receipt.order.vehicle_route_text || receipt.order.route_name),

      board_at: boardName,
      exit_at: exitName,
      seat_count: seatCount,
      seat_labels: seatLabels,
      discount_total: Number(receipt.order.discount_total || 0),
      promo_total: 0,
      paid_amount: Number(receipt.order.total_amount || 0),
      currency,
    },
  };
}
