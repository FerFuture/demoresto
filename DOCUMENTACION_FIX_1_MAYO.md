# RestoBot — Documentación de cambios (1 de mayo de 2026)

> **Descarga rápida:** con este archivo abierto en Cursor, `Archivo → Guardar como…` (o copiá el contenido y pegalo en Word/Google Docs). Es texto plano: liviano y sin dependencias.

---

## 1. Control de costo de IA (puntos 6A, 6B, 6D, 6E)

### 1.A — max_tokens en cada llamada

- `generateAssistantResponse`: `max_tokens = 350` (configurable: `ASSISTANT_MAX_TOKENS`)
- `generateProductQuestionAnswer`: `max_tokens = 380`
- `generateOrderQuote`: `max_tokens = 400` + `response_format: json_object`
- `detectAddressIntent`: `max_tokens = 120` + `response_format: json_object`

**Archivo:** `ia_service.js`

### 1.B — Trimming de historial por caracteres

Función `trimHistoryByChars(history, { maxChars, minTurns })`: recorta turnos viejos al superar el tope de caracteres.

| Uso | maxChars | minTurns |
|-----|----------|----------|
| `generateAssistantResponse` | 6000 | 4 |
| `generateOrderQuote` | 6000 | 4 |
| `detectAddressIntent` | 400 | 1 |

Variables: `HISTORY_MAX_CHARS`, `HISTORY_MIN_TURNS`.

### 1.D — Cache de contexto del restaurante

`contextTextCache` (Map): evita rearmar el bloque menú + datos del restaurante en cada mensaje. TTL 5 min (`CONTEXT_CACHE_TTL_MS`). Firma incluye menú disponible y campos del restaurante.

Export: `invalidateContextCache(restaurantId)`.

### 1.E — Logs de tokens

```bash
docker logs -f restobot-whatsapp | grep ai-tokens
```

---

## 2. Costos en USD en los logs

Precios por defecto (gpt-4o-mini + whisper-1, mayo 2025). Ajustables por `.env`:

```env
AI_PRICE_INPUT_PER_M=0.15
AI_PRICE_OUTPUT_PER_M=0.6
AI_WHISPER_PRICE_PER_MIN=0.006
```

Ejemplo de líneas:

```
[ai-tokens] generateAssistantResponse in=2939 out=17 total=2956 cost=$0.000451 day=$0.001234
[ai-tokens] whisperTranscribe seconds=8.5 cost=$0.000850 day=$0.002118
[ai-tokens-day] 2026-04-30 ... chat=$0.0279 whisper=$0.0034 cost=$0.0313
```

---

## 3. Configuración del restaurante en el dashboard (punto 7)

**SQL:** `dashboard/sql/restaurants_config_columns.sql` — columnas `public_name`, `address`, `delivery_zones` + políticas RLS UPDATE.

**Backend:** `database.js` (`getRestaurantContext` trae los nuevos campos). `ia_service.js` (`buildRestaurantContextText` sin hardcoded; usa DB).

**Dashboard:** `dashboard/src/screens/AdminApp.jsx` — pestaña **Configuración**.

---

## 4. Paginación + filtros + realtime (punto 8)

- Página de 30 pedidos; `range()` + `count: exact`
- Filtros: estado, pago, modalidad, fechas, búsqueda
- Realtime que respeta filtros; banner de actualizaciones ocultas + “Recargar lista”
- `OrdersFilterBar`, `applyOrderFilters`, `orderMatchesFilters`, `loadMoreOrders`

---

## 5. Optimización `detectAddressIntent` (4 capas)

1. **Pre-filtro:** `looksLikeAddressCandidate` (descarta saludos cortos, solo dígitos, etc.)
2. **Guard sesión:** `shouldRunAddressDetection` (local → nunca; dirección ya cargada → nunca)
3. **Historial corto** en el detector (400 chars / 1 turno)
4. **Cache LRU** por texto del mensaje (cap 200)

| Métrica | Antes | Ahora |
|---------|--------|--------|
| Calls | 1 por cada mensaje | ~1 cada ~5 si justifica |
| Tokens IN por call | ~535 | ~120–180 |
| Reducción estimada | — | ~80% |

---

## 6. Saludos sin IA

- `isPureGreeting(text)` + `buildGreetingReply(restaurantContext)` en `index.js`
- Usa `resolvePublicBrandName` / `resolveBotDisplayName` (`ia_service.js`)
- `metadata.quickReply = 'greeting'` en `bot_interactions`

---

## 7. Variables de entorno (resumen)

| Variable | Default |
|----------|---------|
| `ASSISTANT_MAX_TOKENS` | 350 |
| `HISTORY_MAX_CHARS` | 6000 |
| `HISTORY_MIN_TURNS` | 4 |
| `CONTEXT_CACHE_TTL_MS` | 300000 |
| `AI_PRICE_INPUT_PER_M` | 0.15 |
| `AI_PRICE_OUTPUT_PER_M` | 0.6 |
| `AI_WHISPER_PRICE_PER_MIN` | 0.006 |

---

## 8. Pasos manuales

1. Supabase: `orders_payment_paid_at.sql`, luego `restaurants_config_columns.sql` (si faltan).
2. `docker compose down && docker compose up -d --build`
3. Dashboard → Configuración → completar marca, dirección, horario, zonas.

---

## 9. Archivos tocados

| Archivo | Rol |
|---------|-----|
| `ia_service.js` | Tokens, USD, cache, detectAddress, exports |
| `index.js` | Guards, saludos |
| `database.js` | Contexto restaurante |
| `dashboard/src/screens/AdminApp.jsx` | Config, pedidos paginados |
| `dashboard/sql/*.sql` | Migraciones |

---

## 10. Pendiente (no hecho hoy)

- Resumen rolling de conversaciones (punto 6C)
- Backup `.wwebjs_auth/` automatizado
- Reconexión WhatsApp robusta (código)
- Quick replies extra (horario, ubicación, gracias)

---

## Apéndice — Diagnóstico original (logs)

```
[ai-tokens] detectAddressIntent in=535 ...
[ai-tokens] generateAssistantResponse in=2939 ...
... (varias detectAddress de más) ...
```

Motivó los guards y el recorte del detector.
