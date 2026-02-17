'use client'

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import Navbar from '@/components/Navbar'
import { usePublicSession } from '@/components/PublicSessionProvider'
import {
  fetchAccountReservations,
  fetchRoutesMeta,
  refundPublicOrder,
  updatePublicProfile,
  type AccountReservation,
  type AccountReservationsResponse,
  type RoutesMeta,
  type RouteStopDetail,
} from '@/lib/api'
import { formatRoDate } from '@/lib/format'

type StatusMeta = { label: string; className: string }

type ReservationSeatLine = {
  id: number
  seatLabel: string
  priceValue: number | null
  discountLabel: string | null
  discountTotal: number | null
  currency: string | null
}

type ReservationGroup = {
  key: string
  orderId: number | null
  reservations: AccountReservation[]
  seatLines: ReservationSeatLine[]
  routeName: string | null
  routeId: number | null
  direction: string | null
  tripDate: string | null
  tripTime: string | null
  travelDatetime: string | null
  boardName: string | null
  exitName: string | null
  boardStationId: number | null
  exitStationId: number | null
  reservationTime: string | null
  refundTime: string | null
  status: string | null
  isPaid: boolean
  isRefunded: boolean
  paymentMethod: string | null
  currency: string | null
}

function formatCurrency(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) {
    return '—'
  }
  try {
    return new Intl.NumberFormat('ro-RO', {
      style: 'currency',
      currency: currency || 'RON',
      minimumFractionDigits: 0,
    }).format(Number(value))
  } catch {
    return `${value} ${currency || 'RON'}`
  }
}

function formatTimeLabel(value: string | null | undefined): string {
  if (!value) return '—'
  if (value.length >= 5) return value.slice(0, 5)
  return value
}

function computeStopTime(baseTime: string | null, offsetMinutes: number | null): string | null {
  if (!baseTime || offsetMinutes == null) return null
  const match = baseTime.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  const base = Number(match[1]) * 60 + Number(match[2])
  if (!Number.isFinite(base)) return null
  const total = (base + Number(offsetMinutes) + 24 * 60) % (24 * 60)
  const hh = String(Math.floor(total / 60)).padStart(2, '0')
  const mm = String(total % 60).padStart(2, '0')
  return `${hh}:${mm}`
}

function formatRoDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }
    const datePart = date.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' })
    const timePart = date.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })
    return `${datePart} · ${timePart}`
  } catch {
    return value || '—'
  }
}

function getStatusMeta(status: string | null | undefined): StatusMeta {
  const value = (status || '').toLowerCase()
  switch (value) {
    case 'active':
    case 'confirmed':
      return { label: 'Confirmată', className: 'bg-emerald-500/15 text-emerald-200 border border-emerald-400/30' }
    case 'pending':
    case 'held':
      return { label: 'În curs', className: 'bg-amber-500/15 text-amber-200 border border-amber-400/30' }
    case 'cancelled':
    case 'canceled':
      return { label: 'Anulată', className: 'bg-rose-500/15 text-rose-200 border border-rose-400/40' }
    case 'completed':
      return { label: 'Finalizată', className: 'bg-sky-500/15 text-sky-200 border border-sky-400/30' }
    default:
      return { label: status || 'Necunoscut', className: 'bg-white/10 text-white/80 border border-white/20' }
  }
}

function ReservationCard({
  group,
  refundState,
  onRefund,
  showRefundAction,
  stopDetailMap,
}: {
  group: ReservationGroup
  refundState?: { status: 'idle' | 'pending' | 'success' | 'error'; message?: string }
  onRefund?: (orderId: number) => void
  showRefundAction?: boolean
  stopDetailMap: Map<string, RouteStopDetail>
}) {
  const statusMeta = getStatusMeta(group.status)
  const tripDateSource = group.tripDate ? `${group.tripDate}T00:00:00` : group.travelDatetime
  const formattedDate = tripDateSource ? formatRoDate(tripDateSource) : '—'
  const directionLabel = group.direction === 'retur' ? 'Retur' : group.direction === 'tur' ? 'Tur' : null
  const reservationDateLabel = group.reservationTime ? formatRoDateTime(group.reservationTime) : null
  const refundDateLabel = group.refundTime ? formatRoDateTime(group.refundTime) : null
  const canRefund = Boolean(showRefundAction && group.orderId && group.isPaid && !group.isRefunded)
  const refundStatus = refundState?.status || 'idle'
  const totalValue = group.seatLines.reduce((sum, seat) => sum + Number(seat.priceValue || 0), 0)
  const stopKey =
    group.routeId && group.direction && group.boardStationId
      ? `${group.routeId}|${group.direction}|${group.boardStationId}`
      : null
  const stopDetail = stopKey ? stopDetailMap.get(stopKey) ?? null : null
  const boardArrival = computeStopTime(group.tripTime, stopDetail?.offset_minutes ?? null)
  const boardTimeLabel = boardArrival ? formatTimeLabel(boardArrival) : formatTimeLabel(group.tripTime)
  const routeLine = [group.boardName, group.exitName].filter(Boolean).join(' → ')
  const vehicleTimeLabel = formatTimeLabel(group.tripTime)
  const vehicleLineParts = [group.routeName, directionLabel, vehicleTimeLabel !== '—' ? vehicleTimeLabel : null].filter(Boolean)

  return (
    <article className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur p-5 md:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-xl font-semibold text-white">{formattedDate}</h3>
        </div>
        <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-wide ${statusMeta.className}`}>
          {statusMeta.label}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="space-y-4 text-sm text-white/70">
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-white/50">Ruta călătorului · Ora</div>
            <div className="font-medium text-white">
              {routeLine || '—'}
              {boardTimeLabel !== '—' ? <span className="text-white/50"> · {boardTimeLabel}</span> : null}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-white/50">Ruta mașinii</div>
            <div className="font-medium text-white">{vehicleLineParts.length ? vehicleLineParts.join(' · ') : '—'}</div>
          </div>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-white/50">Locuri rezervate</div>
            <div className="space-y-2">
              {group.seatLines.map((seat) => {
                const label =
                  seat.discountLabel || (seat.discountTotal && seat.discountTotal > 0 ? 'Reducere aplicată' : 'Preț întreg')
                return (
                  <div key={seat.id} className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-white">Locul {seat.seatLabel || '—'}</div>
                    <div className="text-white/70">
                      {formatCurrency(seat.priceValue, seat.currency)} · {label}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-4 space-y-2 text-sm text-white/70">
          <div className="text-xs uppercase tracking-wide text-white/50">Total comandă</div>
          <div className="text-2xl font-semibold text-white">
            {formatCurrency(totalValue, group.currency)}
          </div>
          {group.isPaid ? (
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-200">
              Plătit integral
            </div>
          ) : group.isRefunded ? (
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-rose-200">
              Refundat
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 text-xs text-white/40">
        {reservationDateLabel && <p>Rezervare înregistrată la {reservationDateLabel}</p>}
        {group.isRefunded && refundDateLabel && <p>Rezervare anulată · refund la {refundDateLabel}</p>}
      </div>

      {(canRefund || (showRefundAction && refundStatus !== 'idle')) && (
        <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white/70">
          {canRefund && (
            <button
              type="button"
              onClick={() => group.orderId && onRefund?.(group.orderId)}
              disabled={refundStatus === 'pending'}
              className="inline-flex items-center justify-center rounded-lg border border-rose-400/20 bg-transparent px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-rose-100/80 transition hover:bg-rose-500/10 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refundStatus === 'pending' ? 'Se procesează refund-ul...' : 'Refund complet'}
            </button>
          )}
          {refundStatus === 'success' && (
            <p className="text-emerald-200">{refundState?.message || 'Refund-ul a fost solicitat cu succes.'}</p>
          )}
          {refundStatus === 'error' && (
            <p className="text-rose-200">{refundState?.message || 'Refund-ul nu a putut fi procesat.'}</p>
          )}
        </div>
      )}
    </article>
  )
}

function AccountPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { session, loading, setSession } = usePublicSession()
  const [reservations, setReservations] = useState<AccountReservationsResponse | null>(null)
  const [reservationsLoading, setReservationsLoading] = useState(false)
  const [reservationsError, setReservationsError] = useState<string | null>(null)
  const [routesMeta, setRoutesMeta] = useState<RoutesMeta | null>(null)
  const [routesMetaError, setRoutesMetaError] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [profilePhone, setProfilePhone] = useState('')
  const [profileSubmitting, setProfileSubmitting] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null)
  const [refundState, setRefundState] = useState<Record<number, { status: 'idle' | 'pending' | 'success' | 'error'; message?: string }>>({})

  const needsContactUpdate = searchParams?.get('missing') === 'contact'

  const loadReservations = useCallback(async () => {
    if (!session) return
    setReservationsLoading(true)
    setReservationsError(null)
    try {
      const data = await fetchAccountReservations()
      setReservations(data)
    } catch (err: any) {
      setReservationsError(err?.message || 'Nu am putut încărca rezervările online.')
    } finally {
      setReservationsLoading(false)
    }
  }, [session])

  useEffect(() => {
    let ignore = false
    fetchRoutesMeta()
      .then((data) => {
        if (!ignore) {
          setRoutesMeta(data)
        }
      })
      .catch((err: any) => {
        if (!ignore) {
          setRoutesMetaError(err?.message || 'Nu am putut încărca detaliile pentru rute.')
        }
      })
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!loading && !session) {
      router.replace(`/login?redirect=${encodeURIComponent('/account')}`)
    }
  }, [loading, session, router])

  useEffect(() => {
    if (session) {
      setProfileName(session.user.name?.trim() || '')
      setProfilePhone(session.user.phone?.trim() || '')
      setProfileError(null)
      setProfileSuccess(null)
    }
  }, [session])

  useEffect(() => {
    if (!loading && session) {
      loadReservations()
    }
  }, [loading, session, loadReservations])

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setProfileError(null)
    setProfileSuccess(null)
    const trimmedName = profileName.trim()
    const trimmedPhone = profilePhone.trim()
    if (!trimmedPhone) {
      setProfileError('Completează numărul de telefon pentru a putea continua rezervările online.')
      return
    }
    try {
      setProfileSubmitting(true)
      const response = await updatePublicProfile({
        name: trimmedName ? trimmedName : null,
        phone: trimmedPhone,
      })
      setProfileSuccess(response.message || 'Datele au fost actualizate.')
      setSession(response.session)
    } catch (err: any) {
      const message = err?.message || 'Nu am putut actualiza profilul.'
      setProfileError(message)
    } finally {
      setProfileSubmitting(false)
    }
  }

  const stopDetailMap = useMemo(() => {
    const map = new Map<string, RouteStopDetail>()
    routesMeta?.stopDetails?.forEach((detail) => {
      const key = `${detail.route_id}|${detail.direction}|${detail.station_id}`
      map.set(key, detail)
    })
    return map
  }, [routesMeta])

  const groupReservations = useCallback((items: AccountReservation[]): ReservationGroup[] => {
    const groups = new Map<string, ReservationGroup>()
    items.forEach((reservation) => {
      const key = reservation.order_id ? `order-${reservation.order_id}` : `reservation-${reservation.id}`
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          orderId: reservation.order_id ?? null,
          reservations: [],
          seatLines: [],
          routeName: reservation.route_name ?? null,
          routeId: reservation.route_id ?? null,
          direction: reservation.direction ?? null,
          tripDate: reservation.trip_date ?? null,
          tripTime: reservation.trip_time ?? null,
          travelDatetime: reservation.travel_datetime ?? null,
          boardName: reservation.board_name ?? null,
          exitName: reservation.exit_name ?? null,
          boardStationId: reservation.board_station_id ?? null,
          exitStationId: reservation.exit_station_id ?? null,
          reservationTime: reservation.reservation_time ?? null,
          refundTime: reservation.refund_time ?? null,
          status: reservation.status ?? null,
          isPaid: reservation.is_paid,
          isRefunded: reservation.is_refunded,
          paymentMethod: reservation.payment_method ?? null,
          currency: reservation.currency ?? null,
        })
      }
      const group = groups.get(key)
      if (!group) return
      group.reservations.push(reservation)
      group.seatLines.push({
        id: reservation.id,
        seatLabel: reservation.seat_label || '—',
        priceValue: reservation.price_value != null ? Number(reservation.price_value) : null,
        discountLabel: reservation.discount_label,
        discountTotal: reservation.discount_total != null ? Number(reservation.discount_total) : null,
        currency: reservation.currency ?? null,
      })
      if (!group.isPaid && reservation.is_paid) {
        group.isPaid = true
      }
      if (!group.isRefunded && reservation.is_refunded) {
        group.isRefunded = true
      }
      if (reservation.refund_time) {
        if (!group.refundTime) {
          group.refundTime = reservation.refund_time
        } else {
          const nextValue = new Date(reservation.refund_time).getTime()
          const currentValue = new Date(group.refundTime).getTime()
          if (!Number.isNaN(nextValue) && (Number.isNaN(currentValue) || nextValue > currentValue)) {
            group.refundTime = reservation.refund_time
          }
        }
      }
    })
    const output = Array.from(groups.values())
    output.forEach((group) => {
      group.seatLines.sort((a, b) => a.seatLabel.localeCompare(b.seatLabel, 'ro'))
    })
    return output
  }, [])

  const renderReservationGroup = (items: AccountReservation[], emptyMessage: string, showRefundAction = false) => {
    if (!items.length) {
      if (initialLoading && !reservationsError) {
        return <p className="text-sm text-white/60">Se încarcă rezervările...</p>
      }
      return <p className="text-sm text-white/60">{emptyMessage}</p>
    }
    const groupedItems = groupReservations(items)
    return (
      <div className="space-y-4">
        {groupedItems.map((group) => (
          <ReservationCard
            key={group.key}
            group={group}
            refundState={group.orderId ? refundState[group.orderId] : undefined}
            onRefund={(orderId) => handleRefund(orderId)}
            showRefundAction={showRefundAction}
            stopDetailMap={stopDetailMap}
          />
        ))}
      </div>
    )
  }

  const handleRefund = async (orderId: number) => {
    if (!window.confirm('Ești sigur că vrei să anulezi rezervarea și să ceri refund?')) {
      return
    }
    setRefundState((prev) => ({
      ...prev,
      [orderId]: { status: 'pending' },
    }))
    try {
      const response = await refundPublicOrder(orderId)
      setRefundState((prev) => ({
        ...prev,
        [orderId]: { status: 'success', message: response.message },
      }))
      await loadReservations()
    } catch (err: any) {
      const message = err?.message || 'Refund-ul nu a putut fi procesat.'
      setRefundState((prev) => ({
        ...prev,
        [orderId]: { status: 'error', message },
      }))
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-slatebg text-white">
        <Navbar />
        <div className="max-w-4xl mx-auto px-4 py-20 text-center text-white/70">
          Se încarcă datele contului...
        </div>
      </main>
    )
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-slatebg text-white">
        <Navbar />
        <div className="max-w-4xl mx-auto px-4 py-20 text-center text-white/70">
          Te redirecționăm către autentificare...
        </div>
      </main>
    )
  }

  const displayName = session.user.name?.trim() || session.user.email || 'utilizator'
  const phoneMissing = !session.user.phone || !session.user.phone.trim()
  const accountEmail = session.user.email || ''
  const upcomingReservations = reservations?.upcoming ?? []
  const pastReservations = reservations?.past ?? []
  const initialLoading = reservationsLoading && !reservations

  return (
    <main className="min-h-screen bg-slatebg text-white">
      <Navbar />
      <section className="max-w-5xl mx-auto px-4 py-10 space-y-6">
        <header className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <p className="text-sm uppercase tracking-wide text-white/50">Contul tău</p>
          <h1 className="mt-2 text-3xl font-semibold">Bine ai revenit, {displayName}!</h1>
          <p className="mt-3 text-sm text-white/70">
            Rezervările realizate online sunt afișate mai jos. Rezervările efectuate telefonic sau la autogară nu sunt sincronizate automat cu contul online.
          </p>
        </header>

        <section className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur px-5 py-6 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Datele contului</h2>
              <p className="text-sm text-white/60">Actualizează numele și numărul de telefon folosite pentru rezervările online.</p>
            </div>
            {phoneMissing && (
              <span className="inline-flex items-center rounded-full border border-amber-300/40 bg-amber-400/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-100">
                Telefon lipsă
              </span>
            )}
          </div>

          {needsContactUpdate && (
            <div className="rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Completează numărul de telefon pentru a finaliza rezervarea începută. După salvare, reia procesul de rezervare.
            </div>
          )}

          {profileError && (
            <p className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{profileError}</p>
          )}
          {profileSuccess && (
            <p className="rounded-2xl border border-emerald-300/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">{profileSuccess}</p>
          )}

          <form onSubmit={handleProfileSubmit} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="account-email" className="block text-xs font-medium uppercase tracking-wide text-white/50">
                Email
              </label>
              <input
                id="account-email"
                type="email"
                value={accountEmail}
                readOnly
                disabled
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2 text-sm text-white/70"
              />
            </div>
            <div>
              <label htmlFor="account-name" className="block text-xs font-medium text-white/70">
                Nume complet
              </label>
              <input
                id="account-name"
                type="text"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                autoComplete="name"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder-white/40 focus:border-brand focus:outline-none"
                placeholder="Ex. Maria Popescu"
              />
            </div>
            <div>
              <label htmlFor="account-phone" className="block text-xs font-medium text-white/70">
                Telefon
              </label>
              <input
                id="account-phone"
                type="tel"
                inputMode="tel"
                value={profilePhone}
                onChange={(event) => setProfilePhone(event.target.value)}
                autoComplete="tel"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder-white/40 focus:border-brand focus:outline-none"
                placeholder="07xx xxx xxx"
                required
              />
            </div>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-black transition hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={profileSubmitting}
              >
                {profileSubmitting ? 'Se salvează...' : 'Salvează modificările'}
              </button>
              <p className="text-xs text-white/50">Numărul de telefon este folosit pentru confirmarea rezervărilor online.</p>
            </div>
          </form>
        </section>

        {reservationsError && (
          <div className="rounded-3xl border border-rose-400/40 bg-rose-500/10 px-5 py-4 text-sm text-rose-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{reservationsError}</span>
            <button
              type="button"
              onClick={loadReservations}
              className="inline-flex items-center justify-center rounded-lg border border-rose-200/40 px-3 py-1.5 text-sm font-semibold text-rose-50 transition hover:bg-rose-500/20"
            >
              Încearcă din nou
            </button>
          </div>
        )}

        {routesMetaError && (
          <div className="rounded-3xl border border-amber-300/40 bg-amber-400/10 px-5 py-4 text-sm text-amber-100">
            {routesMetaError}
          </div>
        )}

        <section className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur px-5 py-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-white">Rezervări viitoare</h2>
            {reservationsLoading && (
              <span className="text-xs uppercase tracking-wide text-white/50">Se actualizează…</span>
            )}
          </div>
          {renderReservationGroup(upcomingReservations, 'Nu ai rezervări viitoare în acest moment.', true)}
        </section>

        <section className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur px-5 py-6 space-y-4">
          <h2 className="text-xl font-semibold text-white">Rezervări anterioare</h2>
          {renderReservationGroup(pastReservations, 'Nu există încă rezervări anterioare înregistrate online.')}
        </section>

        <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur px-6 py-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm text-white/70">
            <p className="text-white font-semibold">Planifică următoarea călătorie</p>
            <p className="text-white/60">Caută curse noi și rezervă locurile direct din platformă.</p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-black shadow-soft transition hover:bg-brand/80"
          >
            Caută o cursă nouă
          </Link>
        </div>
      </section>
    </main>
  )
}

export default function AccountPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-slatebg text-white">
          <Navbar />
          <div className="max-w-4xl mx-auto px-4 py-20 text-center text-white/70">
            Se încarcă datele contului...
          </div>
        </main>
      }
    >
      <AccountPageContent />
    </Suspense>
  )
}
