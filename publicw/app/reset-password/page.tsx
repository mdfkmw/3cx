'use client'

import { Suspense, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import { confirmPasswordReset } from '@/lib/api'

function ResetPasswordPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams?.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setMessage(null)

    if (!token) {
      setError('Linkul de resetare este invalid sau incomplet.')
      return
    }

    if (password.length < 8) {
      setError('Parola trebuie să aibă minimum 8 caractere.')
      return
    }

    if (password !== confirm) {
      setError('Parolele nu coincid.')
      return
    }

    try {
      setLoading(true)
      const response = await confirmPasswordReset({ token, password })
      setMessage(response.message || 'Parola a fost resetată. Te poți autentifica acum.')
      setTimeout(() => {
        router.push('/login')
      }, 1500)
    } catch (err: any) {
      setError(err?.message || 'Nu am putut reseta parola. Încearcă din nou.')
    } finally {
      setLoading(false)
    }
  }

  const invalidToken = !token

  return (
    <main className="min-h-screen bg-slatebg text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-4 py-16 text-center">
        <div className="w-full space-y-6 rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur">
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold">Setează o parolă nouă</h1>
            <p className="text-sm text-white/70">
              Alege o parolă nouă pentru contul tău Pris-Com.
            </p>
          </div>

          {invalidToken ? (
            <p className="rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-200">
              Linkul de resetare este invalid. Cere un link nou din pagina de autentificare.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 text-left">
              <div className="space-y-1">
                <label htmlFor="new-password" className="block text-xs font-medium text-white/70">
                  Parolă nouă
                </label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder-white/40 focus:border-brand focus:outline-none"
                  placeholder="Minim 8 caractere"
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="confirm-password" className="block text-xs font-medium text-white/70">
                  Confirmă parola
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm text-white placeholder-white/40 focus:border-brand focus:outline-none"
                  placeholder="Repetă parola"
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
                {loading ? 'Se salvează...' : 'Resetează parola'}
              </button>
            </form>
          )}

          <div className="pt-4 text-sm text-white/60">
            <p>
              Ai nevoie de ajutor?{' '}
              <Link href="/contact" className="font-semibold text-white hover:underline">
                Contactează-ne
              </Link>
              .
            </p>
            <p className="mt-2">
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slatebg" />}>
      <ResetPasswordPageContent />
    </Suspense>
  )
}
