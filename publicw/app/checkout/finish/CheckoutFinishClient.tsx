'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import Navbar from '@/components/Navbar'
import { fetchCheckoutStatus, retryPublicCheckout, ApiError } from '@/lib/api'

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'pending'; expired?: boolean }
  | {
      kind: 'paid'
      reservationIds?: number[]
      summary?: {
        trip_date: string
        departure_time: string
        route_name: string
        board_at: string
        exit_at: string
        seat_count: number
        seat_labels: string[]
        discount_total: number
        promo_total: number
        paid_amount: number
        currency: string
      } | null
    }

export default function CheckoutFinishClient() {
  const sp = useSearchParams()

  const orderId = useMemo(() => {
    const raw = sp.get('order_id')
    const id = raw ? Number(raw) : NaN
    return Number.isFinite(id) && id > 0 ? id : null
  }, [sp])

  const [state, setState] = useState<ViewState>({ kind: 'loading' })

  useEffect(() => {
    if (!orderId) {
      setState({ kind: 'error', message: 'Lipsește order_id din link.' })
      return
    }

    let mounted = true

    const run = async () => {
      try {
        const resp = await fetchCheckoutStatus(orderId)
        if (!mounted) return

        if (resp.paid) {
          setState({
            kind: 'paid',
            reservationIds: resp.reservation_ids,
            summary: resp.summary ?? null,
          })
        } else {
          setState({ kind: 'pending', expired: resp.expired })
        }
      } catch (err: any) {
        if (!mounted) return
        if (err instanceof ApiError) {
          setState({ kind: 'error', message: err.message })
          return
        }
        setState({ kind: 'error', message: 'Nu am putut verifica statusul plății.' })
      }
    }

    run()

    return () => {
      mounted = false
    }
  }, [orderId])

  const handleRetry = async () => {
    if (!orderId) return
    try {
      setState({ kind: 'loading' })
      const resp = await retryPublicCheckout(orderId)
      if (resp.form_url) {
        window.location.href = resp.form_url
        return
      }
      setState({ kind: 'error', message: 'Nu am primit link nou de plată.' })
    } catch (err: any) {
      if (err instanceof ApiError) {
        setState({ kind: 'error', message: err.message })
        return
      }
      setState({ kind: 'error', message: 'Nu am putut reiniția plata.' })
    }
  }

  return (
    <>
      <Navbar />
            <main className="mx-auto max-w-2xl p-6">
                {state.kind === 'loading' && (
                    <div className="rounded-lg border p-4">
                        <h1 className="text-lg font-semibold">Verificam plata...</h1>
                        <p className="text-sm text-gray-600">Te rugăm așteaptă câteva secunde.</p>
                    </div>
                )}

                {state.kind === 'paid' && (
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                        <h1 className="text-lg font-semibold text-green-800">Plata a fost confirmată ✅</h1>
                        <p className="mt-2 text-sm text-green-700">Biletele au fost emise.</p>

                        {state.summary && (
                            <div className="mt-4 space-y-1 text-sm text-green-800">
                                <div><strong>Data cursei:</strong> {state.summary.trip_date}</div>

                                <div>
                                    <strong>Ora:</strong> {state.summary.departure_time}{' '}
                                    <span className="text-green-700">
                                        (IMPORTANT: Prezentați-vă cu 15 minute mai devreme)
                                    </span>
                                </div>

                                <div><strong>Ruta mașinii:</strong> {state.summary.route_name}</div>

                                <div>
                                    <strong>Rezervarea ta:</strong> {state.summary.board_at} → {state.summary.exit_at}
                                </div>

                                <div>
                                    <strong>Locuri:</strong>{' '}
                                    {state.summary.seat_labels?.length
                                        ? state.summary.seat_labels.join(', ')
                                        : state.summary.seat_count}
                                </div>

                                {(state.summary.discount_total > 0 || state.summary.promo_total > 0) && (
                                    <div>
                                        <strong>Reduceri:</strong>{' '}
                                        {state.summary.discount_total + state.summary.promo_total}{' '}
                                        {state.summary.currency}
                                    </div>
                                )}

                                <div className="font-semibold">
                                    Valoare plată: {state.summary.paid_amount} {state.summary.currency}
                                </div>
                            </div>
                        )}

                        {!!state.reservationIds?.length && (
                            <p className="mt-3 text-sm text-green-700">
                                ID rezervări: {state.reservationIds.join(', ')}
                            </p>
                        )}
                    </div>
                )}


                {state.kind === 'pending' && (
                    <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                        <h1 className="text-lg font-semibold text-yellow-800">Plata nu este confirmată</h1>
                        {state.expired ? (
                            <p className="mt-2 text-sm text-yellow-700">
                                Comanda a expirat (10 minute). Te rugăm să reiei rezervarea.
                            </p>
                        ) : (
                            <p className="mt-2 text-sm text-yellow-700">
                                Plata este în așteptare sau a fost refuzată. Poți încerca din nou.
                            </p>
                        )}
                        {!state.expired && (
                            <button
                                onClick={handleRetry}
                                className="mt-4 rounded bg-yellow-600 px-4 py-2 text-white hover:bg-yellow-700"
                            >
                                Reîncearcă plata
                            </button>
                        )}
                    </div>
                )}

                {state.kind === 'error' && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                        <h1 className="text-lg font-semibold text-red-800">Eroare</h1>
                        <p className="mt-2 text-sm text-red-700">{state.message}</p>
                    </div>
                )}
            </main>
        </>
  )
}
