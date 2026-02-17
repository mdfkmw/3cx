import { Suspense } from 'react'
import CheckoutFinishClient from './CheckoutFinishClient'

export default function CheckoutFinishPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-2xl p-6">
          <div className="rounded-lg border p-4">
            <h1 className="text-lg font-semibold">Verificăm plata...</h1>
            <p className="text-sm text-gray-600">Te rugăm așteaptă câteva secunde.</p>
          </div>
        </main>
      }
    >
      <CheckoutFinishClient />
    </Suspense>
  )
}
