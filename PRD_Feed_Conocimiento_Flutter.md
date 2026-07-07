# Documento Técnico — App de Feed de Conocimiento (Flutter)

**Versión:** 1.1
**Fecha:** 2026-06-26
**Autor:** Julián D. Gómez Ríos
**Destino:** Especificación de implementación para agente de código.

---

## 1. Resumen

App móvil (iOS/Android) tipo feed vertical scrolleable (estilo Reels/TikTok), donde cada elemento es una **tarjeta de conocimiento**: un resumen corto de un artículo web, **artículo científico**, **capítulo de libro**, podcast o concepto de ciencia/filosofía/tecnología. El usuario hace scroll, da like / guarda, gestiona las **fuentes** (RSS) que alimentan el feed, y puede **añadir contenido manualmente** (capítulos de libro, papers, texto suelto) desde una sección de Biblioteca.

Características clave:

- **Sin autenticación.** Un solo usuario. Todos los datos en SQLite local.
- **Dos caminos de ingesta.** (a) Automático vía RSS, incluyendo feeds científicos (arXiv, PubMed). (b) Manual vía Biblioteca, para libros y contenido sin feed.
- **Resumen delegado a n8n.** La app no contiene lógica de LLM. Llama a un webhook de n8n cuya URL es **editable desde la app**.
- **Citas APA fiables.** Para papers y libros, la cita se construye con metadatos reales (Crossref / arXiv / ISBN), nunca generada por el LLM. Ver §6.1.
- **Funciona offline.** Las tarjetas guardadas/likeadas permanecen disponibles sin red.
- **Limpieza diaria.** Una tarea de fin de día elimina las tarjetas del feed que NO fueron guardadas ni likeadas. El contenido curado manualmente nace **protegido** y no se purga. El feed es transitorio; biblioteca y favoritos son permanentes.
- **Diseño moderno** (ver §9).

---

## 2. Arquitectura

```
┌─────────────────────── App Flutter ───────────────────────┐
│                                                            │
│  RSS (leído por la app) ──► URLs de artículos              │
│         │                                                  │
│         ▼                                                  │
│   filtrar nuevas (dedupe por hash en SQLite)               │
│         │                                                  │
│         ▼                                                  │
│   trocear en lotes de 6                                    │
│         │                                                  │
│         ▼                                                  │
│   POST batch ──────────────────────────►  n8n webhook      │
│                                            (extrae + resume)│
│         ◄──────────────────────────────  { cards, failed } │
│         │                                                  │
│         ▼                                                  │
│   insertar en SQLite (Drift)                               │
│         │                                                  │
│         ▼                                                  │
│   Feed = stream reactivo sobre SQLite ──► PageView         │
│                                                            │
│   Tarea diaria: borra tarjetas sin like/save               │
└────────────────────────────────────────────────────────────┘
```

La app lee el RSS y hace el dedupe local. n8n solo recibe URLs ya filtradas, extrae el texto del artículo, lo resume con un LLM y devuelve JSON estructurado. El feed siempre se renderiza desde SQLite, nunca directo de la red.

---

## 3. Stack técnico

| Capa | Tecnología | Notas |
|------|-----------|-------|
| Lenguaje | Dart / Flutter (estable) | — |
| Estado | Riverpod | `flutter_riverpod` |
| BD local | Drift (sobre SQLite) | Queries tipadas + streams reactivos |
| RSS | `webfeed_revised` o `dart_rss` | Solo para extraer URLs de artículos |
| HTTP | `http` o `dio` | Llamada al webhook |
| Ajustes | `shared_preferences` | URL del webhook |
| Background | `workmanager` | Tarea de limpieza diaria |
| Hash | `crypto` | SHA-1 de URL para dedupe |
| Utilidades | `collection` | `.slices()` para lotes |

---

## 4. Modelo de datos (Drift)

```dart
import 'package:drift/drift.dart';

class Sources extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get type => text()();                    // rss | scientific (feeds: arXiv, PubMed)
  TextColumn get url => text().unique()();            // URL del feed RSS/Atom
  TextColumn get title => text().nullable()();
  TextColumn get categoryHint => text().nullable()(); // se pasa al webhook
  BoolColumn get active => boolean().withDefault(const Constant(true))();
  DateTimeColumn get lastFetched => dateTime().nullable()();
}

class Cards extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get sourceId => integer().nullable().references(Sources, #id)();
  TextColumn get contentHash => text().unique()();    // dedupe (ver nota)
  TextColumn get originalUrl => text().nullable()();   // ahora nullable (libros no tienen URL)
  TextColumn get title => text()();
  TextColumn get summary => text()();
  TextColumn get category => text()();                // ciencia|filosofia|tecnologia|web|podcast
  TextColumn get sourceType => text()();              // rss | scientific | book | manual
  TextColumn get citation => text().nullable()();     // cita APA construida con metadatos
  TextColumn get citationSource => text().nullable()(); // crossref | arxiv | isbn | user | null
  BoolColumn get protected => boolean().withDefault(const Constant(false))(); // excluye de purga
  IntColumn get estReadMin => integer().withDefault(const Constant(2))();
  DateTimeColumn get publishedAt => dateTime().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
}

class Interactions extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get cardId => integer().references(Cards, #id)();
  TextColumn get type => text()();                    // like | save | skip
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
}
```

Notas de diseño:

- `contentHash` con `unique()` es la pieza central del dedupe. Para contenido con URL es el hash de la URL del **artículo**; para contenido manual sin URL (capítulos de libro, texto pegado) es el hash de `título + primeros caracteres del texto`. Así nada se duplica, tenga URL o no.
- `originalUrl` es **nullable**: un capítulo de libro puede no tener URL. En papers, suele ser el DOI (`https://doi.org/...`).
- `sourceType` (`rss | scientific | book | manual`) indica **cómo** se ingirió y cómo renderizar la tarjeta. Es independiente de `category` (la categoría visible: ciencia/filosofía/tech).
- `citation` guarda la cita APA ya formateada; `citationSource` indica su procedencia y por tanto cuánto fiarse: `crossref`/`arxiv`/`isbn` = construida con metadatos reales (fiable); `user` = la escribiste tú; `null` = sin cita (contenido web normal).
- `protected = true` excluye la tarjeta de la limpieza diaria. El contenido añadido manualmente (libro, manual) nace protegido. Ver §12.
- No hay `user_id` (un solo usuario). No hay tabla `items` intermedia.
- `interactions` con `type` en `{like, save, skip}` define qué se conserva del feed. `like` y `save` protegen la tarjeta de la limpieza diaria; `skip` no.

### Helper de hash

```dart
import 'dart:convert';
import 'package:crypto/crypto.dart';

// Para contenido con URL
String hashUrl(String url) =>
    sha1.convert(utf8.encode(url.trim())).toString();

// Para contenido manual sin URL (libro / texto pegado)
String hashContent(String title, String text) =>
    sha1.convert(utf8.encode('${title.trim()}|${text.trim().substring(0,
        text.length < 200 ? text.length : 200)}')).toString();
```

---

## 5. Servicio de ingesta

Corre al abrir la app y con pull-to-refresh. Hay **dos caminos** que terminan en el mismo `summarizeBatch`:

```
CAMINO A — RSS (automático):
1. Leer RSS de todas las fuentes activas → lista de URLs de artículos.
   (fuentes científicas: el item del feed trae DOI o arXiv ID → se pasan al webhook)
2. filterNew(urls) → descartar las que ya existen en SQLite (por contentHash).
3. Trocear las nuevas en lotes de 6.
4. Por cada lote (en SECUENCIA): summarizeBatch(lote) → insertCards(cards).
5. Actualizar lastFetched en cada fuente procesada.

CAMINO B — Biblioteca (manual, ver §6.2):
1. El usuario añade un capítulo/paper/texto desde la pantalla Biblioteca.
2. Se arma un item con rawText (o doi/arxivId/isbn) y se llama summarizeBatch([item]).
3. insertCards(cards, protected: true) → nace protegido, no entra en la purga.
```

### Dedupe — filtrar nuevas

```dart
Future<List<String>> filterNew(List<String> urls) async {
  final hashes = urls.map(hashUrl).toList();
  final existing = await (select(cards)
        ..where((c) => c.contentHash.isIn(hashes)))
      .map((c) => c.contentHash)
      .get();
  final existingSet = existing.toSet();
  return urls.where((u) => !existingSet.contains(hashUrl(u))).toList();
}
```

### Inserción de un lote

```dart
Future<void> insertCards(List<CardData> incoming,
    {int? sourceId, bool protected = false}) async {
  await batch((b) {
    b.insertAll(
      cards,
      incoming.map((c) => CardsCompanion.insert(
            sourceId: Value(sourceId),
            // URL si existe; si no (libro/manual), hash de título+texto
            contentHash: c.originalUrl != null
                ? hashUrl(c.originalUrl!)
                : hashContent(c.title, c.summary),
            originalUrl: Value(c.originalUrl),
            title: c.title,
            summary: c.summary,
            category: c.category,
            sourceType: c.sourceType,
            citation: Value(c.citation),
            citationSource: Value(c.citationSource),
            protected: Value(protected),
            estReadMin: Value(c.estReadMin),
            publishedAt: Value(c.publishedAt),
          )),
      mode: InsertMode.insertOrIgnore,   // contentHash repetido se ignora solo
    );
  });
}
```

`insertOrIgnore` es la red de seguridad: aunque dos lotes traigan el mismo contenido, nunca se duplica.

### Loop de lotes

```dart
import 'package:collection/collection.dart';

Future<void> ingest(List<String> newUrls,
    {int? sourceId, String sourceType = 'rss', String? categoryHint}) async {
  for (final batch in newUrls.slices(6)) {
    try {
      final res = await summarizer.summarizeUrls(batch,
          sourceType: sourceType, categoryHint: categoryHint);
      await db.insertCards(res.cards, sourceId: sourceId); // feed: no protegido
    } catch (_) {
      // El lote falló entero: se reintenta en el próximo refresh.
      // No se aborta el resto de lotes.
    }
  }
}
```

---

## 6. Contrato del webhook (App ↔ n8n)

La URL del webhook es **configurable desde la app** (ver §10). El contrato es batch con resultados parciales. Un `item` puede traer **URL** (RSS/web), **identificadores académicos** (doi/arxivId/isbn) y/o **texto directo** (rawText). El webhook resuelve cada caso.

### Request (App → n8n)

```jsonc
POST {webhook_url}
Content-Type: application/json

{
  "items": [
    // Web / RSS normal
    { "url": "https://...", "sourceType": "rss", "category_hint": "tecnologia" },

    // Paper con DOI → cita por Crossref, resumen sobre abstract
    { "doi": "10.1038/s41586-023-...", "sourceType": "scientific", "category_hint": "ciencia" },

    // Paper de arXiv → cita + abstract por la API de arXiv
    { "arxivId": "2402.01234", "sourceType": "scientific" },

    // Capítulo de libro → texto que aporta el usuario + cita por ISBN
    { "rawText": "texto del capítulo...", "title": "Cap. 3 — Anclajes",
      "isbn": "9780374533557", "chapterTitle": "Anchors", "pages": "119-128",
      "sourceType": "book", "category_hint": "filosofia" },

    // Texto suelto sin metadatos
    { "rawText": "...", "title": "Nota sobre...", "sourceType": "manual" }
  ]
}
```

Campos del item (todos opcionales salvo `sourceType`): `url`, `rawText`, `title`, `doi`, `arxivId`, `isbn`, `chapterTitle`, `pages`, `category_hint`.

### Response (n8n → App)

Siempre el mismo shape. Cada card incluye ahora `citation`, `citationSource` y `sourceType`:

```jsonc
{
  "ok": true,
  "cards": [
    {
      "title": "...",
      "summary": "Resumen de 3-5 frases...",
      "category": "ciencia",          // ciencia|filosofia|tecnologia|web|podcast
      "estReadMin": 2,
      "originalUrl": "https://doi.org/...",   // o null (libro sin URL)
      "citation": "Doe, J. A., & Ruiz, C. (2023). Title. Journal, 6(4), 412-420. https://doi.org/...",
      "citationSource": "crossref",   // crossref|arxiv|isbn|user|null
      "sourceType": "scientific",
      "publishedAt": "2026-06-20T00:00:00Z"
    }
  ],
  "failed": [
    { "url": "https://...", "error": "no se pudo extraer el contenido" }
  ]
}
```

En error global:

```jsonc
{ "ok": false, "error": "mensaje", "cards": [], "failed": [] }
```

### Cliente HTTP en la app

El cliente acepta items genéricos (mapas), no solo URLs, para cubrir los dos caminos:

```dart
class SummarizeResult {
  final List<CardData> cards;
  final List<Map<String, dynamic>> failed;
  SummarizeResult(this.cards, this.failed);
}

class SummarizerClient {
  final Settings settings;
  final http.Client client;
  SummarizerClient(this.settings, this.client);

  // items: cada uno es un mapa con url/rawText/doi/arxivId/isbn/... + sourceType
  Future<SummarizeResult> summarizeBatch(List<Map<String, dynamic>> items) async {
    final hook = settings.webhookUrl;
    if (hook == null || hook.isEmpty) {
      throw StateError('Webhook no configurado');
    }
    final res = await client
        .post(Uri.parse(hook),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({'items': items}))
        .timeout(const Duration(seconds: 90)); // lotes acotados, espera generosa

    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (body['ok'] != true) {
      throw Exception(body['error'] ?? 'Error desconocido del webhook');
    }
    final cards = (body['cards'] as List)
        .map((e) => CardData.fromJson(e as Map<String, dynamic>))
        .toList();
    final failed = (body['failed'] as List? ?? [])
        .cast<Map<String, dynamic>>();
    return SummarizeResult(cards, failed);
  }

  // Helper para el camino RSS (solo URLs)
  Future<SummarizeResult> summarizeUrls(List<String> urls,
          {String sourceType = 'rss', String? categoryHint}) =>
      summarizeBatch(urls
          .map((u) => {
                'url': u,
                'sourceType': sourceType,
                if (categoryHint != null) 'category_hint': categoryHint,
              })
          .toList());
}
```

**Tamaño de lote: 6** (rango aceptable 5–8). Mantiene cada petición por debajo de ~90 s incluso si el LLM está frío.

---

## 6.1. Citas APA (responsabilidad del webhook, no del LLM)

Punto crítico de diseño: **la cita nunca la genera el LLM.** Los modelos inventan autores, años, páginas y DOIs con total confianza. El resumen del *contenido* sí sale del LLM (es texto generativo), pero la **cita** se construye de forma determinista a partir de metadatos reales:

| Entrada | Fuente de metadatos | Resultado |
|---------|--------------------|-----------|
| `doi` | Crossref (`api.crossref.org/works/{doi}`) | Cita APA + abstract como texto a resumir |
| `arxivId` | arXiv API (`export.arxiv.org/api/query`) | Cita APA de preprint + abstract |
| `isbn` | Google Books (`googleapis.com/books/v1`) | Cita APA del libro; el usuario añade capítulo y páginas |
| solo `url` | — | Sin cita APA; se conserva `originalUrl` |

`citationSource` registra la procedencia. Si los metadatos no se pudieron resolver, `citation` queda `null` y la tarjeta cae al `originalUrl` normal. En la app, una cita con `citationSource != 'user'` debe ser **editable** por si el usuario quiere afinarla (sobre todo en libros, donde el capítulo lo pone él).

El system prompt del LLM incluye explícitamente la regla *"NO generes ni inventes citas, autores, años ni DOIs"* para evitar que el modelo intente competir con este camino.

## 6.2. Sección Biblioteca (ingesta manual)

Para contenido sin feed (capítulos de libro, papers sueltos, texto). Pantalla con un formulario que arma un item y llama a `summarizeBatch([item])`:

- **Capítulo de libro:** campo de texto largo (pegar el extracto que se quiera resumir, de una copia a la que tengas acceso legítimo), `title`, `isbn` opcional (autocompleta la cita), `chapterTitle`, `pages`.
- **Paper:** `doi` o `arxivId` (con eso basta; n8n trae cita + abstract), o `url`.
- **Texto suelto:** solo `rawText` + `title`.

Las tarjetas creadas por este camino se insertan con `protected: true` (no se purgan). Para el texto largo, la app puede extraer el contenido de un PDF/EPUB **localmente** (paquetes Flutter, ver §16) y enviar solo `rawText` — así n8n nunca maneja binarios.

> **Derechos:** el modelo guarda un **resumen propio** + cita/enlace, nunca el texto completo. Para papers, se prefiere el abstract (acceso libre). Para libros, el extracto lo aporta el usuario desde una copia legítima. Diseñado así, equivale a cualquier herramienta de resúmenes.

---

## 7. Workflow n8n (referencia)

El workflow real se entrega como archivo importable: **`n8n_feed_conocimiento_summarize_batch.json`**. Esta sección documenta su estructura.

```
Webhook (POST { items: [...] })
   → Has Items?  (IF)
        false → Respond Empty  ({ ok:false, ... })
        true  → Config (Set: llmUrl, llmModel, maxChars)
              → Split Items (Code: array → N ítems normalizados)
              → Prepare (Code, runOnceForAllItems):
                    • resuelve metadatos → cita APA determinista:
                        doi → Crossref · arxivId → arXiv · isbn → Google Books
                    • obtiene el texto a resumir:
                        rawText → directo · scientific → abstract de la API ·
                        url → fetch + strip de HTML
                    • arma el body del LLM (system general o científico)
              → Summarize (LLM)  (HTTP Request, OpenAI-compatible,
                                  concurrencia 2, continue-on-error)
              → Build Cards (Code: parsea JSON, valida, adjunta
                             citation/citationSource/sourceType → { ok, cards, failed })
              → Respond Success
```

**Diferencias clave frente a la v1:**

- El antiguo *Fetch Page* + *Extract Text* se consolidan en el nodo **Prepare**, que hace toda la E/S (fetch, abstracts, metadatos) usando `this.helpers.httpRequest` dentro del Code node. Esto permite las ramas condicionales (rawText vs url vs abstract) sin un laberinto de nodos visuales con merges.
- Las **citas se construyen con metadatos reales**, separadas del resumen del LLM (ver §6.1).
- Para papers se resume el **abstract**, no el PDF: más limpio, más barato y sin problemas de derechos. n8n nunca maneja binarios PDF.

**Requisito del entorno n8n:** el nodo Prepare usa `this.helpers.httpRequest`, disponible en el Code node de n8n estándar. Si tu instancia tiene restringido el HTTP desde Code nodes, habría que mover esas llamadas a nodos HTTP Request visuales.

**Editable en un solo lugar:** todo lo configurable (URL del LLM, modelo, `maxChars`) vive en el nodo **Config**. La concurrencia del LLM está en el nodo *Summarize* (batching, por defecto 2) para no saturar Qwen.

---

## 8. El feed (lectura reactiva)

El feed siempre lee de SQLite mediante un stream. Insertar tras un lote refresca la UI automáticamente.

```dart
// Feed activo: todo lo que esté en la tabla cards (transitorio + permanente)
Stream<List<Card>> watchFeed() =>
    (select(cards)..orderBy([(c) => OrderingTerm.desc(c.createdAt)]))
        .watch();

// Guardados: solo tarjetas con interaction like o save (lo que sobrevive offline)
Stream<List<Card>> watchSaved() {
  final query = select(cards).join([
    innerJoin(interactions, interactions.cardId.equalsExp(cards.id)),
  ])..where(interactions.type.isIn(['like', 'save']));
  return query.watch().map((rows) =>
      rows.map((r) => r.readTable(cards)).toSet().toList());
}
```

En la UI, el feed es un `PageView` vertical (`scrollDirection: Axis.vertical`).

### Lista de sesión vs. stream

Para el feed activo conviene **no** alimentar el `PageView` directamente del stream ordenado, porque al insertar tarjetas nuevas (con `createdAt` mayor) éstas saltarían al inicio y desplazarían los índices mientras el usuario hace scroll. En su lugar:

- El `FeedController` (Notifier de Riverpod) mantiene una **lista append-only** durante la sesión.
- Carga inicial: lee de SQLite las tarjetas del feed actual.
- Las tarjetas nuevas que llegan por prefetch se **añaden al final** de esa lista, preservando la posición de scroll.
- La vista **Guardados** sí usa stream reactivo (`watchSaved()`), porque ahí el reordenamiento no molesta.

```dart
// Carga inicial del feed: tarjetas actuales en SQLite
Future<List<Card>> loadFeed() =>
    (select(cards)..orderBy([(c) => OrderingTerm.desc(c.createdAt)])).get();

// Guardados (stream reactivo, sobrevive offline)
Stream<List<Card>> watchSaved() {
  final query = select(cards).join([
    innerJoin(interactions, interactions.cardId.equalsExp(cards.id)),
  ])..where(interactions.type.isIn(['like', 'save']));
  return query.watch().map((rows) =>
      rows.map((r) => r.readTable(cards)).toSet().toList());
}
```

---

## 8.1. Prefetch (scroll continuo)

Requisito: cuando el usuario esté a **3 tarjetas del final** del feed actual, disparar el request a n8n para traer tarjetas nuevas y que el scroll no se corte.

### Lógica del disparador

En `onPageChanged` del `PageView`, comparar el índice actual contra el largo de la lista:

```dart
class FeedController extends Notifier<FeedState> {
  static const _prefetchThreshold = 3;   // tarjetas antes del final

  @override
  FeedState build() => FeedState.initial();

  Future<void> init() async {
    final cards = await ref.read(dbProvider).loadFeed();
    state = state.copyWith(cards: cards);
  }

  void onPageChanged(int index) {
    state = state.copyWith(currentIndex: index);
    final remaining = state.cards.length - 1 - index;
    if (remaining <= _prefetchThreshold) {
      _prefetch();   // a 3 (o menos) del final
    }
  }

  Future<void> _prefetch() async {
    // GUARD: no disparar si ya hay una ingesta en curso
    if (state.isLoading) return;
    // COOLDOWN: si el último intento no trajo nada, esperar antes de reintentar
    if (state.exhaustedUntil != null &&
        DateTime.now().isBefore(state.exhaustedUntil!)) return;

    state = state.copyWith(isLoading: true);
    try {
      final before = state.cards.length;
      await ref.read(ingestServiceProvider).refresh(); // RSS → webhook → SQLite

      // Traer solo las tarjetas que aún no están en la lista de sesión
      final existingHashes =
          state.cards.map((c) => c.contentHash).toSet();
      final all = await ref.read(dbProvider).loadFeed();
      final fresh =
          all.where((c) => !existingHashes.contains(c.contentHash)).toList();

      if (fresh.isEmpty) {
        // El RSS no tenía contenido nuevo: marcar cooldown para no
        // martillar el webhook en cada cambio de página.
        state = state.copyWith(
          isLoading: false,
          exhaustedUntil: DateTime.now().add(const Duration(minutes: 10)),
        );
      } else {
        // Append al final, preservando posición de scroll
        state = state.copyWith(
          cards: [...state.cards, ...fresh],
          isLoading: false,
          exhaustedUntil: null,
        );
      }
    } catch (_) {
      // Sin red u otro error: liberar el guard, reintento en el próximo umbral
      state = state.copyWith(isLoading: false);
    }
  }
}
```

### Los dos mecanismos de protección

1. **Guard `isLoading`.** Sin esto, cada cambio de página dentro de la zona de umbral (las últimas 3) dispararía un request nuevo, encolando varias ingestas simultáneas contra el webhook. El guard asegura **una sola ingesta a la vez**.

2. **Cooldown `exhaustedUntil`.** Punto importante de honestidad técnica: **el RSS no genera contenido infinito bajo demanda.** Un feed RSS expone solo sus N items recientes. Si el usuario llega al final y las fuentes no han publicado nada nuevo desde la última lectura, el prefetch devolverá cero tarjetas. Sin cooldown, la app golpearía el webhook en cada swipe del final sin obtener nada. El cooldown (ej. 10 min) evita ese martilleo y permite reintentar más tarde, cuando las fuentes quizá ya publicaron.

### Comportamiento esperado para el usuario

- **Hay contenido nuevo** (las fuentes publicaron): las tarjetas se añaden al final y el scroll continúa sin interrupción.
- **No hay contenido nuevo**: se llega a un final de feed real. Mostrar un estado discreto ("Estás al día — desliza para refrescar") en lugar de un spinner infinito. Pull-to-refresh manual sigue disponible.
- **Sin red**: el prefetch falla silenciosamente; el usuario navega lo que ya tiene en SQLite (modo offline normal).

### Nota sobre profundidad del feed

Si más adelante quieres un feed verdaderamente "infinito", el RSS por sí solo no basta (no soporta paginación hacia el archivo histórico). Opciones de evolución: añadir más fuentes para ampliar el caudal diario, o que n8n consulte archivos/APIs paginadas de las fuentes que lo permitan. Para el piloto, el prefetch que mantiene el feed al día con lo recién publicado es suficiente.

---

## 9. Diseño (moderno)

Dirección estética concreta para el agente. Objetivo: que se sienta editorial y premium, no un lector RSS genérico.

### Principios

- **Dark-first**, con opción de tema claro. Fondo casi-negro (`#0E0E10`), no negro puro.
- **Tarjeta a pantalla completa** en el feed (estilo Reels), una tarjeta por "página" vertical, con transición suave al hacer swipe.
- **Tipografía con jerarquía fuerte.** Título grande y serif o grotesca de carácter (ej. una display font); cuerpo del resumen en sans legible con buen interlineado (1.5). Type scale: título ~28-32, resumen ~17-18, metadatos ~13.
- **Color por categoría.** Cada categoría tiene un acento. Sugerencia:
  - ciencia → cian/teal
  - filosofía → ámbar/dorado
  - tecnología → violeta
  - web → azul
  - podcast → rosa/coral
  El acento se usa en un chip de categoría y un detalle sutil (borde, barra), no en fondos saturados.
- **Espaciado generoso.** Padding amplio (24-32 px), aire alrededor del texto. El protagonista es el resumen.
- **Microinteracciones.** Botón de like/guardar con animación breve (escala + relleno). Haptic feedback ligero al guardar.

### Anatomía de la tarjeta del feed

```
┌──────────────────────────────────┐
│  [chip categoría]   2 min lectura │   ← metadatos arriba, acento de color
│                                   │
│  Título grande de la tarjeta      │   ← display font
│                                   │
│  Resumen de 3-5 frases que se     │   ← cuerpo, interlineado 1.5
│  lee cómodo y autocontenido...    │
│                                   │
│  ── cita / fuente ──              │   ← según sourceType (ver abajo)
│                                   │
│  ♡ guardar      ↗ original / DOI  │   ← acciones abajo
└──────────────────────────────────┘
```

**Variantes según `sourceType`:**

- `rss` / `web`: pie con el nombre de la fuente; acción "leer original" abre `originalUrl`.
- `scientific`: el pie muestra la **cita APA** (`citation`) en tipografía monoespaciada pequeña; la acción abre el DOI. Un ícono ⬡ discreto marca que es un paper.
- `book`: el pie muestra la **cita APA del libro + capítulo**; no hay "leer original" (puede no haber URL). Ícono de libro.
- `manual`: pie con la cita si existe, o nada. Ícono de nota.

La cita debe poder **copiarse** con un toque largo (útil para quien escribe). Si `citationSource` es construida por metadatos, mostrarla tal cual; si el usuario la editó, marcarla como propia.

### Pantallas

1. **Feed** — `PageView` vertical, tarjeta a pantalla completa, pull-to-refresh dispara ingesta.
2. **Guardados** — grid o lista de tarjetas con like/save. Es la vista que funciona offline.
3. **Biblioteca** — entrada manual (§6.2): añadir capítulo de libro, paper (DOI/arXiv) o texto suelto. Lista del contenido curado (todo `protected`). Permite editar la cita APA.
4. **Fuentes** — lista de fuentes con toggle activo/inactivo, botón de añadir (URL del feed + tipo `rss|scientific` + category_hint opcional), swipe para eliminar.
5. **Ajustes** — campo editable de la URL del webhook + botón "Probar conexión", selector de tema, y disparador manual de la limpieza (para pruebas).

> Si se usa el agente de código con la skill de diseño frontend, aplicar tokens de diseño consistentes (escala de espaciado, paleta, tipografía) en lugar de valores hardcodeados dispersos.

---

## 10. URL del webhook editable

Persistir con `shared_preferences`, separado de la BD de contenido.

```dart
class Settings {
  static const _key = 'n8n_webhook_url';
  final SharedPreferences _prefs;
  Settings(this._prefs);

  String? get webhookUrl => _prefs.getString(_key);
  Future<void> setWebhookUrl(String url) => _prefs.setString(_key, url);
}
```

En la pantalla de Ajustes:

- `TextField` con la URL actual (ej. apuntando a `n8n.juliangomez.me`).
- Botón **"Probar conexión"**: envía un payload de ejemplo (`{ "items": [{ "url": "https://example.com" }] }`) y muestra si la respuesta tiene el shape esperado (`ok`, `cards`, `failed`). Esto evita depurar a ciegas al cambiar de túnel o ruta.

---

## 11. Comportamiento offline

Requisito: la app debe mostrar offline las tarjetas guardadas/likeadas previamente.

Como toda la lectura del feed sale de SQLite, **el modo offline es el estado natural**, no una capa aparte:

- **Con red:** pull-to-refresh ingiere nuevas tarjetas vía webhook.
- **Sin red:** el feed muestra lo que ya esté en SQLite; la ingesta simplemente no corre (se detecta el fallo de red y se muestra un aviso discreto, sin bloquear la UI).
- **Vista Guardados:** siempre disponible offline, ya que `watchSaved()` lee local.

Detección de conectividad: paquete `connectivity_plus` para mostrar el estado, pero **no** como bloqueo — la app siempre renderiza lo local primero.

---

## 12. Tarea de limpieza diaria

Requisito: al final del día, eliminar las tarjetas del feed que NO fueron guardadas ni likeadas. **Nunca** se borran las tarjetas con `protected = true` (contenido curado en Biblioteca).

### Lógica de borrado

```dart
// Borra tarjetas SIN like/save Y que no estén protegidas.
// Sobreviven: like, save, o protected (Biblioteca).
Future<int> purgeUnsavedCards() async {
  final protectedIds = await (selectOnly(interactions)
        ..addColumns([interactions.cardId])
        ..where(interactions.type.isIn(['like', 'save'])))
      .map((r) => r.read(interactions.cardId)!)
      .get();

  final query = delete(cards)
    ..where((c) {
      final base = c.protected.equals(false);   // nunca borra lo protegido
      return protectedIds.isEmpty
          ? base
          : base & c.id.isNotIn(protectedIds);   // ni lo likeado/guardado
    });
  return query.go();
}
```

### Programación

`workmanager` con una tarea periódica diaria.

```dart
// callback dispatcher (top-level)
@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((task, _) async {
    final db = AppDatabase();        // abrir BD en el isolate de background
    await db.purgeUnsavedCards();
    await db.close();
    return true;
  });
}

// registro (en main, tras init)
Workmanager().registerPeriodicTask(
  'daily-purge',
  'purgeUnsavedCards',
  frequency: const Duration(hours: 24),
  initialDelay: _untilNextMidnight(), // calcular para que caiga a fin de día
);
```

### Importante — fallback en arranque

iOS **no garantiza** el horario exacto de las tareas en background; Android es más fiable pero tampoco exacto. Por eso, además de `workmanager`, ejecutar un **chequeo en el arranque de la app**: si la última limpieza fue antes de hoy, correr `purgeUnsavedCards()` al abrir. Esto garantiza que el feed transitorio se limpie aunque el SO no haya disparado la tarea programada.

```dart
Future<void> purgeIfDue(Settings settings) async {
  final last = settings.lastPurgeDate;        // guardar en prefs
  final today = DateTime.now();
  if (last == null || !_sameDay(last, today)) {
    await db.purgeUnsavedCards();
    await settings.setLastPurgeDate(today);
  }
}
```

El resultado: cada día el feed arranca limpio con solo tarjetas frescas, mientras que likes y guardados permanecen indefinidamente para consulta offline.

---

## 13. Estructura del proyecto

```
lib/
  main.dart
  core/
    theme/              // tokens de diseño, tema claro/oscuro
    router.dart
    connectivity.dart
  data/
    database.dart       // Drift: tablas, DAOs, queries del feed + purga
    settings.dart       // shared_preferences (URL webhook, lastPurgeDate)
    summarizer_client.dart
    ingest_service.dart
    rss_reader.dart     // lee RSS → URLs (+ DOI/arXiv ID si el feed los trae)
    models/
      card_data.dart    // CardData.fromJson/toJson (incl. citation, sourceType)
  features/
    feed/               // PageView vertical, FeedController (lista append-only
                        //   + prefetch a 3 del final), CardWidget, providers
    saved/              // tarjetas like/save (vista offline)
    library/            // ingesta manual: capítulo de libro, paper, texto;
                        //   nacen protected; edición de cita APA
    sources/            // CRUD de fuentes (rss | scientific), toggle activo
    settings/           // URL webhook + probar conexión + tema
  background/
    purge_task.dart     // workmanager callback + purgeIfDue (respeta protected)
```

---

## 14. Fases de implementación

**Fase 1 — Esqueleto + feed.** Drift con las 3 tablas, tema moderno, `PageView` del feed leyendo datos sembrados a mano. Validar scroll y diseño de tarjeta.

**Fase 2 — Ingesta + scroll continuo.** `rss_reader` + `summarizer_client` + `ingest_service`. `FeedController` con lista append-only y prefetch a 3 tarjetas del final (guard + cooldown). Pantalla de Ajustes con URL editable y "Probar conexión". Pantalla de Fuentes. Ciclo completo RSS → dedupe → lotes → webhook → SQLite → feed.

**Fase 3 — Interacciones + offline.** Like/guardar/skip, vista Guardados, manejo de conectividad. Confirmar que la app funciona offline mostrando lo guardado.

**Fase 4 — Limpieza diaria.** `workmanager` + fallback en arranque (respetando `protected`). Botón manual de purga en Ajustes para pruebas.

**Fase 5 — Académico + Biblioteca.** Fuentes científicas RSS (arXiv/PubMed) que pasan DOI/arXiv ID al webhook. Pantalla Biblioteca para ingesta manual (capítulo de libro, paper, texto). Render de la cita APA en la tarjeta con copia al toque. Edición de cita.

**Fase 6 (opcional) — Multimedia y afinidad.** Podcasts (transcripción en n8n con Whisper), thumbnails, extracción local de PDF/EPUB para Biblioteca, y ordenar el feed por afinidad con embeddings locales (`sqlite-vec`) sobre las tarjetas guardadas.

---

## 15. Decisiones cerradas (resumen)

| Decisión | Elección |
|----------|----------|
| Autenticación | Ninguna, un solo usuario |
| Almacenamiento | SQLite local (Drift) |
| Tipos de contenido | Web/RSS, científico (DOI/arXiv), capítulo de libro (ISBN), podcast, manual |
| Ingesta | Dos caminos: RSS automático + Biblioteca manual (mismo webhook) |
| Citas | APA construida con metadatos reales (Crossref/arXiv/ISBN), nunca por el LLM |
| Resumen | Webhook n8n, URL editable en la app |
| Contrato | Batch con resultados parciales (`cards` / `failed`); item acepta url/rawText/doi/arxivId/isbn |
| Tamaño de lote | 6 (rango 5–8), disparados en secuencia |
| Lectura RSS | En la app (obtiene URLs y, si existen, DOI/arXiv ID) |
| Dedupe | Hash SHA-1 de URL, o de título+texto si no hay URL; `unique()` + `insertOrIgnore` |
| Feed | Lista append-only de sesión (FeedController) → `PageView` vertical; Guardados usa stream reactivo |
| Prefetch | A 3 tarjetas del final dispara ingesta; guard `isLoading` + cooldown si no hay contenido nuevo |
| Offline | Natural (lectura siempre local); Guardados y Biblioteca siempre disponibles |
| Limpieza | Diaria vía workmanager + fallback en arranque; borra tarjetas sin like/save y sin `protected` |
| Contenido curado | Biblioteca nace `protected = true`; nunca se purga |
| Diseño | Dark-first, editorial, color por categoría, tarjeta a pantalla completa, cita según tipo |

---

## 16. Dependencias (pubspec)

```yaml
dependencies:
  flutter_riverpod: ^2.5.0
  drift: ^2.18.0
  sqlite3_flutter_libs: ^0.5.0
  path_provider: ^2.1.0
  path: ^1.9.0
  http: ^1.2.0
  shared_preferences: ^2.2.0
  webfeed_revised: ^0.7.0      # o dart_rss
  crypto: ^3.0.0
  collection: ^1.18.0
  workmanager: ^0.5.2
  connectivity_plus: ^6.0.0
  url_launcher: ^6.3.0          # abrir el original / DOI

  # Biblioteca (ingesta manual) — opcionales según alcance:
  file_picker: ^8.0.0          # elegir PDF/EPUB local (Fase 6)
  read_pdf_text: ^0.3.1        # extraer texto de PDF on-device → rawText
  # (para EPUB: epubx o similar; o pedir al usuario que pegue el texto)

dev_dependencies:
  drift_dev: ^2.18.0
  build_runner: ^2.4.0
```

*(Verificar las versiones más recientes al implementar. `file_picker`, `read_pdf_text` y el soporte EPUB solo son necesarios si se implementa la subida de archivos; el camino mínimo de Biblioteca es pegar texto, sin dependencias extra.)*
