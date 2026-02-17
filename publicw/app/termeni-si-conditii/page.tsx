import Navbar from '@/components/Navbar'
import { operatorDetails } from '@/lib/companyInfo'

export const metadata = {
  title: 'Termeni și condiții - Pris Com',
  description:
    'Termenii și condițiile serviciilor de rezervare și vânzare bilete operate pe www.pris-com.ro.',
}

const termsSections = [
  {
    title: '2. Definiții',
    paragraphs: [
      '„Platforma” – site-ul www.pris-com.ro.',
      '„Administratorul Platformei” – AUTO-DIMAS SRL, care asigură administrarea tehnică și operarea platformei.',
      '„Transportator” – societatea care operează efectiv cursa înscrisă pe bilet (AUTO-DIMAS SRL sau PRISCOM UNIVERS SRL).',
      '„Client / Pasager” – persoana fizică sau juridică ce rezervă și/sau achiziționează un bilet.',
      '„Bilet” – document fiscal și contract de transport, emis de Transportator.',
      '„Confirmarea comenzii” – dovada electronică a rezervării și/sau a plății (email/SMS, după caz).',
    ],
  },
  {
    title: '3. Obiectul serviciului',
    paragraphs: [
      'Platforma PRIS-COM.RO permite informarea publicului și vânzarea directă de bilete pentru cursele operate de Transportatori sub marca PRIS-COM.',
      'Prin achiziția biletului se încheie un contract de transport între Client și Transportatorul indicat pe bilet.',
      'Răspunderea pentru executarea transportului aparține Transportatorului înscris pe bilet.',
    ],
  },
  {
    title: '4. Rolul Administratorului Platformei',
    paragraphs: [
      'Administratorul Platformei asigură funcționarea tehnică a site-ului, afișarea informațiilor, procesul de rezervare și integrarea plăților.',
      'Administratorul transmite datele rezervării către Transportatorul care operează cursa.',
      
    ],
  },
  {
    title: '5. Rezervarea și achiziția biletelor',
    paragraphs: [
      'Rezervarea și achiziția se realizează prin intermediul Platformei și se supun regulilor afișate în sistem.',
      'Clientul este responsabil pentru corectitudinea datelor furnizate (nume, telefon, email, rută, dată, oră, stații, număr pasageri).',
      'În cazul introducerii unor date eronate, Transportatorul poate întâmpina dificultăți în notificarea Clientului sau în identificarea acestuia la îmbarcare, fără a fi ținut răspunzător pentru consecințe.',
    ],
  },
  {
    title: '6. Prețuri, taxe și modalități de plată',
    paragraphs: [
      'Tarifele sunt afișate în RON și pot fi actualizate fără notificare prealabilă, în funcție de rută, segment, categorie sau alte condiții comerciale.',
      'Plata se efectuează prin procesatorul de plăți integrat (ex: eBTpay). Platforma nu stochează datele cardului bancar.',
      'Eventualele comisioane ale procesatorului de plăți sunt afișate în timpul comenzii, înainte de finalizarea acesteia.',
    ],
  },
  {
    title: '7. Livrarea biletului / confirmării',
    paragraphs: [
      'Biletul (sau confirmarea comenzii, după caz) este transmis electronic prin email după confirmarea plății.',
      'Clientul are obligația să verifice primirea biletului/confirmării și să contacteze suportul dacă nu primește documentele într-un interval rezonabil.',
      'Biletul electronic are valoare juridică egală cu biletul tipărit și poate fi prezentat la îmbarcare de pe telefon sau în format tipărit.',
    ],
  },
  {
    title: '8. Obligațiile Transportatorilor',
    paragraphs: [
      'Transportatorii se obligă să efectueze cursele conform orarului publicat, cu respectarea normelor legale aplicabile transportului rutier de persoane.',
      'Transportatorii pot modifica orarul, traseul, stațiile de îmbarcare/debarcare sau pot înlocui vehiculul din motive operaționale, de siguranță, condiții meteo, trafic, dispoziții ale autorităților sau alte situații obiective.',
      'În cazul unei defecțiuni majore, Transportatorul poate înlocui vehiculul sau poate reorganiza cursa în funcție de posibilități și de siguranța pasagerilor.',
    ],
  },
  {
    title: '9. Obligațiile Clientului și îmbarcarea',
    paragraphs: [
      'Clientul trebuie să se prezinte la îmbarcare cu minimum 15 minute înainte de ora plecării.',
      'Clientul trebuie să dețină un document de identitate valabil și să îl prezinte la solicitarea personalului.',
      'Clientul trebuie să respecte indicațiile personalului Transportatorului și regulile de conduită și siguranță.',
    ],
  },
  {
    title: '10. Anulare, reprogramare și rambursare',
    paragraphs: [
      'Anularea sau reprogramarea este posibilă cu minimum 24 de ore înainte de plecare, dacă limita afișată în sistem permite și în funcție de disponibilitatea locurilor.',
      'Rambursarea se face în condițiile afișate în sistem și poate implica reținerea taxelor procesatorului de plăți (dacă acestea sunt nerecuperabile).',
      'Rezervările efectuate cu mai puțin de 24 de ore înainte de plecare nu sunt rambursabile.',
      'După reprogramarea unei călătorii, biletul nu mai poate fi anulat sau rambursat.',
      'În caz de neprezentare la îmbarcare („no-show”), nu se acordă rambursare.',
      'Rambursările aprobate se procesează în același cont/card în 3–7 zile lucrătoare (termen orientativ, în funcție de procesator/bancă).',
    ],
  },
  {
    title: '11. Întârzieri, modificări și anulări de curse',
    paragraphs: [
      'Transportatorul nu este responsabil pentru întârzieri cauzate de trafic, vreme, accidente, controale, restricții de circulație, închideri de drum sau dispoziții ale autorităților.',
      'În cazul anulării unei curse din culpa Transportatorului, Clientul poate opta pentru reprogramare sau rambursare, conform condițiilor aplicabile.',
      'În cazul modificărilor (oră, vehicul, stație), Transportatorul va încerca să informeze Clientul prin datele de contact furnizate.',
    ],
  },
  {
    title: '12. Bagaje',
    paragraphs: [
      'Fiecare pasager are dreptul la bagaj în limita stabilită de Transportator (greutate/dimensiuni), comunicată la cerere sau afișată în sistem.',
      'Transportatorul nu răspunde pentru bunuri fragile, perisabile sau obiecte de valoare transportate în bagaje.',
      'Este interzis transportul de substanțe periculoase sau ilegale. Transportatorul poate refuza transportul bagajelor neconforme.',
    ],
  },
  {
    title: '13. Conduita pasagerilor și refuzul îmbarcării',
    paragraphs: [
      'Este interzis fumatul, consumul de alcool, comportamentul agresiv sau orice faptă care pune în pericol siguranța pasagerilor sau a personalului.',
      'Transportatorul poate refuza îmbarcarea sau poate solicita coborârea pasagerului în cazul nerespectării regulilor, fără rambursare, atunci când situația este imputabilă pasagerului.',
    ],
  },
  {
    title: '14. Reduceri și facilități (ex: copii)',
    paragraphs: [
      'Reducerile sunt afișate în sistem și se aplică conform condițiilor comunicate.',
      'Transportatorul poate solicita prezentarea unui document justificativ (ex: vârstă copil) la îmbarcare.',
      'În lipsa documentelor justificative, Transportatorul poate solicita achitarea diferenței de tarif sau poate refuza aplicarea reducerii.',
    ],
  },
  {
    title: '15. Reclamații și suport',
    paragraphs: [
      'Reclamațiile se trimit în maximum 3 zile de la călătorie la rezervari@pris-com.ro.',
      'Termenul de răspuns este de cel mult 30 de zile.',
      'Pentru situații urgente în ziua plecării (ex: neprimire bilet), Clientul trebuie să contacteze suportul cât mai rapid posibil.',
    ],
  },
  {
    title: '16. Răspundere',
    paragraphs: [
      'Răspunderea pentru executarea transportului aparține exclusiv Transportatorului indicat pe bilet.',
      'Administratorul Platformei nu răspunde pentru prejudicii rezultate din executarea transportului de către Transportatorul diferit de AUTO-DIMAS SRL.',
      'Transportatorii nu răspund pentru pierderi indirecte (ex: conexiuni ratate, rezervări ulterioare), cu excepția cazurilor impuse de lege.',
    ],
  },
  {
    title: '17. Drepturi de autor',
    paragraphs: [
      'Întreg conținutul Platformei (texte, logo, grafică, structură, elemente de design) este protejat de legislația privind drepturile de autor.',
      'Copierea, reproducerea, distribuirea sau utilizarea în scop comercial fără acordul scris al Administratorului este interzisă.',
    ],
  },
  {
    title: '18. Forță majoră',
    paragraphs: [
      'Forța majoră exonerează părțile de răspundere, total sau parțial, în cazul neexecutării obligațiilor, conform legislației.',
      'Sunt considerate cazuri de forță majoră evenimente imprevizibile și insurmontabile, independente de voința părților (ex: fenomene meteo extreme, calamități, restricții impuse de autorități).',
    ],
  },
  {
    title: '19. Legea aplicabilă și litigii',
    paragraphs: [
      'Prezentul document este guvernat de legea română.',
      'Eventualele litigii se soluționează pe cale amiabilă, iar în caz contrar de instanțele competente din România.',
    ],
  },
  {
    title: '20. Modificarea termenilor',
    paragraphs: [
      'Administratorul Platformei își rezervă dreptul de a modifica prezentul document fără notificare prealabilă.',
      'Versiunea actualizată este publicată pe Platformă și produce efecte de la data publicării.',
    ],
  },
    {
    paragraphs: [
      'Versiunea: 1.0 din 20.01.2026',
    ],
  },
]


export default function TermsPage() {
  return (
    <main className="min-h-screen bg-slatebg text-white">
      <Navbar />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-12">
        <header className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <h1 className="mt-2 text-3xl font-semibold md:text-4xl">Termeni și condiții</h1>
          <p className="mt-3 text-sm text-white/70">
            Termenii descriu condițiile comerciale aplicabile
            serviciilor Pris Com Univers si Auto Dimas.
          </p>
        </header>

        <section className="rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <h2 className="text-xl font-semibold">1. Informații despre operatori</h2>
          <p className="mt-3 text-sm text-white/70">
            Serviciile de transport sunt efectuate de următorii operatori, iar platforma www.pris-com.ro este administrată
            tehnic de SC AUTO DIMAS SRL.
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
          <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/70">
            <p className="font-semibold text-white">Contact suport rezervări</p>
            <p>
              Email:{' '}
              <a href="mailto:rezervari@pris-com.ro" className="text-white hover:text-brand">
                rezervari@pris-com.ro
              </a>
            </p>
            <p>
              Telefon:{' '}
              <a href="tel:0740470996" className="text-white hover:text-brand">
                0740 470 996
              </a>
            </p>
          </div>
        </section>

        <section className="space-y-6">
          {termsSections.map((section) => (
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
