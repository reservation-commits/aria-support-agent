/**
 * Etiqueta da versão publicada. Trocada a cada release, junto com o zip de deploy.
 *
 * Existe por causa do deploy de 2026-09-11: publicamos a correção do incidente da nota
 * interna e não havia como conferir, de fora, se o que estava no ar era a versão nova ou a
 * antiga — `/health` respondia apenas `{ok:true}`. Uma correção que não se pode verificar
 * não está verificada.
 */
export const BUILD = "2026-09-30-v12-vigia-de-reservas-casa-no-whatsapp-sem-n8n";
