/**
 * embeddings.ts — descoberta semântica + memória de longo prazo (opcional).
 *
 * Liga com EMBEDDINGS_ENABLED=true + OPENAI_API_KEY. Dois usos:
 *
 *  1. DESCOBERTA HÍBRIDA de restaurantes: "romântico com vista" encontra o
 *     restaurante certo mesmo sem essas palavras no about_text. O full-text
 *     (discoverRestaurants) continua rodando; os dois rankings são fundidos
 *     por Reciprocal Rank Fusion. Desligado/erro → só full-text (como antes).
 *
 *  2. MEMÓRIA SEMÂNTICA do cliente: cada resumo de sessão é indexado; no
 *     início da próxima conversa, os resumos mais RELEVANTES para a mensagem
 *     atual são recuperados — a Aria "lembra" de conversas de meses atrás
 *     mesmo depois que o campo notes do perfil atingiu o teto.
 *
 * Sem pgvector: vetores em tabela comum (JSONB) + similaridade de cosseno em
 * memória. Um catálogo curado (milhares de restaurantes) cabe com folga; a
 * troca por pgvector segue possível depois, interna a este módulo.
 */

import axios from "axios";
import crypto from "node:crypto";
import { config } from "./config.js";
import { pool, discoverRestaurants, type DiscoverRestaurantsInput } from "./db.js";

export function embeddingsEnabled(): boolean {
  return config.embeddings.enabled && Boolean(config.openaiKey);
}

// ─── Embedding API ───────────────────────────────────────────────────────────

async function embed(texts: string[]): Promise<Float32Array[] | null> {
  if (!embeddingsEnabled() || texts.length === 0) return null;
  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/embeddings",
      { model: config.embeddings.model, input: texts },
      {
        headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
        timeout: 30_000,
      },
    );
    const list = (data?.data ?? []) as Array<{ index: number; embedding: number[] }>;
    const out: Float32Array[] = new Array(texts.length);
    for (const item of list) out[item.index] = Float32Array.from(item.embedding);
    return out.every(Boolean) ? out : null;
  } catch (err) {
    console.warn("[embeddings] API falhou:", err instanceof Error ? err.message : err);
    return null;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function hash(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

// ─── Cache do catálogo em memória ────────────────────────────────────────────

type RestaurantVec = {
  restaurantId: string;
  name: string;
  city: string | null;
  country: string | null;
  urlPageTwk: string | null;
  slug: string | null;
  vec: Float32Array;
};

let _catalog: RestaurantVec[] = [];

/**
 * Sincroniza embeddings do catálogo: embeda restaurantes novos/alterados
 * (hash do conteúdo) em lotes e carrega tudo em memória. Roda no boot e a
 * cada 24h. Best-effort — nunca lança.
 */
export async function syncRestaurantEmbeddings(): Promise<void> {
  if (!embeddingsEnabled()) return;
  try {
    const { rows } = await pool.query(
      `SELECT r.restaurant_id, r.name, r.city, r.country, r.slug, r.url_page_twk,
              COALESCE(r.about_text, '') AS about_text,
              e.content_hash, e.embedding
         FROM public.db_restaurants r
         LEFT JOIN public.aria_restaurant_embeddings e ON e.restaurant_id = r.restaurant_id
        WHERE r.published = true`,
    );

    const toEmbed: Array<{ id: string; text: string; contentHash: string; row: Record<string, unknown> }> = [];
    const ready: RestaurantVec[] = [];

    for (const r of rows) {
      const text = [r.name, r.city, r.country, String(r.about_text).slice(0, 2000)]
        .filter(Boolean)
        .join(" · ");
      const contentHash = hash(text);
      if (r.embedding && r.content_hash === contentHash) {
        ready.push({
          restaurantId: String(r.restaurant_id),
          name: String(r.name),
          city: r.city ? String(r.city) : null,
          country: r.country ? String(r.country) : null,
          urlPageTwk: r.url_page_twk ? String(r.url_page_twk) : null,
          slug: r.slug ? String(r.slug) : null,
          vec: Float32Array.from(r.embedding as number[]),
        });
      } else {
        toEmbed.push({ id: String(r.restaurant_id), text, contentHash, row: r });
      }
    }

    // Embeda pendentes em lotes de 64.
    for (let i = 0; i < toEmbed.length; i += 64) {
      const batch = toEmbed.slice(i, i + 64);
      const vecs = await embed(batch.map((b) => b.text));
      if (!vecs) break; // API fora — tenta de novo na próxima sync
      for (let j = 0; j < batch.length; j++) {
        const b = batch[j];
        await pool.query(
          `INSERT INTO public.aria_restaurant_embeddings (restaurant_id, content_hash, embedding, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (restaurant_id)
           DO UPDATE SET content_hash = $2, embedding = $3::jsonb, updated_at = NOW()`,
          [b.id, b.contentHash, JSON.stringify(Array.from(vecs[j]))],
        );
        ready.push({
          restaurantId: b.id,
          name: String(b.row.name),
          city: b.row.city ? String(b.row.city) : null,
          country: b.row.country ? String(b.row.country) : null,
          urlPageTwk: b.row.url_page_twk ? String(b.row.url_page_twk) : null,
          slug: b.row.slug ? String(b.row.slug) : null,
          vec: vecs[j],
        });
      }
    }

    _catalog = ready;
    console.log(`[embeddings] catálogo sincronizado: ${ready.length} restaurantes indexados`);
  } catch (err) {
    console.warn("[embeddings] sync falhou:", err instanceof Error ? err.message : err);
  }
}

export function startEmbeddingsSync(): void {
  if (!embeddingsEnabled()) {
    console.log("[embeddings] desativado (EMBEDDINGS_ENABLED=false ou sem OPENAI_API_KEY)");
    return;
  }
  setTimeout(() => void syncRestaurantEmbeddings(), 25_000); // após migrations
  setInterval(() => void syncRestaurantEmbeddings(), 24 * 60 * 60_000).unref();
}

// ─── Descoberta híbrida (FTS + semântica, fusão por RRF) ────────────────────

const RRF_K = 60;

export async function hybridDiscover(input: DiscoverRestaurantsInput): Promise<unknown[]> {
  const ftsRows = (await discoverRestaurants(input)) as Array<Record<string, unknown>>;
  if (!embeddingsEnabled() || _catalog.length === 0) return ftsRows;

  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const vecs = await embed([input.query]);
  if (!vecs) return ftsRows;
  const qv = vecs[0];

  const cityF = (input.city ?? "").toLowerCase();
  const countryF = (input.country ?? "").toLowerCase();
  const semantic = _catalog
    .filter(
      (r) =>
        (!cityF || (r.city ?? "").toLowerCase().includes(cityF)) &&
        (!countryF || (r.country ?? "").toLowerCase().includes(countryF)),
    )
    .map((r) => ({ r, score: cosine(qv, r.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Reciprocal Rank Fusion dos dois rankings.
  const fused = new Map<string, number>();
  ftsRows.forEach((row, i) => {
    const id = String(row.restaurant_id);
    fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1));
  });
  semantic.forEach(({ r, score }, i) => {
    if (score < 0.2) return; // ruído — não polui o ranking
    fused.set(r.restaurantId, (fused.get(r.restaurantId) ?? 0) + 1 / (RRF_K + i + 1));
  });

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of ftsRows) byId.set(String(row.restaurant_id), row);
  for (const { r } of semantic) {
    if (!byId.has(r.restaurantId)) {
      byId.set(r.restaurantId, {
        restaurant_id: r.restaurantId,
        name: r.name,
        city: r.city,
        country: r.country,
        slug: r.slug,
        url_page_twk: r.urlPageTwk,
        match: "semantic",
      });
    }
  }

  return Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id))
    .filter(Boolean) as unknown[];
}

// ─── Memória semântica do cliente ────────────────────────────────────────────

/** Indexa um resumo de sessão para recuperação futura. Best-effort. */
export async function saveMemory(profileKey: string, note: string): Promise<void> {
  if (!embeddingsEnabled() || !profileKey || !note) return;
  try {
    const vecs = await embed([note.slice(0, 4000)]);
    if (!vecs) return;
    await pool.query(
      `INSERT INTO public.aria_memory_embeddings (profile_key, note, embedding)
       VALUES ($1, $2, $3::jsonb)`,
      [profileKey, note.slice(0, 4000), JSON.stringify(Array.from(vecs[0]))],
    );
  } catch (err) {
    console.warn("[embeddings] saveMemory falhou:", err instanceof Error ? err.message : err);
  }
}

/**
 * Memórias mais relevantes do cliente para a mensagem atual (top K acima de
 * um piso de similaridade). Vazio quando desligado/sem dados — nunca lança.
 */
export async function recallMemories(
  profileKey: string,
  queryText: string,
  topK = 3,
): Promise<string[]> {
  if (!embeddingsEnabled() || !profileKey || !queryText.trim()) return [];
  try {
    const { rows } = await pool.query(
      `SELECT note, embedding
         FROM public.aria_memory_embeddings
        WHERE profile_key = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [profileKey],
    );
    if (rows.length === 0) return [];
    const vecs = await embed([queryText.slice(0, 2000)]);
    if (!vecs) return [];
    const qv = vecs[0];
    return rows
      .map((r) => ({ note: String(r.note), score: cosine(qv, Float32Array.from(r.embedding as number[])) }))
      .filter((x) => x.score >= 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.note);
  } catch (err) {
    console.warn("[embeddings] recallMemories falhou:", err instanceof Error ? err.message : err);
    return [];
  }
}
