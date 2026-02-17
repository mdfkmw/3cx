'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'

import { requestPasswordReset } from '@/lib/api'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setMessage(null)

    if (!email.trim()) {
      setError('Introduce adresa de email pentru a continua.')
      return
    }

    try {
      setLoading(true)
      const response = await requestPasswordReset({ email: email.trim() })
      setMessage(response.message || 'Dacă există un cont pentru această adresă, vei primi un email de resetare.')
    } catch (err: any) {
      setError(err?.message || 'Nu am putut trimite cererea de resetare. Încearcă din nou.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-slatebg text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <div className="w-full space-y-6 rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold">Resetează parola</h1>
            <p className="text-sm text-white/70">
              Introdu adresa de email asociată contului tău. Îți trimitem un link pentru resetarea parolei.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4 text-left">
            <div className="space-y-1">
              <label htmlFor="reset-email" className="block text-xs font-medium text-white/70">
                Email
              </label>
              <input
                id="reset-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder-white/40 focus:border-brand focus:outline-none"
                placeholder="nume@exemplu.ro"
                required
              />
            </div>

            {error ? <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p> : null}
            {message ? <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{message}</p> : null}

            <button
              type="submit"
              className="w-full rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-black transition hover:bg-brand/80 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
            >
              {loading ? 'Se trimite...' : 'Trimite linkul de resetare'}
            </button>
          </form>

          <div className="pt-4 text-sm text-white/60">
            <p>
              Ți-ai amintit parola?{' '}
              <Link href="/login" className="font-semibold text-white hover:underline">
                Înapoi la autentificare
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
