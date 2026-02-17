import Navbar from '@/components/Navbar'
import { operatorDetails } from '@/lib/companyInfo'

export const metadata = {
  title: 'Politica de confidențialitate',
  description: 'Politica de confidențialitate, cookie-uri și reclamații aplicabilă platformei www.pris-com.ro.',
}

const policySections = [
  {
    title: '2. Domeniul de aplicare',
    paragraphs: [
      'Prezenta politică se aplică tuturor persoanelor ale căror date sunt prelucrate ca urmare a accesării site-ului, efectuării unei rezervări, achiziționării unui bilet sau comunicării cu operatorii Pris Com.',
    ],
  },
  {
    title: '3. Categorii de date prelucrate',
    paragraphs: [
      'Date de identificare (nume, prenume), date de contact (telefon, email), date privind călătoria (rută, dată, oră, loc), date de facturare, istoricul rezervărilor.',
      'Date tehnice colectate automat: adresă IP, tip dispozitiv, browser, sistem de operare, pagini accesate, cookie-uri.',
    ],
  },
  {
    title: '4. Scopurile prelucrării',
    paragraphs: [
      'Încheierea și executarea contractului de transport.',
      'Emiterea biletelor și documentelor fiscale.',
      'Comunicări operaționale privind întârzieri, modificări sau anulări.',
      'Soluționarea reclamațiilor și solicitărilor.',
      'Prevenirea fraudelor și securitatea platformei.',
      'Respectarea obligațiilor legale.',
    ],
  },
  {
    title: '5. Temeiul legal',
    paragraphs: [
      'Executarea contractului de transport.',
      'Îndeplinirea obligațiilor legale.',
      'Interesul legitim al operatorilor.',
      'Consimțământul utilizatorului, acolo unde este necesar.',
    ],
  },
  {
    title: '6. Destinatarii datelor',
    paragraphs: [
      'Procesatori de plăți (ex: eBTpay).',
      'Furnizori IT, hosting, email, SMS.',
      'Personal autorizat al operatorilor.',
      'Autorități publice, conform legislației.',
    ],
  },
  {
    title: '7. Transferuri internaționale',
    paragraphs: [
      'Datele nu sunt transferate în afara Uniunii Europene, cu excepția situațiilor în care acest lucru este necesar și se face cu garanții conforme GDPR.',
    ],
  },
  {
    title: '8. Durata păstrării datelor',
    paragraphs: [
      'Datele operaționale se păstrează până la 24 de luni.',
      'Datele contabile și fiscale se păstrează conform legislației în vigoare.',
      'Datele utilizate în scop de marketing se păstrează până la retragerea consimțământului.',
    ],
  },
  {
    title: '9. Drepturile persoanelor vizate',
    paragraphs: [
      'Drept de acces, rectificare, ștergere, restricționare, portabilitate, opoziție și retragere a consimțământului.',
      'Dreptul de a depune plângere la Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal.',
    ],
  },
  {
    title: '10. Securitatea datelor',
    paragraphs: [
      'Datele sunt protejate prin conexiuni HTTPS, control al accesului, logare, backup periodic și politici interne de securitate.',
    ],
  },
  {
    title: '11. Politica de cookie-uri',
    paragraphs: [
      'Site-ul utilizează cookie-uri strict necesare, funcționale, analitice și de marketing.',
      'Cookie-urile necesare sunt esențiale pentru funcționarea platformei.',
      'Celelalte tipuri de cookie-uri sunt utilizate doar cu consimțământul utilizatorului.',
    ],
  },
  {
    title: '12. Politica de reclamații',
    paragraphs: [
      'Reclamațiile se pot transmite în maximum 3 zile de la data călătoriei la rezervari@pris-com.ro.',
      'Termenul de răspuns este de maximum 30 de zile.',
    ],
  },
  {
    title: '13. Modificări',
    paragraphs: [
      'Prezenta politică poate fi actualizată periodic. Versiunea curentă este publicată pe site.',
    ],
  },
  {
    paragraphs: [
      'Versiunea: 1.0 din 20.01.2026',
    ],
  },
]


export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-slatebg text-white">
      <Navbar />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-12">
        <header className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <h1 className="mt-2 text-3xl font-semibold md:text-4xl">Politica cookies/confidențialitate/reclamații</h1>
          <p className="mt-3 text-sm text-white/70">
            Informațiile sunt preluate din documentul „Politica_confidentialitate_priscom.docx” și descriu modul în care Pris Com
            colectează, utilizează și protejează datele personale.
          </p>
        </header>

        <section className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <h2 className="text-xl font-semibold">1. Operatorii datelor</h2>
          <p className="mt-3 text-sm text-white/70">
            Datele sunt administrate de operatorii Pris Com enumerați mai jos. Pentru orice solicitare scrie-ne la{' '}
            <a href="mailto:rezervari@pris-com.ro" className="text-white hover:text-brand">
              rezervari@pris-com.ro
            </a>{' '}
            sau sună la{' '}
            <a href="tel:0740470996" className="text-white hover:text-brand">
              0740 470 996
            </a>
            .
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {operatorDetails.map((operator) => (
              <div key={operator.name} className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/70">
                <p className="font-semibold text-white">{operator.name}</p>
                <p>{operator.cui}</p>
                <p>{operator.reg}</p>
                <p>{operator.address}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-6">
          {policySections.map((section) => (
            <article key={section.title} className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <h2 className="text-xl font-semibold">{section.title}</h2>
              <div className="mt-3 space-y-3 text-sm text-white/70">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  )
}
