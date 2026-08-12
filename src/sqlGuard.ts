/**
 * sqlGuard.ts
 *
 * Validação PURA (sem I/O) para a tool de leitura livre do banco (run_sql_read).
 * Defesa em profundidade — combinada com transação READ ONLY + statement_timeout
 * no db.ts. Aqui garantimos: uma única instrução, só SELECT/WITH, sem comandos
 * de escrita/DDL, e sem tocar tabelas/colunas sensíveis (PII de clientes).
 */

// Comandos de escrita / DDL / DCL nunca permitidos.
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|vacuum|comment|lock|into)\b/i;

// Tabelas/colunas sensíveis: dados pessoais de clientes e segredos.
// O agente consulta isso pelas tools estruturadas (escopadas pelo telefone),
// nunca por SQL livre — evita vazamento de dados de OUTROS clientes.
const SENSITIVE =
  /(nextauth|"user"|aria_customer_profiles|aria_messages|aria_contact_consent|aria_session_checkpoints|aria_experience_reviews|password|passwd|token|secret|\bhash\b|api_key)/i;

/**
 * Valida e normaliza uma consulta de leitura. Lança Error com motivo claro se
 * não for segura. Retorna o SQL limpo (sem `;` final) pronto para executar.
 */
export function assertReadOnlySql(sql: string): string {
  const cleaned = (sql ?? "").trim().replace(/;+\s*$/g, "").trim();
  if (!cleaned) throw new Error("Consulta vazia.");
  if (cleaned.includes(";")) throw new Error("Apenas uma única instrução é permitida (sem ';').");
  if (!/^(select|with)\b/i.test(cleaned)) throw new Error("Apenas SELECT/WITH é permitido (somente leitura).");
  if (FORBIDDEN.test(cleaned)) throw new Error("Comando de escrita/DDL não permitido — somente leitura.");
  if (SENSITIVE.test(cleaned)) throw new Error("Consulta acessa dados sensíveis de clientes e foi bloqueada. Use as tools estruturadas para dados do próprio cliente.");
  return cleaned;
}
