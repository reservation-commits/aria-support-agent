-- db/roles/aria_agent.sql
--
-- Role de MENOR PRIVILÉGIO para a Aria. NÃO é executado pela aplicação:
-- rode manualmente, uma vez, com um superusuário/owner do banco:
--
--     psql "$DATABASE_URL" -f db/roles/aria_agent.sql
--
-- Depois troque as credenciais do agente (.env) para este role:
--     PGUSER=aria_agent  PGPASSWORD=<a senha definida abaixo>
-- (ou ajuste DATABASE_URL). TROQUE A SENHA PLACEHOLDER antes de rodar.
--
-- Escopo concedido (e NADA mais):
--   * SELECT nas tabelas core que a Aria consulta:
--       public.reservations, public.db_restaurants, public.opening_hours,
--       nextauth."User"
--   * INSERT em public.update_events (audit log legado de escalação)
--   * ALL nas tabelas próprias public.aria_* (+ sequences), que são dela
--   * CREATE no schema public — necessário porque as migrations idempotentes
--     (src/dashboard/migrations.ts) criam/alteram as tabelas aria_* no boot.
--     Tabelas criadas pelo próprio role já nascem com ele como owner.
--
-- Sem superuser, sem CREATEDB/CREATEROLE, sem DELETE/UPDATE nas tabelas core.

BEGIN;

-- 1. Role de login (troque a senha!).
CREATE ROLE aria_agent LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- 2. Acesso aos schemas.
GRANT USAGE ON SCHEMA public TO aria_agent;
GRANT USAGE ON SCHEMA nextauth TO aria_agent;
-- Migrations da Aria criam as tabelas aria_* no boot.
GRANT CREATE ON SCHEMA public TO aria_agent;

-- 3. Leitura das tabelas core (somente SELECT).
GRANT SELECT ON public.reservations     TO aria_agent;
GRANT SELECT ON public.db_restaurants   TO aria_agent;
GRANT SELECT ON public.opening_hours    TO aria_agent;
-- Se quiser refinar, restrinja às colunas usadas pelo agente:
--   GRANT SELECT (id, name, email, phone, role) ON nextauth."User" TO aria_agent;
GRANT SELECT ON nextauth."User"         TO aria_agent;

-- 4. Audit log legado de escalação (apenas INSERT).
GRANT INSERT ON public.update_events TO aria_agent;

-- 5. Tabelas próprias da Aria (aria_*) já existentes + suas sequences.
--    (As criadas depois pelo próprio role nascem com ele como owner.)
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'aria\_%'
  LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO aria_agent', t.tablename);
  END LOOP;
  FOR t IN
    SELECT sequencename FROM pg_sequences
     WHERE schemaname = 'public' AND sequencename LIKE 'aria\_%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO aria_agent', t.sequencename);
  END LOOP;
END $$;

COMMIT;
