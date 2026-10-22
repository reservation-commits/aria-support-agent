/**
 * Valores de teste para as variáveis que `src/config.ts` exige no carregamento.
 *
 * Teste de função pura não pode depender de segredo de produção: em 05/10/2026 a pasta estava
 * sem `.env` e `deliveryStatus.test.ts` (que importa um módulo ligado ao banco) deixou de
 * carregar — a Porta de Qualidade ficou vermelha sem nenhuma regra ter quebrado. Importar este
 * arquivo ANTES do módulo testado resolve; nada aqui conecta a lugar nenhum (o pool do Postgres
 * só abre conexão na primeira consulta, e nenhum teste consulta).
 */
const TESTE: Record<string, string> = {
  ANTHROPIC_API_KEY: "teste-sem-valor",
  WHATSAPP_PHONE_NUMBER_ID: "0",
  WHATSAPP_ACCESS_TOKEN: "teste-sem-valor",
  WHATSAPP_VERIFY_TOKEN: "teste-sem-valor",
  PGHOST: "127.0.0.1",
  PGUSER: "teste",
  PGPASSWORD: "teste-sem-valor",
  PGDATABASE: "teste",
};
for (const [k, v] of Object.entries(TESTE)) process.env[k] ??= v;
