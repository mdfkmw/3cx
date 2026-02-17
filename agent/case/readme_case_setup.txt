📘 README – Configurare Case Fiscale (PRISCOM / AUTODIMAS)

Acest document explică:

cum se configurează fișierul .env

cum identifici corect fiecare casă fiscală

ce faci dacă se inversează porturile COM

1️⃣ Unde se face configurarea

Fișierul:

C:\agent\case\.env


Aici se configurează:

ce COM este A și B

ce casă trebuie să fie pe A și B

cum se identifică fiecare firmă

2️⃣ Structura completă .env (exemplu)
# Porturi COM
DEV_A_PORT=COM3
DEV_B_PORT=COM4

# Ce firmă trebuie să fie pe fiecare device
DEV_A_EXPECTED_FISCAL_ID=PRISCOM
DEV_B_EXPECTED_FISCAL_ID=AUTODIMAS

# Cum identificăm fiecare firmă (IMPORTANT)
PRISCOM_MATCH=TEXT:PRISCOM
AUTODIMAS_MATCH=TEXT:RO14327313

# Blocare fiscal dacă este inversat
BLOCK_ALL_ON_MISMATCH=0

3️⃣ Cum afli valorile corecte pentru PRISCOM
PAS 1 – Conectează DOAR casa PRISCOM la PC

Scoate Autodimas.
Lasă doar casa PRISCOM conectată.

PAS 2 – Pornește CaseService

Din tray:

Stop CASE

Start CASE

PAS 3 – Deschide în browser:
http://127.0.0.1:9000/health


Vei vedea ceva de genul:

{
  "id": "A",
  "identity": {
    "raw": "0   DB4500002769   6000594228   SC PRISCOM SRL   CIF: RO12345678"
  }
}

PAS 4 – Alege un identificator UNIC

Cel mai sigur este:

CIF (RO....)

sau FM number

sau un serial clar unic

Exemplu bun:

Dacă vezi:

CIF: RO12345678


Pune în .env:

PRISCOM_MATCH=TEXT:RO12345678


NU folosi doar “PRISCOM” dacă nu e 100% sigur.

4️⃣ Cum afli valorile pentru AUTODIMAS

Repeți exact aceiași pași:

Conectezi doar casa Autodimas

Deschizi /health

Copiezi CIF-ul sau FM-ul

Pui în .env:

AUTODIMAS_MATCH=TEXT:RO14327313

5️⃣ Ce înseamnă fiecare setare
DEV_A_PORT / DEV_B_PORT

Portul COM unde este conectată casa.

Dacă se inversează porturile:

modifici doar aceste două valori

repornești CaseService

DEV_A_EXPECTED_FISCAL_ID

Spune ce firmă trebuie să fie pe A.

Valori:

PRISCOM

AUTODIMAS

PRISCOM_MATCH / AUTODIMAS_MATCH

Regula de identificare.

Formate acceptate:

TEXT:valoare
FM:valoare
SERIAL:valoare


Recomandare: folosește CIF (TEXT:RO....)

BLOCK_ALL_ON_MISMATCH

0 → blochează doar fiscal
1 → blochează fiscal + nefiscal

Recomandare: lasă 0

6️⃣ Ce se întâmplă dacă sunt inversate

Dacă PRISCOM e conectată pe B și AUTODIMAS pe A:

Sistemul detectează automat

Fiscal se blochează pe device greșit

Nu se poate emite bon pe firma greșită

Rezolvare:
Modifici în .env doar porturile:

DEV_A_PORT=COM4
DEV_B_PORT=COM3


Restart CASE.

7️⃣ Test din tray

În tray există:

Test Priscom (A)

Test Autodimas (B)

Poți verifica rapid pe ce imprimantă iese testul.

8️⃣ Verificare rapidă status

Deschide:

http://127.0.0.1:9000/health


Vezi:

path (COM)

actual firmă detectată

expected

ok: true/false

🔒 Important

NU te baza niciodată doar pe COM.
Identificarea se face pe baza CIF / FM / Serial.