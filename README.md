# GridFix: Distribution Roguelike

Dispečerska slagalica niskonaponske (NN) mreže. Igrač dobije mrežu s 1–3
kvara (podnapon, preopterećen vod, preopterećena trafostanica, loš faktor
snage) i mora ih otkloniti unutar budžeta i broja dopuštenih intervencija.

Vanilla HTML/CSS/JS, ES moduli, SVG shema, `localStorage`. Bez servera,
logina, reklama, frameworka ili build koraka.

## Pokretanje

**Preglednici blokiraju ES module (`<script type="module">`) preko
`file://` protokola** (CORS). Dvoklik na `index.html` zato neće raditi u
Chromeu/Edgeu — ovo je ograničenje samog preglednika, ne aplikacije.
Pokrenite lokalni server:

```bash
cd gridfix
python3 -m http.server 8080
# ili: npx serve .
```

pa otvorite `http://localhost:8080`. Ili postavite mapu direktno na
GitHub Pages / Cloudflare Pages (HTTP servira module bez problema).

## Testovi

```bash
npm test
```

45 testova, sve preko Node-ovog ugrađenog test runnera (nema vanjskih
dev-ovisnosti za sam pogon igre — `npm test` ne instalira ništa).

- `tests/topology.test.js` — stablo, grananje, detekcija ciklusa/odvojenih čvorova
- `tests/load-flow.test.js` — struja/pad napona/gubici po specificiranim formulama, rubni slučajevi (cosφ, duljina 0, prazan izvod)
- `tests/interventions.test.js` — svih 6 intervencija, zaštita od petlje, budžeta, broja poteza
- `tests/generator.test.js` — determinizam po seedu, 120 kombinacija seed×težina, svaki generirani kvar provjeren protiv **stvarnog** load-flow motora (ne samo pretpostavljen)
- `tests/storage.test.js` — export/import round-trip, oštećen JSON, XSS payload kao inertni tekst
- `tests/integration.test.js` — pobjeda na zadnjem potezu (ne poraz), poraz kad ponestane poteza, blokirana akcija se ne bilježi u povijest

## Arhitektura

```
js/
├── constants.js       jedini izvor pragova/troškova/limita
├── rng.js              mulberry32 — seedani, determinirani PRNG
├── state.js             tvornica gameState + pub-sub store
├── validation.js       shema za sve što dolazi izvana (import/localStorage)
├── storage.js            localStorage wrapper, sve try/catch
├── engine/             čisti JS, bez DOM-a — testabilno u Node-u
│   ├── topology.js        stablo mreže: parent/child, subtree, ciklusi
│   ├── load-flow.js        P/Q/S/I/ΔU/gubici, iz specifikacije
│   ├── interventions.js   6 akcija: validate → clone → mutate → recalculate
│   ├── scoring.js           bodovanje + uvjeti pobjede/poraza
│   └── scenario-generator.js  seed → mreža + 1-3 kvara, verificirano protiv load-flow.js
└── ui/                  DOM sloj — samo textContent, nikad innerHTML
    ├── renderer-svg.js     jednopolna shema
    ├── inspector.js, action-panel.js, dialogs.js, notifications.js
```

`gameState` je jedini izvor istine; UI ne računa ništa elektrotehničko —
samo čita `calculated`. Svaka intervencija ide kroz identičan put:
validate → clone → mutate → recalculate → provjeri pobjedu/poraz → zapiši
u povijest → renderiraj. Sve u centima (integer), nikad float za novac.

## Poštena procjena stanja — što JEST i što NIJE potvrđeno

Ovo nije standardni "sve radi" zaključak. Evo točno što je i nije
provjereno, i zašto.

**Potvrđeno stvarnim izvršavanjem (ne samo čitanjem koda):**
- Cijeli engine (topologija, load-flow, intervencije, generator, storage)
  — 45 testova, pokrenuto, sve prolazi. Uključuje namjerno teške slučajeve:
  cosφ > 1, cosφ ≈ 0, duljina voda 0, vrlo dugačak vod, prazan izvod,
  grananje s dva pod-izvoda, pokušaj petlje, iscrpljen budžet, pobjeda na
  doslovno zadnjem dopuštenom potezu.
- Tijekom pisanja testova pronađena su i ispravljena **4 stvarna bug-a**
  prije nego što je ijedan test prošao: pogrešan lookup ključa u
  `ACTION_COSTS` (sve akcije su prijavljivale `undefined.flat` grešku),
  `effectiveCosPhi()` je tiho maskirao neispravan ulazni cosφ pa se
  data-error alarm nikad nije pojavio, redoslijed ubacivanja kvarova u
  generatoru je mogao poništiti skaliranje trafostanice, i uvoz
  spremljene runde je pogrešno računao proteklo vrijeme koristeći
  zastarjeli timestamp. Ovo nije popis da zvuči temeljito — ovo je stvarna
  povijest onoga što je bilo krivo dok se nije testiralo.

**NIJE potvrđeno stvarnim izvršavanjem u pregledniku:**
- Cijeli `js/ui/*` sloj i `app.js` — DOM manipulacija, SVG renderiranje,
  klik/tipkovnica interakcija, animacije, responsive layout. Pokušao sam
  headless provjeru (jsdom pa Playwright/Chromium) — oboje blokirano:
  jsdom uopće ne izvršava `<script type="module">` (poznato, dugogodišnje
  ograničenje), a Playwright treba preuzeti Chromium binarku s domene koja
  nije na dopuštenoj listi za odlazni promet u ovom okruženju. Nisam
  glumio da to "radi" — jednostavno nisam mogao stvarno provjeriti.
  Statička provjera je odrađena (sintaksa svake datoteke, svaki `import`
  razriješen do stvarnog `export`-a, svaki DOM `id` korišten u `app.js`
  postoji u `index.html`) i ručni pregled koda je prošao nekoliko krugova
  — ali statička provjera i ručni pregled kôda nisu isto što i stvarno
  kliknuti kroz igru u Chromeu.
- **Ti moraš odraditi ručni QA prije nego ovo nazoveš gotovim**: Chrome,
  Edge, Firefox; 360px/768px/desktop; tipkovnica bez miša; tamni/svijetli
  prikaz; 50 uzastopnih rundi bez rušenja. Ovo je popis iz same
  specifikacije — nije dekorativan, i ja ga ne mogu odraditi umjesto tebe
  u ovom okruženju.

## Namjerna pojednostavljenja i odstupanja od specifikacije

- **Reaktancija (X) = 0** — eksplicitno navedeno u specifikaciji kao
  dopušteno za MVP, i jasno označeno u UI-u ("Pojednostavljena simulacija:
  reaktancija nije uključena.").
- **Jedan potrošač po čvoru** — generator ne stvara više potrošača na
  istom čvoru. Engine to podržava (load-flow i topology rade nad
  proizvoljnim brojem tereta po čvoru), ali generator to ne iskorištava.
  Ako zatrebaš gušće čvorove, to je izmjena samo u
  `scenario-generator.js`, ne u engineu.
- **"Prebaci potrošač" premješta cijeli čvor**, ne pojedinačni teret —
  ako čvor ima podstablo, premješta se cijelo podstablo. Ovo je čitanje
  specifikacije koje smatram ispravnim ("Prebacuje čvor na drugi
  raspoloživi izvod"), ali je vrijedno da to znaš eksplicitno.
- **Trošak zamjene kabela** računa se iz razlike cijene po km između
  starog i novog tipa, ograničeno na raspon iz `constants.js` — cjenik je
  izmišljen (nema stvarnih HEP podataka, što je i eksplicitno zabranjeno
  za MVP), pa apsolutni iznosi nemaju stvarno značenje, samo relativni
  odnos "jači kabel = skuplje".
- **Testovi cross-browser/tipkovnica/responsive nisu automatizirani** —
  vidi sekciju iznad. Playwright je instaliran lokalno kao alat
  (`node_modules` je namjerno obrisan iz isporuke jer nije dio same igre)
  ali binarka preglednika nije mogla biti preuzeta u ovom okruženju.

## Ono što bih dalje radio da ovo ide u produkciju

Ovo nije opcionalan "nice to have" popis — ovo je stvarni prioritet ako
netko stvarno igra ovo:

1. **Ručni QA popis iz specifikacije, odrađen u stvarnom Chromeu/Firefoxu/Edgeu.** Ovo je jedini blokirajući korak prije nego se ovo može zvati gotovim, ne kozmetika.
2. CI koji pokreće `npm test` na svaki push (GitHub Actions — trivijalno, `node --test tests/`).
3. Playwright test suite (kad je binarka preglednika dostupna) koji pokriva barem: novu igru → jedna intervencija → pobjeda/poraz, tipkovnicu bez miša kroz cijelu shemu, i uvoz namjerno oštećene datoteke.
4. Vizualna provjera SVG sheme na stvarno velikoj mreži (težina "Projektant", 3 izvoda × 5 čvorova s grananjem) — geometrija/preklapanje oznaka nije ručno provjerena za taj rubni slučaj gustoće.
